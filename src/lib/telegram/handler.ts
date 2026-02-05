/**
 * Telegram Message Handler
 * Shared logic for processing Telegram updates (used by both webhook and polling)
 */
import { TelegramBot, TelegramUpdate, TelegramCallbackQuery, InlineKeyboardMarkup } from './bot';
import { OrchestratorAgent } from '@/lib/agent/orchestrator';
import * as db from '@/lib/db';
import { ChatSession, Message } from '@/lib/types';
import { generateId } from '@/lib/utils/id';

// Store conversation history per chat
const chatHistories = new Map<number, { role: 'user' | 'assistant'; content: string }[]>();

// Store selected chat per Telegram user - key is Telegram chat ID, value is selected app chat ID
const selectedChats = new Map<number, string | null>();

// Get status emoji
function getStatusEmoji(status: string): string {
    switch (status) {
        case 'running':
        case 'waiting_response':
            return '🔄';
        case 'completed':
            return '✅';
        case 'error':
            return '❌';
        default:
            return '💬';
    }
}

// Settings getter - will be injected
let getSettingsFn: () => { workdir: string } = () => ({ workdir: process.cwd() });

export function setSettingsGetter(fn: () => { workdir: string }) {
    getSettingsFn = fn;
}

/**
 * Process a Telegram update
 */
