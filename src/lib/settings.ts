/**
 * Shared settings management
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

const SETTINGS_FILE = process.env.SETTINGS_FILE || '.data/settings.json';

export interface AppSettings {
    workdir: string;
    skillsPath: string;
    model: string;
}

const DEFAULT_SETTINGS: AppSettings = {
    workdir: process.env.DEFAULT_WORKDIR || process.cwd(),
    skillsPath: process.env.SKILLS_PATH || join(homedir(), '.cursor', 'skills'),
    model: process.env.CURSOR_MODEL || 'auto',
};

export function ensureDirectory(filePath: string) {
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

export function saveSettings(settings: AppSettings): void {
    ensureDirectory(SETTINGS_FILE);
    writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

export const SETTINGS_FILE_PATH = SETTINGS_FILE;
