'use client';

import { useState, useRef, useEffect, KeyboardEvent, ChangeEvent } from 'react';

interface MentionOption {
    id: string;
    label: string;
    description: string;
}

const MENTION_OPTIONS: MentionOption[] = [
    {
        id: 'orchestrator',
        label: 'Orchestrator',
        description: 'Route through AI Orchestrator for complex tasks',
    },
];

interface MentionInputProps {
    value: string;
    onChange: (value: string) => void;
    onSubmit: (message: string, mentionedIds: string[]) => void;
    placeholder?: string;
    disabled?: boolean;
    isLoading?: boolean;
    onStop?: () => void;
}

export function MentionInput({
    value,
    onChange,
    onSubmit,
    placeholder = 'Enter message...',
    disabled = false,
    isLoading = false,
    onStop,
}: MentionInputProps) {
    const [showMentionMenu, setShowMentionMenu] = useState(false);
    const [mentionFilter, setMentionFilter] = useState('');
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [mentionStartIndex, setMentionStartIndex] = useState(-1);
    const inputRef = useRef<HTMLInputElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);

    // Filter mention options based on input
    const filteredOptions = MENTION_OPTIONS.filter((opt) =>
        opt.label.toLowerCase().includes(mentionFilter.toLowerCase())
    );

    // Extract mentioned IDs from the message
    const extractMentions = (text: string): string[] => {
        const mentions: string[] = [];
        const regex = /@(\w+)/g;
        let match;
        while ((match = regex.exec(text)) !== null) {
            const mentionLabel = match[1].toLowerCase();
            const option = MENTION_OPTIONS.find(
                (opt) => opt.label.toLowerCase() === mentionLabel
            );
            if (option) {
                mentions.push(option.id);
            }
        }
        return mentions;
    };

    const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
        const newValue = e.target.value;
        const cursorPos = e.target.selectionStart || 0;
        onChange(newValue);

        // Check if we should show mention menu
        const textBeforeCursor = newValue.slice(0, cursorPos);
        const atIndex = textBeforeCursor.lastIndexOf('@');

        if (atIndex !== -1) {
            const textAfterAt = textBeforeCursor.slice(atIndex + 1);
            // Only show menu if @ is at start or after a space, and no space after @
            const charBeforeAt = atIndex > 0 ? newValue[atIndex - 1] : ' ';
            if ((charBeforeAt === ' ' || atIndex === 0) && !textAfterAt.includes(' ')) {
                setShowMentionMenu(true);
                setMentionFilter(textAfterAt);
                setMentionStartIndex(atIndex);
                setSelectedIndex(0);
                return;
            }
        }

        setShowMentionMenu(false);
        setMentionFilter('');
        setMentionStartIndex(-1);
    };

    const insertMention = (option: MentionOption) => {
        if (mentionStartIndex === -1) return;

        const before = value.slice(0, mentionStartIndex);
        const cursorPos = inputRef.current?.selectionStart || value.length;
        const after = value.slice(cursorPos);

        const newValue = `${before}@${option.label} ${after}`;
        onChange(newValue);
        setShowMentionMenu(false);
        setMentionFilter('');
        setMentionStartIndex(-1);

        // Focus input and set cursor position
        setTimeout(() => {
            if (inputRef.current) {
                const newCursorPos = before.length + option.label.length + 2; // +2 for @ and space
                inputRef.current.focus();
                inputRef.current.setSelectionRange(newCursorPos, newCursorPos);
            }
        }, 0);
    };

    const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
        if (showMentionMenu && filteredOptions.length > 0) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSelectedIndex((prev) => (prev + 1) % filteredOptions.length);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSelectedIndex((prev) => (prev - 1 + filteredOptions.length) % filteredOptions.length);
            } else if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                insertMention(filteredOptions[selectedIndex]);
            } else if (e.key === 'Escape') {
                setShowMentionMenu(false);
            }
        } else if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        }
    };

    const handleSubmit = () => {
        if (!value.trim() || disabled || isLoading) return;
        const trimmedValue = value.trim(); // Trim whitespace from both ends
        const mentions = extractMentions(trimmedValue);
        onSubmit(trimmedValue, mentions);
    };

    // Close menu when clicking outside
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (
                menuRef.current &&
                !menuRef.current.contains(e.target as Node) &&
                inputRef.current &&
                !inputRef.current.contains(e.target as Node)
            ) {
                setShowMentionMenu(false);
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    return (
        <div className="flex items-center gap-2 w-full">
            <div className="flex-1 relative">
                <input
                    ref={inputRef}
                    value={value}
                    onChange={handleChange}
                    onKeyDown={handleKeyDown}
                    placeholder={placeholder}
                    className="input h-11 pr-4 pl-4"
                    disabled={disabled || isLoading}
                />

                {/* Mention Menu */}
                {showMentionMenu && filteredOptions.length > 0 && (
                    <div
                        ref={menuRef}
                        className="absolute bottom-full left-0 mb-2 w-72 card p-1 z-50"
                    >
                        {filteredOptions.map((option, index) => (
                            <button
                                key={option.id}
                                onClick={() => insertMention(option)}
                                className={`w-full text-left px-3 py-2 rounded-md flex flex-col transition-colors ${
                                    index === selectedIndex
                                        ? 'bg-[var(--bg-tertiary)]'
                                        : 'hover:bg-[var(--bg-secondary)]'
                                }`}
                            >
                                <span className="font-medium text-sm text-[var(--text-primary)]">@{option.label}</span>
                                <span className="text-xs text-[var(--text-muted)] mt-0.5">
                                    {option.description}
                                </span>
                            </button>
                        ))}
                    </div>
                )}
            </div>
            {isLoading && onStop ? (
                <button
                    type="button"
                    onClick={onStop}
                    className="btn btn-destructive h-11 px-4"
                    title="Stop"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                        <rect x="6" y="6" width="12" height="12" rx="2" />
                    </svg>
                    Stop
                </button>
            ) : (
                <button
                    type="button"
                    onClick={handleSubmit}
                    disabled={disabled || isLoading || !value.trim()}
                    className="btn btn-primary h-11 px-4"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                    </svg>
                    Send
                </button>
            )}
        </div>
    );
}
