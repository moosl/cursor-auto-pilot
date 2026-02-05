/**
 * Settings API Route
 * Store and retrieve application settings
 */

export const runtime = 'nodejs';

import { getSettings, saveSettings, AppSettings } from '@/lib/settings';
import { startTelegramPolling, isTelegramPollingActive } from '@/lib/telegram/polling';

// Re-export types for compatibility
export type { AppSettings };

// Flag to ensure we only try to start polling once per server instance
let telegramInitAttempted = false;

export async function GET() {
    try {
        const settings = getSettings();
        
        // Auto-start Telegram polling on first page load (settings is fetched on page load)
        // Only attempt once per server instance to avoid conflicts
        if (!telegramInitAttempted) {
            telegramInitAttempted = true;
            if (!isTelegramPollingActive()) {
                console.log('[Settings API] Auto-starting Telegram polling...');
                startTelegramPolling(getSettings);
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
