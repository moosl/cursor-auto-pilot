/**
 * Orchestrator Agent using Claude Agent SDK
 * Manages complex tasks by creating and monitoring chat sessions with Cursor Agent
 */
import Anthropic from '@anthropic-ai/sdk';
import { readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { ChatManager } from './chat-manager';
import {
    TOOLS,
    CreateChatInput,
    CheckChatStatusInput,
    SendMessageToChatInput,
    ListFilesInput,
    ReadFileInput,
} from './tools';
import { ChatSession, ChatStatus, Message } from '../types';
import { buildOrchestratorPrompt } from '../prompts';
import * as db from '../db';
import { generateId } from '../utils/id';

export interface OrchestratorConfig {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    skillsPath?: string;
}

export interface OrchestratorResult {
    success: boolean;
    content: string;
    tasks_executed: number;
    chats_created: string[];
    error?: string;
}

export interface ProgressCallback {
    (event: {
        type:
        | 'thinking'
        | 'message'
        | 'tool_start'
        | 'tool_end'
        | 'cursor_progress'
        | 'dispatch_order'
        | 'chat_created'
        | 'chat_update'
        | 'chat_complete';
        content: string;
        chatId?: string;
        chatStatus?: ChatStatus;
    }): void;
}

// In-memory cache for active sessions (for faster access during execution)
// SQLite is used for persistence
const globalForChatStore = globalThis as unknown as {
    chatStore: Map<string, ChatSession> | undefined;
};

const chatStore = globalForChatStore.chatStore ?? new Map<string, ChatSession>();
if (process.env.NODE_ENV !== 'production') {
    globalForChatStore.chatStore = chatStore;
}

export class OrchestratorAgent {
    private client: Anthropic;
    private model: string;
    private conversationHistory: Anthropic.MessageParam[] = [];
    private chatManager: ChatManager;
    private createdChats: string[] = [];
    private skillsPath: string;
    private currentChatId?: string; // Current chat ID when continuing in existing chat

    constructor(config: OrchestratorConfig = {}) {
        this.client = new Anthropic({
            apiKey: config.apiKey || process.env.ANTHROPIC_API_KEY,
            baseURL: config.baseUrl || process.env.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_API_BASE,
        });
        this.model = config.model || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
        this.chatManager = new ChatManager(config);
        this.skillsPath = config.skillsPath || process.env.SKILLS_PATH || join(homedir(), '.cursor', 'skills');
    }

    private activeTasks: Promise<void>[] = [];

    /**
     * Run the orchestrator with a user request
     * @param request - The user's request
     * @param workdir - Working directory
     * @param onProgress - Progress callback
     * @param chatId - Optional existing chat ID to continue in
     * @param chatHistory - Optional chat history for context
     */
    async run(
        request: string,
        workdir: string,
        onProgress?: ProgressCallback,
        chatId?: string,
        chatHistory?: Array<{ role: string; content: string }>
    ): Promise<OrchestratorResult> {
        let tasksExecuted = 0;
        let finalContent = '';
        this.activeTasks = []; // Reset active tasks for this run
        this.currentChatId = chatId; // Save current chat ID for tool execution

        // Build context from chat history if provided
        let contextSection = '';
        if (chatHistory && chatHistory.length > 0) {
            contextSection = '\n\n## Previous Conversation Context:\n';
            for (const msg of chatHistory.slice(-10)) { // Last 10 messages for context
                const roleLabel = msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Assistant' : 'System';
                contextSection += `${roleLabel}: ${msg.content.substring(0, 500)}${msg.content.length > 500 ? '...' : ''}\n\n`;
            }
        }

        // Add instruction about using current chat only for regular sessions
        const existingSession = chatId ? (chatStore.get(chatId) || db.getSessionMeta(chatId)) : undefined;
        const shouldContinueInChat = Boolean(
            chatId &&
            chatId !== 'web_orchestrator_main' &&
            existingSession &&
            !existingSession.isOrchestratorManaged
        );
        const chatInstruction = shouldContinueInChat
            ? '\n\nIMPORTANT: You are continuing in an existing chat session. Do NOT create a new chat - execute the task directly in the current conversation using the Cursor Agent.'
            : '';

        // Add user message with context
        this.conversationHistory.push({
            role: 'user',
            content: `Working directory: ${workdir}${contextSection}${chatInstruction}\n\nCurrent Request: ${request}`,
        });

        try {
            // Agentic loop
            while (true) {
                const response = await this.client.messages.create({
                    model: this.model,
                    max_tokens: 4096,
                    system: buildOrchestratorPrompt(this.skillsPath),
                    tools: TOOLS,
                    messages: this.conversationHistory,
                });

                // Process response content
                const assistantContent: Anthropic.ContentBlock[] = [];

                for (const block of response.content) {
                    if (block.type === 'text') {
                        assistantContent.push(block);
                        finalContent += block.text;
                        onProgress?.({ type: 'message', content: block.text });
                    } else if (block.type === 'tool_use') {
                        assistantContent.push(block);
                        onProgress?.({ type: 'tool_start', content: block.name });

                        // Execute tool
                        const toolResult = await this.executeTool(
                            block.name,
                            block.input as Record<string, unknown>,
                            workdir,
                            onProgress
                        );

                        if (block.name === 'create_chat' || block.name === 'dispatch_task') {
                            tasksExecuted++;
                        }

                        onProgress?.({
                            type: 'tool_end',
                            content: `${block.name}: ${toolResult.substring(0, 200)}...`,
                        });

                        // Add assistant message and tool result
                        this.conversationHistory.push({
                            role: 'assistant',
                            content: assistantContent,
                        });

                        this.conversationHistory.push({
                            role: 'user',
                            content: [
                                {
                                    type: 'tool_result',
                                    tool_use_id: block.id,
                                    content: toolResult,
                                },
                            ],
                        });

                        // Continue the loop for next response
                        break;
                    }
                }

                // Check if we should stop
                if (response.stop_reason === 'end_turn') {
                    // Add final assistant message if not already added
                    if (
                        assistantContent.length > 0 &&
                        !this.conversationHistory.some(
                            (m) => m.role === 'assistant' && m.content === assistantContent
                        )
                    ) {
                        this.conversationHistory.push({
                            role: 'assistant',
                            content: assistantContent,
                        });
                    }
                    break;
                }

                // Continue if there are tool uses
                if (response.stop_reason !== 'tool_use') {
                    break;
                }
            }

            // Tasks are running in background - don't wait for completion
            // The orchestrator's job is done once tasks are created and dispatched
            if (this.activeTasks.length > 0) {
                onProgress?.({
                    type: 'message',
                    content: `${this.activeTasks.length} task(s) dispatched and running in background.`,
                });
            }

            return {
                success: true,
                content: finalContent,
                tasks_executed: tasksExecuted,
                chats_created: this.createdChats,
            };
        } catch (error) {
            return {
                success: false,
                content: finalContent,
                tasks_executed: tasksExecuted,
                chats_created: this.createdChats,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    /**
     * Generate task.md content for a sub-task
     */
    private generateTaskMd(title: string, task: string, workdir: string): string {
        const now = new Date().toISOString();
        return `# Task: ${title}

## Description
${task}

## Context
- **Working Directory**: \`${workdir}\`
- **Created**: ${now}

## Acceptance Criteria
- [ ] Task completed as described
- [ ] No errors or issues reported
- [ ] Code follows project conventions

## Notes
_Add any additional notes or requirements here_
`;
    }

    /**
     * Execute a tool and return result
     */
    private async executeTool(
        name: string,
        input: Record<string, unknown>,
        defaultWorkdir: string,
        onProgress?: ProgressCallback
    ): Promise<string> {
        switch (name) {
            case 'create_chat': {
                const { task, title } = input as unknown as CreateChatInput;
                
                // If we have a current chat ID, check if we should execute in that chat
                // EXCEPT: Don't reuse the web orchestrator's own session or orchestrator-managed sessions
                if (this.currentChatId && this.currentChatId !== 'web_orchestrator_main') {
                    const existingSession = chatStore.get(this.currentChatId) || db.getSessionMeta(this.currentChatId);
                    
                    // Only reuse if session exists and is NOT orchestrator-managed (i.e., it's a regular chat)
                    if (existingSession && !existingSession.isOrchestratorManaged) {
                        // Update existing session
                        existingSession.status = 'running';
                        chatStore.set(this.currentChatId, existingSession);
                        db.updateSession({ id: this.currentChatId, status: 'running' });
                        
                        // Notify that we're executing in current chat
                        onProgress?.({
                            type: 'cursor_progress',
                            content: `Executing task: ${title}`,
                            chatId: this.currentChatId,
                            chatStatus: 'running',
                        });
                        
                        // Run conversation in current chat
                        const taskPromise = this.runChatWithProgress(
                            this.currentChatId, 
                            task, 
                            defaultWorkdir, 
                            onProgress,
                            existingSession.taskMd
                        );
                        this.activeTasks.push(taskPromise);
                        
                        return JSON.stringify({
                            success: true,
                            chatId: this.currentChatId,
                            status: 'running',
                            message: 'Task dispatched in current chat session.',
                        });
                    }
                }
                
                // Create new chat: no current chat, or current chat is orchestrator's own session
                const chatId = generateId();

                // Generate task.md content
                const taskMd = this.generateTaskMd(title, task, defaultWorkdir);

                // Create chat session for sub-task
                // Note: Sub-tasks are NOT marked as isOrchestratorManaged
                // They appear in the left sidebar Chat list
                // Create initial user message (the task being sent to Cursor)
                const initialMessage: Message = {
                    id: generateId(),
                    role: 'user',
                    content: task,
                    timestamp: new Date(),
                    metadata: { source: 'orchestrator' },
                };

                // Only the main Orchestrator conversation (Telegram sessions) are marked as isOrchestratorManaged
                const session: ChatSession = {
                    id: chatId,
                    title,
                    createdAt: new Date(),
                    status: 'running',
                    messages: [initialMessage], // Include initial message
                    orchestrateTaskId: chatId, // Mark that this was created by orchestrator
                    workdir: defaultWorkdir, // Save the working directory context
                    taskMd, // Store task description
                };
                chatStore.set(chatId, session);
                db.createSession(session); // Save to SQLite (this will also save the message)
                this.createdChats.push(chatId);

                // Notify about chat creation with initial message
                onProgress?.({
                    type: 'chat_created',
                    content: JSON.stringify({ chatId, title, task, taskMd, initialMessage }),
                    chatId,
                });

                // Start conversation in background - Orchestrator returns immediately
                // Progress is streamed via onProgress callback
                const taskPromise = this.runChatWithProgress(chatId, task, defaultWorkdir, onProgress, taskMd);
                this.activeTasks.push(taskPromise);

                return JSON.stringify({
                    success: true,
                    chatId,
                    status: 'running',
                    message: 'Chat session created and task dispatched.',
                });
            }

            case 'dispatch_task': {
                // Legacy support - maps to create_chat with wait_for_completion=true
                const { task, title } = input as { task: string; title: string };
                return this.executeTool(
                    'create_chat',
                    { task, title, wait_for_completion: true },
                    defaultWorkdir,
                    onProgress
                );
            }

            case 'check_chat_status': {
                const { chat_id } = input as unknown as CheckChatStatusInput;
                // Try memory cache first, then database
                let session = chatStore.get(chat_id);
                if (!session) {
                    session = db.getSessionMeta(chat_id) || undefined;
                }

                if (!session) {
                    return JSON.stringify({ error: 'Chat not found', chatId: chat_id });
                }

                const messageCount = session.messages.length || db.getMessageCount(chat_id);
                const lastMessage = session.messages[session.messages.length - 1] || db.getLastMessage(chat_id);

                return JSON.stringify({
                    chatId: chat_id,
                    title: session.title,
                    status: session.status,
                    messageCount,
                    lastMessage: lastMessage?.content?.substring(0, 200),
                });
            }

            case 'send_message_to_chat': {
                const { chat_id, message } = input as unknown as SendMessageToChatInput;
                const session = chatStore.get(chat_id);

                if (!session) {
                    return JSON.stringify({ error: 'Chat not found', chatId: chat_id });
                }

                // Add user message
                const userMsg: Message = {
                    id: generateId(),
                    role: 'user',
                    content: message,
                    timestamp: new Date(),
                    metadata: { source: 'user' },
                };
                session.messages.push(userMsg);
                db.addMessage(chat_id, userMsg); // Persist to database

                // Send to Cursor
                const result = await this.chatManager.sendSingleMessage(
                    message,
                    defaultWorkdir,
                    session.cursorSessionId
                );

                // Add response
                const assistantMsg: Message = {
                    id: generateId(),
                    role: 'assistant',
                    content: result.content,
                    timestamp: new Date(),
                    metadata: { source: 'cursor' },
                };
                session.messages.push(assistantMsg);
                db.addMessage(chat_id, assistantMsg); // Persist to database

                onProgress?.({
                    type: 'chat_update',
                    content: JSON.stringify({
                        chatId: chat_id,
                        response: result.content.substring(0, 200),
                    }),
                    chatId: chat_id,
                    chatStatus: session.status,
                });

                return JSON.stringify({
                    success: result.success,
                    response: result.content,
                    status: session.status,
                });
            }

            case 'list_files': {
                const { path } = input as unknown as ListFilesInput;
                try {
                    const files = readdirSync(path).map((name) => {
                        const fullPath = join(path, name);
                        const stat = statSync(fullPath);
                        return {
                            name,
                            type: stat.isDirectory() ? 'directory' : 'file',
                            size: stat.size,
                        };
                    });
                    return JSON.stringify(files, null, 2);
                } catch (error) {
                    return JSON.stringify({ error: String(error) });
                }
            }

            case 'read_file': {
                const { path } = input as unknown as ReadFileInput;
                try {
                    const content = readFileSync(path, 'utf-8');
                    return content;
                } catch (error) {
                    return JSON.stringify({ error: String(error) });
                }
            }

            default:
                return JSON.stringify({ error: `Unknown tool: ${name}` });
        }
    }

    /**
     * Run chat conversation with progress streaming
     * This runs asynchronously but streams progress via onProgress callback
     */
    private async runChatWithProgress(
        chatId: string,
        task: string,
        workdir: string,
        onProgress?: ProgressCallback,
        taskMd?: string
    ): Promise<void> {
        const session = chatStore.get(chatId);
        if (!session) return;

        try {
            const result = await this.chatManager.runConversation(
                task,
                workdir,
                (event) => {
                    // Update session status
                    if (event.status) {
                        session.status = event.status;
                        db.updateSession({ id: chatId, status: event.status });
                    }

                    // Handle task.md updates
                    if (event.type === 'task_md_update' && event.taskMd) {
                        session.taskMd = event.taskMd;
                        db.updateSession({ id: chatId, taskMd: event.taskMd });
                        
                        // Notify frontend about task.md update
                        onProgress?.({
                            type: 'chat_update',
                            content: JSON.stringify({
                                type: 'task_md_update',
                                taskMd: event.taskMd,
                            }),
                            chatId,
                        });
                    }

                    // Forward progress to frontend
                    onProgress?.({
                        type: 'chat_update',
                        content: JSON.stringify(event),
                        chatId,
                        chatStatus: event.status,
                    });

                    // Store messages
                    if (event.type === 'cursor_response' && event.content) {
                        const msg: Message = {
                            id: generateId(),
                            role: 'assistant',
                            content: event.content,
                            timestamp: new Date(),
                            metadata: { source: 'cursor' },
                        };
                        session.messages.push(msg);
                        db.addMessage(chatId, msg);
                    } else if (event.type === 'thinking' && event.content) {
                        // Agent Manager's thinking - use 'system' role with thinking source
                        const msg: Message = {
                            id: generateId(),
                            role: 'system',
                            content: event.content,
                            timestamp: new Date(),
                            metadata: { source: 'thinking' },
                        };
                        session.messages.push(msg);
                        db.addMessage(chatId, msg);
                    } else if (event.type === 'ai_followup' && event.content) {
                        // Agent Manager's response - use 'system' role for UI display
                        const msg: Message = {
                            id: generateId(),
                            role: 'system',
                            content: event.content,
                            timestamp: new Date(),
                            metadata: { source: 'agent_manager' },
                        };
                        session.messages.push(msg);
                        db.addMessage(chatId, msg);
                    }
                },
                undefined, // existingSessionId
                taskMd || session.taskMd // Use existing taskMd if available
            );

            session.status = result.success ? 'completed' : 'error';
            session.cursorSessionId = result.cursorSessionId;
            
            // Save final task.md if available
            if (result.finalTaskMd) {
                session.taskMd = result.finalTaskMd;
            }
            
            db.updateSession({ 
                id: chatId, 
                status: session.status, 
                cursorSessionId: result.cursorSessionId,
                taskMd: session.taskMd,
            });

            // Send completion event
            onProgress?.({
                type: 'chat_complete',
                content: JSON.stringify({
                    chatId,
                    success: result.success,
                    turns: result.turns,
                }),
                chatId,
                chatStatus: session.status,
            });

            console.log(`[Chat ${chatId}] Completed: success=${result.success}, turns=${result.turns}`);
        } catch (error) {
            session.status = 'error';
            db.updateSession({ id: chatId, status: 'error' });

            onProgress?.({
                type: 'chat_complete',
                content: JSON.stringify({
                    chatId,
                    success: false,
                    error: String(error),
                }),
                chatId,
                chatStatus: 'error',
            });

            console.error(`[Chat ${chatId}] Error:`, error);
        }
    }

    /**
     * Run chat conversation in background (no streaming)
     * Used when the API response stream is already closed
     */
    private async runChatInBackground(
        chatId: string,
        task: string,
        workdir: string
    ): Promise<void> {
        const session = chatStore.get(chatId);
        if (!session) return;

        try {
            const result = await this.chatManager.runConversation(
                task,
                workdir,
                (event) => {
                    // Update session status
                    if (event.status) {
                        session.status = event.status;
                        db.updateSession({ id: chatId, status: event.status });
                    }

                    // Store messages
                    if (event.type === 'cursor_response' && event.content) {
                        const msg: Message = {
                            id: generateId(),
                            role: 'assistant',
                            content: event.content,
                            timestamp: new Date(),
                            metadata: { source: 'cursor' },
                        };
                        session.messages.push(msg);
                        db.addMessage(chatId, msg);
                    } else if (event.type === 'thinking' && event.content) {
                        // Agent Manager's thinking - use 'system' role with thinking source
                        const msg: Message = {
                            id: generateId(),
                            role: 'system',
                            content: event.content,
                            timestamp: new Date(),
                            metadata: { source: 'thinking' },
                        };
                        session.messages.push(msg);
                        db.addMessage(chatId, msg);
                    } else if (event.type === 'ai_followup' && event.content) {
                        // Agent Manager's response - use 'system' role for UI display
                        const msg: Message = {
                            id: generateId(),
                            role: 'system',
                            content: event.content,
                            timestamp: new Date(),
                            metadata: { source: 'agent_manager' },
                        };
                        session.messages.push(msg);
                        db.addMessage(chatId, msg);
                    }
                }
            );

            session.status = result.success ? 'completed' : 'error';
            session.cursorSessionId = result.cursorSessionId;
            db.updateSession({ id: chatId, status: session.status, cursorSessionId: result.cursorSessionId });

            console.log(`[Background Chat ${chatId}] Completed: success=${result.success}, turns=${result.turns}`);
        } catch (error) {
            session.status = 'error';
            db.updateSession({ id: chatId, status: 'error' });
            console.error(`[Background Chat ${chatId}] Error:`, error);
        }
    }

    /**
     * Get chat session by ID
     * @param chatId - The chat ID to look up
     * @param forceRefresh - If true, always load from database. Default: true for consistency.
     */
    static getChat(chatId: string, forceRefresh: boolean = true): ChatSession | undefined {
        console.log(`[OrchestratorAgent.getChat] chatId=${chatId}, forceRefresh=${forceRefresh}`);
        
        // Check memory cache first if not forcing refresh
        if (!forceRefresh) {
            const cached = chatStore.get(chatId);
            if (cached) {
                console.log(`[OrchestratorAgent.getChat] Found in memory cache, messages: ${cached.messages?.length || 0}`);
                return cached;
            }
        }
        
        // Load from database for fresh data
        const dbSession = db.getSessionWithMessages(chatId);
        
        if (dbSession) {
            console.log(`[OrchestratorAgent.getChat] Found in database, messages: ${dbSession.messages?.length || 0}`);
            // Update cache with fresh data
            chatStore.set(chatId, dbSession);
            return dbSession;
        }
        
        // Check memory cache as fallback (for newly created but not yet persisted sessions)
        const cached = chatStore.get(chatId);
        if (cached) {
            console.log(`[OrchestratorAgent.getChat] Found only in memory cache (fallback), messages: ${cached.messages?.length || 0}`);
            return cached;
        }
        
        console.log(`[OrchestratorAgent.getChat] Not found anywhere`);
        return undefined;
    }

    /**
     * Get all chat sessions
     * Returns from database for complete history
     */
    static getAllChats(): ChatSession[] {
        // Get all sessions from database
        const sessions = db.getAllSessions();
        
        // Merge with any active sessions in memory that might have more recent data
        for (const [id, session] of chatStore.entries()) {
            const idx = sessions.findIndex(s => s.id === id);
            if (idx >= 0) {
                // Update with memory version (has messages loaded)
                sessions[idx] = session;
            } else {
                sessions.unshift(session);
            }
        }
        
        return sessions;
    }

    /**
     * Remove a chat session from memory cache
     * Used when deleting a session
     */
    static removeChat(chatId: string): boolean {
        return chatStore.delete(chatId);
    }

    /**
     * Reset conversation history
     */
    reset(): void {
        this.conversationHistory = [];
        this.createdChats = [];
    }
}

export { chatStore };