export async function handleTelegramUpdate(bot: TelegramBot, update: TelegramUpdate): Promise<void> {
    // Handle callback query (button press)
    if (update.callback_query) {
        await handleCallbackQuery(bot, update.callback_query);
        return;
    }

    // Handle message updates
    if (update.message?.text) {
        const { message } = update;
        const chatId = message.chat.id;
        const text = message.text!.trim();
        const username = message.from.username || message.from.first_name;

        // Check if chat is allowed
        if (!bot.isAllowedChat(chatId)) {
            console.log(`[Telegram] Unauthorized chat: ${chatId}`);
            await bot.sendMessage(chatId, '❌ Unauthorized. This bot is not available for this chat.');
            return;
        }

        console.log(`[Telegram] Message from ${username} (${chatId}): ${text}`);

        // Handle commands
        if (text.startsWith('/')) {
            await handleCommand(bot, chatId, text, message.message_id);
            return;
        }

        // Check if user has selected a specific chat
        const selectedChatId = selectedChats.get(chatId);
        
        if (selectedChatId) {
            // Send message to selected chat (continue conversation in that context)
            await handleSelectedChatMessage(bot, chatId, selectedChatId, text, message.message_id);
            return;
        }

        // Send typing indicator
        await bot.sendTyping(chatId);

        // Process with Orchestrator Agent (main agent mode)
        try {
            const workdir = getSettingsFn().workdir;
            const agent = new OrchestratorAgent();

            // Use shared session ID so messages appear in Web Orchestrator panel too
            const sessionId = 'web_orchestrator_main';
            
            // Check if session exists, create if not
            console.log(`[Telegram] Checking for session: ${sessionId}`);
            let session = db.getSession(sessionId);
            if (!session) {
                console.log(`[Telegram] Session not found, creating new one`);
                session = {
                    id: sessionId,
                    title: 'Orchestrator',
                    status: 'running',
                    messages: [],
                    createdAt: new Date(),
                    isOrchestratorManaged: true,
                    source: 'telegram',
                };
                db.createSession(session);
                console.log(`[Telegram] Session created: ${sessionId}`);
            } else {
                console.log(`[Telegram] Session exists, updating status to running`);
                // Update status to running
                db.updateSession({ id: sessionId, status: 'running' });
            }

            // Save user message (mark as from Telegram)
            const userMessage: Message = {
                id: generateId(),
                role: 'user',
                content: `[Telegram] ${text}`,
                timestamp: new Date(),
                metadata: { source: 'user' },
            };
            console.log(`[Telegram] Saving user message to session ${sessionId}: ${text.substring(0, 50)}...`);
            db.addMessage(sessionId, userMessage);
            console.log(`[Telegram] User message saved`);

            let responseText = '';
            const createdChats: { id: string; title: string }[] = [];
            
            // Track which chats we've sent updates for
            const sentChatUpdates = new Map<string, number>(); // chatId -> last message count

            // Run orchestrator with progress callback
            const result = await agent.run(text, workdir, async (event) => {
                if (event.type === 'message') {
                    responseText += event.content || '';
                } else if (event.type === 'chat_created') {
                    // Parse chat info
                    try {
                        const chatInfo = JSON.parse(event.content || '{}');
                        createdChats.push({ id: chatInfo.chatId, title: chatInfo.title });
                        
                        // Send notification about new task
                        await bot.sendMessage(chatId, 
                            `🚀 *Task Created*\n\n📋 ${chatInfo.title}\n🆔 ${chatInfo.chatId}`,
                            { parseMode: 'Markdown' }
                        );
                        sentChatUpdates.set(chatInfo.chatId, 0);
                    } catch (e) {
                        // Ignore parse errors
                    }
                } else if (event.type === 'chat_update' && event.chatId) {
                    // Send sub-agent conversation updates
                    try {
                        const updateData = JSON.parse(event.content || '{}');
                        
                        if (updateData.type === 'cursor_response' && updateData.content) {
                            // Cursor's response - send full content, will be split if too long
                            await bot.sendLongMessage(chatId,
                                `🤖 *Cursor Response*\n\n${updateData.content}`,
                            );
                        } else if (updateData.type === 'ai_followup' && updateData.content) {
                            // Agent Manager's follow-up
                            await bot.sendLongMessage(chatId,
                                `💬 *Agent Manager*\n\n${updateData.content}`,
                            );
                        } else if (updateData.type === 'state_detected' && updateData.content) {
                            // State detection - usually short, no need for long message
                            await bot.sendMessage(chatId,
                                `📊 ${updateData.content}`,
                            );
                        }
                    } catch (e) {
                        // Ignore parse errors
                    }
                } else if (event.type === 'chat_complete' && event.chatId) {
                    // Task completed
                    try {
                        const completeData = JSON.parse(event.content || '{}');
                        const statusEmoji = completeData.success ? '✅' : '❌';
                        await bot.sendMessage(chatId,
                            `${statusEmoji} *Task Complete*\n\n🆔 ${event.chatId}\n🔄 Turns: ${completeData.turns || 'N/A'}`,
                            { parseMode: 'Markdown' }
                        );
                    } catch (e) {
                        // Ignore parse errors
                    }
                }
                
                // Keep sending typing indicator
                await bot.sendTyping(chatId);
            });

            // Build final response
            let finalResponse = '';
            
            console.log(`[Telegram] Orchestrator finished. responseText length: ${responseText.length}, createdChats: ${createdChats.length}, success: ${result.success}`);
            
            if (responseText) {
                finalResponse = responseText;
            }

            if (result.success) {
                if (createdChats.length > 0) {
                    finalResponse += `\n\n✅ Completed ${createdChats.length} task(s)`;
                }
            } else {
                finalResponse += `\n\n❌ Error: ${result.error || 'Unknown error'}`;
            }

            if (!finalResponse.trim()) {
                finalResponse = '✅ All tasks processed successfully.';
            }

            console.log(`[Telegram] Final response to send: ${finalResponse.substring(0, 200)}...`);

            // Save assistant response to database
            const assistantMessage: Message = {
                id: generateId(),
                role: 'assistant',
                content: finalResponse,
                timestamp: new Date(),
                metadata: { source: 'orchestrator' },
            };
            db.addMessage(sessionId, assistantMessage);

            // Update session status
            db.updateSession({ 
                id: sessionId,
                status: result.success ? 'completed' : 'error' 
            });

            // Send final response to Telegram
            const sendResult = await bot.sendLongMessage(chatId, finalResponse, {
                replyToMessageId: message.message_id,
            });
            console.log(`[Telegram] Message sent result: ${sendResult}`);

        } catch (error) {
            console.error('[Telegram] Error processing message:', error);
            await bot.sendMessage(chatId, `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`, {
                replyToMessageId: message.message_id,
            });
        }
    }
}

