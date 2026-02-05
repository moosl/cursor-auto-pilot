/**
 * Settings API Route
 * Store and retrieve application settings
 */

export const runtime = 'nodejs';

import { getSettings, saveSettings, AppSettings } from '@/lib/settings';
import { startTelegramPolling, isTelegramPollingActive } from '@/lib/telegram/polling';

// Re-export types for compatibility
export type { AppSettings };

// Flag to prevent rapid repeated attempts in same worker
let telegramInitAttempted = false;
let lastAttemptTime = 0;

export async function GET() {
    try {
        const settings = getSettings();
        
        // Auto-start Telegram polling on first page load (settings is fetched on page load)
        // Check bot's actual state first (source of truth across all workers)
        if (!isTelegramPollingActive()) {
            // Prevent rapid repeated attempts (wait at least 2 seconds between attempts)
            const now = Date.now();
            if (!telegramInitAttempted || now - lastAttemptTime > 2000) {
                telegramInitAttempted = true;
                lastAttemptTime = now;
                console.log('[Settings API] Auto-starting Telegram polling...');
                // Don't await - let it start in background
                startTelegramPolling(getSettings).catch((error) => {
                    console.error('[Settings API] Failed to start polling:', error);
                    // Reset flag on error so we can retry later
                    telegramInitAttempted = false;
                });
            }
        }
        
        return new Response(JSON.stringify(settings), {
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (error) {
        console.error('[Settings API] Error:', error);
        return new Response(
            JSON.stringify({ error: 'Failed to get settings' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
}

export async function POST(req: Request) {
    try {
        const settings = await req.json();
        
        saveSettings(settings);
        
        return new Response(JSON.stringify({ success: true, settings }), {
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (error) {
        console.error('[Settings API] Error:', error);
        return new Response(
            JSON.stringify({ error: 'Failed to save settings' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
}
