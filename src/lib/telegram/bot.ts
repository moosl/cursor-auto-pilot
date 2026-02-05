/**
 * Telegram Bot Integration
 * Allows interaction with the Orchestrator Agent via Telegram
 */

export interface TelegramMessage {
    message_id: number;
    from: {
        id: number;
        is_bot: boolean;
        first_name: string;
        username?: string;
    };
    chat: {
        id: number;
        type: string;
    };
    date: number;
    text?: string;
}

export interface TelegramUpdate {
    update_id: number;
    message?: TelegramMessage;
    callback_query?: TelegramCallbackQuery;
}

export interface TelegramBotConfig {
    token: string;
    allowedChatIds: number[];
}

// Callback query from inline keyboard
export interface TelegramCallbackQuery {
    id: string;
    from: {
        id: number;
        is_bot: boolean;
        first_name: string;
        username?: string;
    };
    message?: TelegramMessage;
    chat_instance: string;
    data?: string;
}

// Inline keyboard button
export interface InlineKeyboardButton {
    text: string;
    callback_data?: string;
    url?: string;
}

// Inline keyboard markup
export interface InlineKeyboardMarkup {
    inline_keyboard: InlineKeyboardButton[][];
}

const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';

// Bot commands for the menu
const BOT_COMMANDS = [
    { command: 'chats', description: '📋 Browse and select chats' },
    { command: 'back', description: '🤖 Return to main agent' },
    { command: 'status', description: '📊 Show system status' },
    { command: 'clear', description: '🗑️ Clear conversation history' },
    { command: 'start', description: '🚀 Start the bot' },
    { command: 'help', description: '📚 Show help' }
];

export class TelegramBot {
    private token: string;
    private allowedChatIds: Set<number>;
    private pollingActive: boolean = false;
    private lastUpdateId: number = 0;
    private pollingAbortController: AbortController | null = null;

    constructor(config: TelegramBotConfig) {
        this.token = config.token;
        this.allowedChatIds = new Set(config.allowedChatIds);
    }

    /**
     * Check if a chat ID is allowed to use the bot
     */
    isAllowedChat(chatId: number): boolean {
        return this.allowedChatIds.size === 0 || this.allowedChatIds.has(chatId);
    }