async function handleCommand(
    bot: TelegramBot,
    chatId: number,
    text: string,
    messageId: number
) {
    const [command, ...args] = text.split(' ');

    switch (command.toLowerCase()) {
        case '/start':
            await bot.sendMessage(chatId, 
`🤖 *Cursor Auto Pilot Bot*

Welcome! I'm connected to the AI Orchestrator.

*How to use:*
• Send me any development task
• I'll break it down and coordinate execution
• You'll receive progress updates

*Commands:*
/help - Show this help
/status - Check system status
/chats - List and select chats
/back - Return to main agent
/clear - Clear conversation history

*Example tasks:*
• "Create a new React component for user profile"
• "Add authentication to the API"
• "Refactor the database queries"
`, { parseMode: 'Markdown', replyToMessageId: messageId });
            break;

        case '/help':
            await bot.sendMessage(chatId,
`📚 *Help*

Send me a development task and I'll:
1. Analyze and break it down
2. Create sub-tasks for Cursor Agent
3. Monitor progress and coordinate execution

*Chat Selection:*
• /chats - Browse and select a chat
• /back - Return to main agent mode
• When a chat is selected, messages go to that chat

*Tips:*
• Be specific about what you want
• Include file paths if relevant
• Mention frameworks/libraries to use

*Commands:*
/start - Welcome message
/status - System status
/chats - List and select chats
/back - Return to main agent
/clear - Clear history
`, { parseMode: 'Markdown', replyToMessageId: messageId });
            break;

        case '/status': {
            // Get sessions directly from database (more accurate than memory cache)
            const allSessions = db.getAllSessions();
            // Filter same as web UI: exclude isOrchestratorManaged (Telegram main sessions)
            const chats = allSessions.filter(s => !s.isOrchestratorManaged);
            const running = chats.filter(c => c.status === 'running' || c.status === 'waiting_response').length;
            const completed = chats.filter(c => c.status === 'completed').length;
            const idle = chats.filter(c => c.status === 'idle').length;
            const error = chats.filter(c => c.status === 'error').length;
            
            // Show current mode
            const selectedChatId = selectedChats.get(chatId);
            let modeText = '🤖 Mode: Main Agent';
            if (selectedChatId) {
                const selectedSession = db.getSession(selectedChatId);
                modeText = `💬 Mode: Chat "${selectedSession?.title || selectedChatId}"`;
            }
            
            await bot.sendMessage(chatId,
`📊 System Status

🟢 Bot: Online
${modeText}

📋 Total Chats: ${chats.length}
💬 Idle: ${idle}
🔄 Running: ${running}
✅ Completed: ${completed}
❌ Error: ${error}
`, { replyToMessageId: messageId });
            break;
        }

        case '/chats':
            await handleChatsCommand(bot, chatId, messageId, 0);
            break;

        case '/back':
            selectedChats.delete(chatId);
            await bot.sendMessage(chatId, 
`🤖 *Switched to Main Agent*

You are now talking to the main Orchestrator Agent.
Send any task and I'll coordinate its execution.

Use /chats to select a specific chat again.
`, { parseMode: 'Markdown', replyToMessageId: messageId });
            break;

        case '/select': {
            const selectChatId = args.join(' ').trim();
            if (!selectChatId) {
                await bot.sendMessage(chatId, '❌ Please provide a chat ID.\n\nUsage: /select <chat_id>\n\nOr use /chats to browse available chats.', {
                    replyToMessageId: messageId,
                });
                break;
            }
            
            const session = db.getSession(selectChatId);
            if (!session) {
                await bot.sendMessage(chatId, `❌ Chat not found: ${selectChatId}`, {
                    replyToMessageId: messageId,
                });
                break;
            }
            
            selectedChats.set(chatId, selectChatId);
            await bot.sendMessage(chatId,
`💬 *Selected Chat*

📋 *${session.title}*
🆔 ${session.id}
${getStatusEmoji(session.status)} Status: ${session.status}

Your messages will now be sent to this chat.
Use /back to return to the main agent.
`, { parseMode: 'Markdown', replyToMessageId: messageId });
            break;
        }

        case '/clear':
            chatHistories.delete(chatId);
            await bot.sendMessage(chatId, '🗑️ Conversation history cleared.', {
                replyToMessageId: messageId,
            });
            break;

        default:
            await bot.sendMessage(chatId, `❓ Unknown command: ${command}\n\nUse /help for available commands.`, {
                replyToMessageId: messageId,
            });
    }
}

