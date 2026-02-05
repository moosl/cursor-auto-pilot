/**
 * Telegram Long-Polling Service
 * Runs as a background service to receive Telegram updates
 */
import { getTelegramBot } from './bot';
import { handleTelegramUpdate, setSettingsGetter } from './handler';

let pollingStarted = false;
let startingPromise: Promise<void> | null = null; // Lock to prevent concurrent starts

/**
 * Start Telegram polling service
 * Should be called once when the app starts
 */
export async function startTelegramPolling(getSettings: () => { workdir: string }): Promise<void> {
    // Check if already polling (actual state check)
    const bot = getTelegramBot();
    if (bot?.isPolling()) {
        console.log('[Telegram Polling] Already polling, skipping');
        return;
    }

    // If already started (flag check), return
    if (pollingStarted) {
        console.log('[Telegram Polling] Already started (flag), skipping');
        return;
    }

    // If there's a start in progress, wait for it
    if (startingPromise) {
        console.log('[Telegram Polling] Start already in progress, waiting...');
        await startingPromise;
        return;
    }

    if (!bot) {
        console.log('[Telegram Polling] Bot not configured, skipping');
        return;
    }

    // Create a promise to lock concurrent starts
    startingPromise = (async () => {
        try {
            // Double-check after acquiring lock
            if (bot.isPolling()) {
                console.log('[Telegram Polling] Already polling (double-check), skipping');
                pollingStarted = true;
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
        } finally {
            // Release lock after a short delay to ensure polling actually started
            setTimeout(() => {
                startingPromise = null;
            }, 1000);
        }
    })();

    await startingPromise;
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
    startingPromise = null; // Reset lock
    console.log('[Telegram Polling] Service stopped');
}

/**
 * Check if polling is active
 */
export function isTelegramPollingActive(): boolean {
    const bot = getTelegramBot();
    return bot?.isPolling() ?? false;
}
