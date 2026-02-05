/**
 * Telegram Webhook API Route
 * 
 * This route handles:
 * 1. Webhook mode: Receives updates from Telegram when webhook is configured
 * 2. Polling startup: Automatically starts long-polling when webhook route is accessed
 * 
 * Long-polling is the default mode and doesn't require ngrok or public URL.
 */
import { getTelegramBot, TelegramUpdate } from '@/lib/telegram/bot';
import { handleTelegramUpdate, setSettingsGetter } from '@/lib/telegram/handler';
import { startTelegramPolling, isTelegramPollingActive } from '@/lib/telegram/polling';
import { getSettings } from '@/app/api/settings/route';

export const runtime = 'nodejs';
export const maxDuration = 60; // 1 minute timeout

// Initialize settings getter for handler
setSettingsGetter(getSettings);

// Auto-start polling when this module is loaded (for long-polling mode)
// This runs once when the server starts
if (typeof window === 'undefined') {
    // Server-side only
    const bot = getTelegramBot();
    if (bot && !isTelegramPollingActive()) {
        console.log('[Telegram] Auto-starting long-polling service...');
        startTelegramPolling(getSettings);
    }
}

/**
 * POST handler for webhook mode
 * If you're using webhook mode with ngrok, Telegram sends updates here
 */
export async function POST(req: Request) {
    const bot = getTelegramBot();
    if (!bot) {
        console.error('[Telegram Webhook] Bot not configured');
        return new Response('Bot not configured', { status: 500 });
    }

    // If polling is active, we shouldn't receive webhook requests
    // This could happen if webhook wasn't deleted properly
    if (isTelegramPollingActive()) {
        console.warn('[Telegram Webhook] Received webhook while polling is active. Ignoring.');
        return new Response('Polling mode active', { status: 200 });
    }

    try {
        const update: TelegramUpdate = await req.json();
        console.log('[Telegram Webhook] Received update:', JSON.stringify(update, null, 2));

        await handleTelegramUpdate(bot, update);

        return new Response('OK');
    } catch (error) {
        console.error('[Telegram Webhook] Error:', error);
        return new Response('Error', { status: 500 });
    }
}

/**
 * GET endpoint for status check and polling startup
 */
export async function GET() {
    const bot = getTelegramBot();
    
    // Auto-start polling if not active
    if (bot && !isTelegramPollingActive()) {
        console.log('[Telegram] Starting long-polling service via GET request...');
        startTelegramPolling(getSettings);
    }
    
    const pollingActive = isTelegramPollingActive();
    
    return new Response(JSON.stringify({
        configured: !!bot,
        mode: pollingActive ? 'polling' : 'webhook',
        pollingActive,
    }), { 
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}
