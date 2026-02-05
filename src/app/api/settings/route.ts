/**
 * Settings API Route
 * Store and retrieve application settings
 */

export const runtime = 'nodejs';

// Use a simple file-based storage for settings
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { startTelegramPolling, isTelegramPollingActive } from '@/lib/telegram/polling';

const SETTINGS_FILE = process.env.SETTINGS_FILE || '.data/settings.json';

// Flag to ensure we only try to start polling once per server instance
let telegramInitAttempted = false;

export interface AppSettings {
    workdir: string;
    skillsPath: string;
}

const DEFAULT_SETTINGS: AppSettings = {
    workdir: process.env.DEFAULT_WORKDIR || process.cwd(),
    skillsPath: process.env.SKILLS_PATH || join(homedir(), '.cursor', 'skills'),
};

function ensureDirectory(filePath: string) {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
}

export function getSettings(): AppSettings {
    try {
        if (existsSync(SETTINGS_FILE)) {
            const data = readFileSync(SETTINGS_FILE, 'utf-8');
            return { ...DEFAULT_SETTINGS, ...JSON.parse(data) };
        }
    } catch (e) {
        console.error('Failed to load settings:', e);
    }
    return DEFAULT_SETTINGS;
}

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
        
        ensureDirectory(SETTINGS_FILE);
        writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
        
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