// Handle /chats command - show paginated list of chats
async function handleChatsCommand(
    bot: TelegramBot,
    telegramChatId: number,
    messageId: number,
    page: number
) {
    const PAGE_SIZE = 5;
    const allChats = db.getAllSessions()
        .filter(s => !s.isOrchestratorManaged) // Only show sub-task chats, not main orchestrator sessions
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    
    const totalPages = Math.ceil(allChats.length / PAGE_SIZE);
    const currentPage = Math.max(0, Math.min(page, totalPages - 1));
    const chats = allChats.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
    
    if (allChats.length === 0) {
        await bot.sendMessage(telegramChatId, 
`📋 *No Chats Available*

No chat sessions found. Send a task to the main agent to create one.
`, { parseMode: 'Markdown' });
        return;
    }

    // Build chat list with inline buttons
    let messageText = `📋 *Available Chats* (${currentPage + 1}/${totalPages})\n\n`;
    
    const buttons: InlineKeyboardMarkup['inline_keyboard'] = [];
    
    for (const chat of chats) {
        const statusEmoji = getStatusEmoji(chat.status);
        const title = chat.title.length > 30 ? chat.title.substring(0, 27) + '...' : chat.title;
        messageText += `${statusEmoji} *${title}*\n`;
        messageText += `   ID: \`${chat.id}\`\n\n`;
        
        // Add select button for each chat
        buttons.push([{
            text: `${statusEmoji} ${title}`,
            callback_data: `select:${chat.id}`,
        }]);
    }
    
    // Add navigation buttons
    const navButtons: InlineKeyboardMarkup['inline_keyboard'][0] = [];
    if (currentPage > 0) {
        navButtons.push({ text: '⬅️ Prev', callback_data: `page:${currentPage - 1}` });
    }
    navButtons.push({ text: '🤖 Main Agent', callback_data: 'back' });
    if (currentPage < totalPages - 1) {
        navButtons.push({ text: 'Next ➡️', callback_data: `page:${currentPage + 1}` });
    }
    buttons.push(navButtons);
    
    // Add refresh button
    buttons.push([{ text: '🔄 Refresh', callback_data: `page:${currentPage}` }]);
    
    await bot.sendMessage(telegramChatId, messageText, {
        parseMode: 'Markdown',
        replyMarkup: { inline_keyboard: buttons },
    });
}