    /**
     * Send a message to a chat
     */
    async sendMessage(chatId: number, text: string, options?: {
        parseMode?: 'Markdown' | 'HTML';
        replyToMessageId?: number;
        replyMarkup?: InlineKeyboardMarkup;
    }): Promise<boolean> {
        try {
            const response = await fetch(`${TELEGRAM_API_BASE}${this.token}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: text,
                    parse_mode: options?.parseMode,
                    reply_to_message_id: options?.replyToMessageId,
                    reply_markup: options?.replyMarkup,
                }),
            });

            const result = await response.json();
            if (!result.ok) {
                console.error('[Telegram] Failed to send message:', result);
                
                // If Markdown parsing failed, retry without parse_mode
                if (options?.parseMode && result.description?.includes("parse entities")) {
                    console.log('[Telegram] Retrying without Markdown...');
                    return this.sendMessage(chatId, text, {
                        ...options,
                        parseMode: undefined,
                    });
                }
                return false;
            }
            return true;
        } catch (error) {
            console.error('[Telegram] Error sending message:', error);
            return false;
        }
    }

    /**
     * Answer callback query (acknowledge button press)
     */
    async answerCallbackQuery(callbackQueryId: string, options?: {
        text?: string;
        showAlert?: boolean;
    }): Promise<boolean> {
        try {
            const response = await fetch(`${TELEGRAM_API_BASE}${this.token}/answerCallbackQuery`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    callback_query_id: callbackQueryId,
                    text: options?.text,
                    show_alert: options?.showAlert,
                }),
            });
            const result = await response.json();
            return result.ok;
        } catch (error) {
            console.error('[Telegram] Error answering callback query:', error);
            return false;
        }
    }

    /**
     * Edit message text
     */
    async editMessageText(chatId: number, messageId: number, text: string, options?: {
        parseMode?: 'Markdown' | 'HTML';
        replyMarkup?: InlineKeyboardMarkup;
    }): Promise<boolean> {
        try {
            const response = await fetch(`${TELEGRAM_API_BASE}${this.token}/editMessageText`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    message_id: messageId,
                    text: text,
                    parse_mode: options?.parseMode,
                    reply_markup: options?.replyMarkup,
                }),
            });
            const result = await response.json();
            if (!result.ok) {
                console.error('[Telegram] Failed to edit message:', result);
                // If Markdown parsing failed, retry without parse_mode
                if (options?.parseMode && result.description?.includes("parse entities")) {
                    console.log('[Telegram] Retrying edit without Markdown...');
                    return this.editMessageText(chatId, messageId, text, {
                        ...options,
                        parseMode: undefined,
                    });
                }
            }
            return result.ok;
        } catch (error) {
            console.error('[Telegram] Error editing message:', error);
            return false;
        }
    }

    /**
     * Send a long message, splitting if necessary
     */
    async sendLongMessage(chatId: number, text: string, options?: {
        parseMode?: 'Markdown' | 'HTML';
        replyToMessageId?: number;
    }): Promise<boolean> {
        const MAX_LENGTH = 4000; // Telegram limit is 4096, leave some margin
        
        if (text.length <= MAX_LENGTH) {
            return this.sendMessage(chatId, text, options);
        }

        // Split by paragraphs first
        const parts: string[] = [];
        let currentPart = '';
        const paragraphs = text.split('\n\n');

        for (const paragraph of paragraphs) {
            if (currentPart.length + paragraph.length + 2 > MAX_LENGTH) {
                if (currentPart) {
                    parts.push(currentPart.trim());
                }
                // If single paragraph is too long, split by newlines
                if (paragraph.length > MAX_LENGTH) {
                    const lines = paragraph.split('\n');
                    currentPart = '';
                    for (const line of lines) {
                        if (currentPart.length + line.length + 1 > MAX_LENGTH) {
                            parts.push(currentPart.trim());
                            currentPart = line;
                        } else {
                            currentPart += (currentPart ? '\n' : '') + line;
                        }
                    }
                } else {
                    currentPart = paragraph;
                }
            } else {
                currentPart += (currentPart ? '\n\n' : '') + paragraph;
            }
        }
        if (currentPart) {
            parts.push(currentPart.trim());
        }

        // Send all parts
        for (let i = 0; i < parts.length; i++) {
            const partText = parts.length > 1 ? `[${i + 1}/${parts.length}]\n${parts[i]}` : parts[i];
            const success = await this.sendMessage(chatId, partText, {
                ...options,
                // Only reply to original message for first part
                replyToMessageId: i === 0 ? options?.replyToMessageId : undefined,
            });
            if (!success) return false;
            
            // Small delay between messages to avoid rate limiting
            if (i < parts.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }

        return true;
    }

    /**
     * Send typing indicator
     */
    async sendTyping(chatId: number): Promise<void> {
        try {
            await fetch(`${TELEGRAM_API_BASE}${this.token}/sendChatAction`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    action: 'typing',
                }),
            });
        } catch (error) {
            // Ignore typing indicator errors
        }
    }

    /**
     * Set webhook URL
     */
    async setWebhook(url: string): Promise<{ ok: boolean; description?: string }> {
        try {
            const response = await fetch(`${TELEGRAM_API_BASE}${this.token}/setWebhook`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url }),
            });
            return await response.json();
        } catch (error) {
            return { ok: false, description: String(error) };
        }
    }

    /**
     * Get webhook info
     */
    async getWebhookInfo(): Promise<unknown> {
        try {
            const response = await fetch(`${TELEGRAM_API_BASE}${this.token}/getWebhookInfo`);
            return await response.json();
        } catch (error) {
            return { ok: false, description: String(error) };
        }
    }

    /**
     * Delete webhook
     */
    async deleteWebhook(): Promise<{ ok: boolean; description?: string }> {
        try {
            const response = await fetch(`${TELEGRAM_API_BASE}${this.token}/deleteWebhook`);
            return await response.json();
        } catch (error) {
            return { ok: false, description: String(error) };
        }
    }

    /**
     * Set bot commands menu
     */
    async setCommands(): Promise<boolean> {
        try {
            const response = await fetch(`${TELEGRAM_API_BASE}${this.token}/setMyCommands`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ commands: BOT_COMMANDS }),
            });
            const result = await response.json();
            if (result.ok) {
                console.log('[Telegram] Bot commands menu set successfully');
            } else {
                console.error('[Telegram] Failed to set commands:', result);
            }
            return result.ok;
        } catch (error) {
            console.error('[Telegram] Error setting commands:', error);
            return false;
        }
    }

    /**
     * Get updates using long-polling
     */
    async getUpdates(timeout: number = 30): Promise<TelegramUpdate[]> {
        try {
            const params = new URLSearchParams({
                timeout: timeout.toString(),
                allowed_updates: JSON.stringify(['message', 'callback_query']),
            });
            
            if (this.lastUpdateId > 0) {
                params.set('offset', (this.lastUpdateId + 1).toString());
            }

            const response = await fetch(
                `${TELEGRAM_API_BASE}${this.token}/getUpdates?${params}`,
                {
                    signal: this.pollingAbortController?.signal,
                }
            );
            
            const result = await response.json();
            
            if (!result.ok) {
                // If conflict (409), another instance is polling - stop this one
                if (result.error_code === 409) {
                    console.warn('[Telegram] Conflict detected: another bot instance is polling. Stopping this instance.');
                    this.pollingActive = false;
                    throw new Error('CONFLICT_409');
                }
                console.error('[Telegram] getUpdates failed:', result);
                return [];
            }

            const updates: TelegramUpdate[] = result.result || [];
            
            // Update offset to acknowledge received updates
            if (updates.length > 0) {
                this.lastUpdateId = Math.max(...updates.map(u => u.update_id));
            }

            return updates;
        } catch (error) {
            // Don't log abort errors (expected when stopping)
            if ((error as Error).name !== 'AbortError') {
                console.error('[Telegram] Error getting updates:', error);
            }
            return [];
        }
    }

    /**
     * Start long-polling loop
     */
    async startPolling(onUpdate: (update: TelegramUpdate) => Promise<void>): Promise<void> {
        if (this.pollingActive) {
            console.log('[Telegram] Polling already active');
            return;
        }

        // Delete any existing webhook first (required for polling to work)
        console.log('[Telegram] Deleting webhook to enable polling...');
        await this.deleteWebhook();

        // Set bot commands menu
        await this.setCommands();

        this.pollingActive = true;
        this.pollingAbortController = new AbortController();
        
        console.log('[Telegram] Starting long-polling...');

        while (this.pollingActive) {
            try {
                const updates = await this.getUpdates(30);
                
                for (const update of updates) {
                    try {
                        await onUpdate(update);
                    } catch (error) {
                        console.error('[Telegram] Error processing update:', error);
                    }
                }
            } catch (error) {
                if ((error as Error).name === 'AbortError') {
                    break;
                }
                // If conflict (409), stop polling immediately
                if ((error as Error).message === 'CONFLICT_409') {
                    console.log('[Telegram] Stopping polling due to conflict');
                    this.pollingActive = false;
                    break;
                }
                console.error('[Telegram] Polling error:', error);
                // Wait before retrying on error
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }

        console.log('[Telegram] Polling stopped');
    }

    /**
     * Stop long-polling
     */
    stopPolling(): void {
        console.log('[Telegram] Stopping polling...');
        this.pollingActive = false;
        this.pollingAbortController?.abort();
        this.pollingAbortController = null;
    }

    /**
     * Check if polling is active
     */
    isPolling(): boolean {
        return this.pollingActive;
    }
}

// Singleton instance
let botInstance: TelegramBot | null = null;

export function getTelegramBot(): TelegramBot | null {
    if (botInstance) return botInstance;

    const token = process.env.TELEGRAM_BOT_TOKEN;
    const allowedChatIds = process.env.TELEGRAM_ALLOWED_CHAT_IDS
        ?.split(',')
        .map(id => parseInt(id.trim(), 10))
        .filter(id => !isNaN(id)) || [];

    if (!token) {
        console.warn('[Telegram] Bot token not configured');
        return null;
    }

    botInstance = new TelegramBot({
        token,
        allowedChatIds,
    });

    return botInstance;
}
