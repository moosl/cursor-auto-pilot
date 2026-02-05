/**
 * Telegram Long-Polling Service
 * Runs as a background service to receive Telegram updates
 */
import { getTelegramBot } from './bot';
import { handleTelegramUpdate, setSettingsGetter } from './handler';

let startingPromise: Promise<void> | null = null; // Lock to prevent concurrent starts in same worker
let conflictDetected = false; // Flag to prevent retries after conflict
let conflictResetTime = 0; // Timestamp when conflict was detected

/**
 * Start Telegram polling service
 * Should be called once when the app starts
 * 
 * This function uses bot.isPolling() as the source of truth to prevent
 * multiple instances from starting polling, even across different Next.js workers.
 */
export async function startTelegramPolling(getSettings: () => { workdir: string }): Promise<void> {
    const bot = getTelegramBot();
    
    // Always check bot's actual state first (source of truth)
    if (bot?.isPolling()) {
        console.log('[Telegram Polling] Already polling (checked bot state), skipping');
        return;
    }

    if (!bot) {
        console.log('[Telegram Polling] Bot not configured, skipping');
        return;
    }

    // If conflict was detected recently, wait before retrying (5 minutes)
    if (conflictDetected && Date.now() - conflictResetTime < 5 * 60 * 1000) {
        console.log('[Telegram Polling] Conflict detected recently, skipping start');
        return;
    }
    
    // Reset conflict flag if enough time has passed
    if (conflictDetected && Date.now() - conflictResetTime >= 5 * 60 * 1000) {
        console.log('[Telegram Polling] Conflict timeout expired, resetting flag');
        conflictDetected = false;
    }

    // If there's a start in progress in this worker, wait for it
    if (startingPromise) {
        console.log('[Telegram Polling] Start already in progress in this worker, waiting...');
        await startingPromise;
        // Check again after waiting
        if (bot.isPolling()) {
            console.log('[Telegram Polling] Polling started by another worker, skipping');
            return;
        }
    }

    // Create a promise to lock concurrent starts in this worker
    startingPromise = (async () => {
        try {
            // Final check: bot's actual state (this is the source of truth)
            if (bot.isPolling()) {
                console.log('[Telegram Polling] Already polling (final check), skipping');
                return;
            }

            // Inject settings getter
            setSettingsGetter(getSettings);

            console.log('[Telegram Polling] Starting polling service...');

            // Start polling in background (don't await - let it run)
            bot.startPolling(async (update) => {
                await handleTelegramUpdate(bot, update);
            }).catch((error) => {
                console.error('[Telegram Polling] Fatal error:', error);
                // If conflict (409), set flag to prevent retries
                if (error?.message === 'CONFLICT_409' || String(error).includes('409')) {
                    console.log('[Telegram Polling] Conflict detected, will retry after 5 minutes');
                    conflictDetected = true;
                    conflictResetTime = Date.now();
                }
            });

            console.log('[Telegram Polling] Service started');
        } finally {
            // Release lock after a short delay to ensure polling actually started
            setTimeout(() => {
                startingPromise = null;
            }, 2000);
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
    startingPromise = null; // Reset lock
    conflictDetected = false; // Reset conflict flag
    console.log('[Telegram Polling] Service stopped');
}

/**
 * Check if polling is active
 */
export function isTelegramPollingActive(): boolean {
    const bot = getTelegramBot();
    return bot?.isPolling() ?? false;
}