// Handle callback query (button press)
async function handleCallbackQuery(
    bot: TelegramBot,
    query: TelegramCallbackQuery
) {
    if (!query.data) {
        return;
    }

    const telegramChatId = query.message?.chat.id;
    const messageId = query.message?.message_id;
    
    if (!telegramChatId) {
        await bot.answerCallbackQuery(query.id, { text: 'Error: No chat ID' });
        return;
    }

    const [action, value] = query.data.split(':');

    switch (action) {
        case 'select': {
            const session = db.getSession(value);
            if (!session) {
                await bot.answerCallbackQuery(query.id, { text: 'Chat not found', showAlert: true });
                return;
            }
            
            selectedChats.set(telegramChatId, value);
            await bot.answerCallbackQuery(query.id, { text: `Selected: ${session.title}` });
            
            // Update the message to show selected chat info
            if (messageId) {
                const lastMessages = session.messages.slice(-3);
                let recentMsgs = '';
                if (lastMessages.length > 0) {
                    recentMsgs = '\nRecent messages:\n';
                    for (const msg of lastMessages) {
                        const roleEmoji = msg.role === 'user' ? '👤' : msg.role === 'assistant' ? '🤖' : '⚙️';
                        // Escape special characters for Markdown
                        const content = msg.content
                            .substring(0, 100)
                            .replace(/[_*`\[\]()~>#+=|{}.!-]/g, '\\$&');
                        recentMsgs += `${roleEmoji} ${content}${msg.content.length > 100 ? '...' : ''}\n\n`;
                    }
                }
                
                // Escape title for Markdown
                const safeTitle = session.title.replace(/[_*`\[\]()~>#+=|{}.!-]/g, '\\$&');
                
                const editText = `💬 Selected Chat

📋 ${safeTitle}
🆔 ${session.id}
${getStatusEmoji(session.status)} Status: ${session.status}
${recentMsgs}
Your messages will now be sent to this chat.
Type your message or use the buttons below.`;

                await bot.editMessageText(telegramChatId, messageId, editText, {
                    replyMarkup: {
                        inline_keyboard: [
                            [{ text: '🔄 Refresh', callback_data: `refresh:${value}` }],
                            [{ text: '🤖 Back to Main Agent', callback_data: 'back' }],
                            [{ text: '📋 Browse Chats', callback_data: 'page:0' }],
                        ],
                    },
                });
            }
            break;
        }
        
        case 'refresh': {
            const session = db.getSession(value);
            if (!session) {
                await bot.answerCallbackQuery(query.id, { text: 'Chat not found', showAlert: true });
                return;
            }
            
            await bot.answerCallbackQuery(query.id, { text: 'Refreshed!' });
            
            if (messageId) {
                const lastMessages = session.messages.slice(-3);
                let recentMsgs = '';
                if (lastMessages.length > 0) {
                    recentMsgs = '\n*Recent messages:*\n';
                    for (const msg of lastMessages) {
                        const roleEmoji = msg.role === 'user' ? '👤' : msg.role === 'assistant' ? '🤖' : '⚙️';
                        const content = msg.content.length > 100 ? msg.content.substring(0, 97) + '...' : msg.content;
                        recentMsgs += `${roleEmoji} ${content}\n\n`;
                    }
                }
                
                await bot.editMessageText(telegramChatId, messageId,
`💬 *Selected Chat*

📋 *${session.title}*
🆔 \`${session.id}\`
${getStatusEmoji(session.status)} Status: ${session.status}
${recentMsgs}
Your messages will now be sent to this chat.
Type your message or use the buttons below.
`, {
                    parseMode: 'Markdown',
                    replyMarkup: {
                        inline_keyboard: [
                            [{ text: '🔄 Refresh', callback_data: `refresh:${value}` }],
                            [{ text: '🤖 Back to Main Agent', callback_data: 'back' }],
                            [{ text: '📋 Browse Chats', callback_data: 'page:0' }],
                        ],
                    },
                });
            }
            break;
        }
        
        case 'page': {
            const page = parseInt(value, 10) || 0;
            await bot.answerCallbackQuery(query.id);
            
            // Delete old message and send new one with updated list
            if (messageId) {
                await handleChatsCommand(bot, telegramChatId, messageId, page);
            }
            break;
        }
        
        case 'back': {
            selectedChats.delete(telegramChatId);
            await bot.answerCallbackQuery(query.id, { text: 'Switched to Main Agent' });
            
            if (messageId) {
                await bot.editMessageText(telegramChatId, messageId,
`🤖 *Main Agent Mode*

You are now talking to the main Orchestrator Agent.
Send any task and I'll coordinate its execution.
`, {
                    parseMode: 'Markdown',
                    replyMarkup: {
                        inline_keyboard: [
                            [{ text: '📋 Browse Chats', callback_data: 'page:0' }],
                        ],
                    },
                });
            }
            break;
        }
        
        default:
            await bot.answerCallbackQuery(query.id, { text: 'Unknown action' });
    }
}

// Handle message when a chat is selected
async function handleSelectedChatMessage(
    bot: TelegramBot,
    telegramChatId: number,
    selectedChatId: string,
    text: string,
    messageId: number
) {
    // Get the selected session
    const session = db.getSession(selectedChatId);
    if (!session) {
        selectedChats.delete(telegramChatId);
        await bot.sendMessage(telegramChatId, 
`❌ Selected chat no longer exists. Returning to main agent.`, 
            { replyToMessageId: messageId }
        );
        return;
    }

    await bot.sendTyping(telegramChatId);

    try {
        const workdir = session.workdir || getSettingsFn().workdir;
        
        // Import ChatManager for direct Cursor communication
        const { ChatManager } = await import('@/lib/agent/chat-manager');
        const chatManager = new ChatManager();

        // Save user message to the selected chat
        const userMessage: Message = {
            id: generateId(),
            role: 'user',
            content: text,
            timestamp: new Date(),
            metadata: { source: 'user' },
        };
        db.addMessage(selectedChatId, userMessage);

        // Update session status
        db.updateSession({ id: selectedChatId, status: 'running' });

        // Send single message to Cursor (no auto-loop with Agent Manager)
        const result = await chatManager.sendSingleMessage(
            text,
            workdir,
            session.cursorSessionId, // Resume existing Cursor session
            async () => {
                await bot.sendTyping(telegramChatId);
            }
        );

        // Save Cursor's response to DB
        if (result.content) {
            const assistantMessage: Message = {
                id: generateId(),
                role: 'assistant',
                content: result.content,
                timestamp: new Date(),
                metadata: { source: 'cursor' },
            };
            db.addMessage(selectedChatId, assistantMessage);
            
            // Send response to Telegram
            await bot.sendLongMessage(telegramChatId, 
                `🤖 Cursor Response:\n\n${result.content}`,
                { replyToMessageId: messageId }
            );
        }

        // Update session with cursor session ID for future resumption
        db.updateSession({ 
            id: selectedChatId, 
            status: 'idle',
            cursorSessionId: result.sessionId,
        });

    } catch (error) {
        console.error('[Telegram] Error processing selected chat message:', error);
        db.updateSession({ id: selectedChatId, status: 'error' });
        await bot.sendMessage(telegramChatId, 
            `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`, 
            { replyToMessageId: messageId }
        );
    }
}
