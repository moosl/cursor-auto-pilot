'use client';

import { useState, useEffect } from 'react';

export interface AppSettings {
    workdir: string;
    skillsPath: string;
}

const DEFAULT_SETTINGS: AppSettings = {
    workdir: '',
    skillsPath: '',
};

const SETTINGS_KEY = 'cursor-pilot-settings';

interface SettingsPanelProps {
    isOpen: boolean;
    onClose: () => void;
    settings: AppSettings;
    onSettingsChange: (settings: AppSettings) => void;
}

export function getStoredSettings(): AppSettings {
    if (typeof window === 'undefined') return DEFAULT_SETTINGS;
    
    try {
        const stored = localStorage.getItem(SETTINGS_KEY);
        if (stored) {
            return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
        }
    } catch (e) {
        console.error('Failed to load settings:', e);
    }
    return DEFAULT_SETTINGS;
}

export function saveSettings(settings: AppSettings): void {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) {
        console.error('Failed to save settings:', e);
    }
}

export function SettingsPanel({ isOpen, onClose, settings, onSettingsChange }: SettingsPanelProps) {
    const [localSettings, setLocalSettings] = useState<AppSettings>(settings);
    const [isSaving, setIsSaving] = useState(false);

    useEffect(() => {
        setLocalSettings(settings);
    }, [settings]);

    const handleSave = async () => {
        setIsSaving(true);
        try {
            // Save to localStorage
            saveSettings(localSettings);
            
            // Also save to server for use in API routes
            await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(localSettings),
            });
            
            onSettingsChange(localSettings);
            onClose();
        } catch (error) {
            console.error('Failed to save settings:', error);
        } finally {
            setIsSaving(false);
        }
    };

    const handleCancel = () => {
        setLocalSettings(settings);
        onClose();
    };

    if (!isOpen) return null;

    return (
        <div 
            className="fixed inset-0 overlay z-50 flex items-center justify-center p-4"
            onClick={handleCancel}
        >
            <div 
                className="bg-[var(--bg-primary)] border rounded-xl w-full max-w-lg overflow-hidden shadow-xl"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b">
                    <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-[var(--bg-tertiary)] flex items-center justify-center">
                            <svg className="w-4 h-4 text-[var(--text-secondary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                            </svg>
                        </div>
                        <h2 className="font-semibold text-[var(--text-primary)]">Settings</h2>
                    </div>
                    <button
                        onClick={handleCancel}
                        className="btn btn-ghost h-8 w-8 p-0"
                    >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>

                {/* Content */}
                <div className="p-5 space-y-5">
                    {/* Working Directory */}
                    <div>
                        <label className="block text-sm font-medium text-[var(--text-primary)] mb-2">
                            Default Working Directory
                        </label>
                        <input
                            type="text"
                            value={localSettings.workdir}
                            onChange={(e) => setLocalSettings({ ...localSettings, workdir: e.target.value })}
                            className="input font-mono text-sm"
                            placeholder="/path/to/your/projects"
                        />
                        <p className="text-xs text-[var(--text-muted)] mt-1.5">
                            The default directory where Cursor will execute tasks
                        </p>
                    </div>

                    {/* Skills Path */}
                    <div>
                        <label className="block text-sm font-medium text-[var(--text-primary)] mb-2">
                            Skills Directory
                        </label>
                        <input
                            type="text"
                            value={localSettings.skillsPath}
                            onChange={(e) => setLocalSettings({ ...localSettings, skillsPath: e.target.value })}
                            className="input font-mono text-sm"
                            placeholder="/path/to/.cursor/skills"
                        />
                        <p className="text-xs text-[var(--text-muted)] mt-1.5">
                            The directory containing Cursor skill files (.md)
                        </p>
                    </div>
                </div>

                {/* Footer */}
                <div className="flex justify-end gap-2 px-5 py-4 border-t bg-[var(--bg-secondary)]">
                    <button
                        onClick={handleCancel}
                        className="btn btn-secondary h-9 px-4"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={isSaving}
                        className="btn btn-primary h-9 px-4"
                    >
                        {isSaving ? (
                            <span className="flex items-center gap-2">
                                <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                </svg>
                                Saving...
                            </span>
                        ) : (
                            'Save'
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
}
