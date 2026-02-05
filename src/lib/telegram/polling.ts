/**
 * Telegram Long-Polling Service
 * Runs as a background service to receive Telegram updates
 */
import { getTelegramBot } from './bot';
import { handleTelegramUpdate, setSettingsGetter } from './handler';

let pollingStarted = false;

/**
 * Start Telegram polling service
 * Should be called once when the app starts
 */
export async function startTelegramPolling(getSettings: () => { workdir: string }): Promise<void> {
    if (pollingStarted) {
        console.log('[Telegram Polling] Already started');
        return;
    }

    const bot = getTelegramBot();
    if (!bot) {
        console.log('[Telegram Polling] Bot not configured, skipping');
        return;
    }

    // Inject settings getter
    setSettingsGetter(getSettings);

    pollingStarted = true;

    // Start polling in background (don't await - let it run)
    bot.startPolling(async (update) => {
        await handleTelegramUpdate(bot, update);
    }).catch((error) => {
        console.error('[Telegram Polling] Fatal error:', error);
        pollingStarted = false;
    });

    console.log('[Telegram Polling] Service started');
}

/**
 * Stop Telegram polling service
 */
export function stopTelegramPolling(): void {
    const bot = getTelegramBot();
    if (bot && bot.isPolling()) {
        bot.stopPolling();
    }
    pollingStarted = false;
    console.log('[Telegram Polling] Service stopped');
}

/**
 * Check if polling is active
 */
export function isTelegramPollingActive(): boolean {
    const bot = getTelegramBot();
    return bot?.isPolling() ?? false;
}
