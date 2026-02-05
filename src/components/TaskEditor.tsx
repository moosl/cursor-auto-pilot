'use client';

import { useState, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';

interface TaskEditorProps {
    sessionId: string;
    initialContent?: string;
    onUpdate?: (content: string) => void;
    compact?: boolean; // Compact mode for header
}

export function TaskEditor({ sessionId, initialContent, onUpdate, compact = false }: TaskEditorProps) {
    const [content, setContent] = useState(initialContent || '');
    const [isEditing, setIsEditing] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [isOpen, setIsOpen] = useState(false);

    useEffect(() => {
        if (initialContent) {
            setContent(initialContent);
        }
    }, [initialContent]);

    const handleSave = useCallback(async () => {
        setIsSaving(true);
        try {
            const response = await fetch(`/api/sessions/${sessionId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ taskMd: content }),
            });

            if (response.ok) {
                setIsEditing(false);
                onUpdate?.(content);
            } else {
                console.error('Failed to save task.md');
            }
        } catch (error) {
            console.error('Error saving task.md:', error);
        } finally {
            setIsSaving(false);
        }
    }, [sessionId, content, onUpdate]);

    const handleCancel = () => {
        setContent(initialContent || '');
        setIsEditing(false);
    };

    if (!content && !isEditing) {
        return null;
    }

    // Compact mode - just a button that opens a modal/popover
    if (compact) {
        return (
            <>
                <button
                    onClick={() => setIsOpen(true)}
                    className="btn btn-ghost h-6 px-2 text-xs gap-1"
                    title="View Task Description"
                >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    Task
                </button>

                {/* Modal overlay */}
                {isOpen && (
                    <div 
                        className="fixed inset-0 overlay z-50 flex items-center justify-center p-4"
                        onClick={() => {
                            if (!isEditing) setIsOpen(false);
                        }}
                    >
                        <div 
                            className="bg-[var(--bg-primary)] border rounded-xl w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col shadow-xl"
                            onClick={(e) => e.stopPropagation()}
                        >
                            {/* Header */}
                            <div className="flex items-center justify-between px-5 py-4 border-b">
                                <div className="flex items-center gap-3">
                                    <div className="w-8 h-8 rounded-lg bg-[var(--bg-tertiary)] flex items-center justify-center">
                                        <svg className="w-4 h-4 text-[var(--text-secondary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                        </svg>
                                    </div>
                                    <h2 className="font-semibold text-[var(--text-primary)]">Task Description</h2>
                                </div>
                                <div className="flex items-center gap-2">
                                    {!isEditing && (
                                        <button
                                            onClick={() => setIsEditing(true)}
                                            className="btn btn-secondary h-8 px-3 text-xs"
                                        >
                                            Edit
                                        </button>
                                    )}
                                    <button
                                        onClick={() => {
                                            if (isEditing) {
                                                handleCancel();
                                            }
                                            setIsOpen(false);
                                        }}
                                        className="btn btn-secondary h-8 w-8 p-0 flex items-center justify-center text-sm"
                                        title="Close"
                                    >
                                        ×
                                    </button>
                                </div>
                            </div>

                            {/* Content */}
                            <div className="p-5 overflow-y-auto flex-1">
                                {isEditing ? (
                                    <div className="space-y-4">
                                        <textarea
                                            value={content}
                                            onChange={(e) => setContent(e.target.value)}
                                            className="input w-full h-64 font-mono text-sm resize-y"
                                            placeholder="# Task Description..."
                                        />
                                        <div className="flex justify-end gap-2">
                                            <button
                                                onClick={handleCancel}
                                                className="btn btn-secondary h-9 px-4"
                                                disabled={isSaving}
                                            >
                                                Cancel
                                            </button>
                                            <button
                                                onClick={handleSave}
                                                disabled={isSaving}
                                                className="btn btn-primary h-9 px-4"
                                            >
                                                {isSaving ? 'Saving...' : 'Save'}
                                            </button>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="prose prose-sm max-w-none">
                                        <ReactMarkdown>{content}</ReactMarkdown>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                )}
            </>
        );
    }

    // Full mode (original)
    return (
        <div className="card overflow-hidden mb-4">
            {/* Header */}
            <div 
                className="flex items-center justify-between px-4 py-3 bg-[var(--bg-secondary)] border-b cursor-pointer"
                onClick={() => setIsOpen(!isOpen)}
            >
                <div className="flex items-center gap-2">
                    <svg className="w-4 h-4 text-[var(--text-muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    <span className="text-sm font-medium text-[var(--text-primary)]">Task Description</span>
                    <svg 
                        className={`w-4 h-4 text-[var(--text-muted)] transition-transform ${isOpen ? 'rotate-180' : ''}`} 
                        fill="none" 
                        viewBox="0 0 24 24" 
                        stroke="currentColor"
                    >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 9l-7 7-7-7" />
                    </svg>
                </div>
                <div className="flex items-center gap-2">
                    {!isEditing && (
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                setIsEditing(true);
                                setIsOpen(true);
                            }}
                            className="btn btn-ghost h-7 px-2 text-xs"
                        >
                            Edit
                        </button>
                    )}
                </div>
            </div>

            {/* Content */}
            {isOpen && (
                <div className="p-4">
                    {isEditing ? (
                        <div className="space-y-3">
                            <textarea
                                value={content}
                                onChange={(e) => setContent(e.target.value)}
                                className="input w-full h-64 font-mono text-sm resize-y"
                                placeholder="# Task Description..."
                            />
                            <div className="flex justify-end gap-2">
                                <button
                                    onClick={handleCancel}
                                    className="btn btn-secondary h-8 px-3 text-sm"
                                    disabled={isSaving}
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleSave}
                                    disabled={isSaving}
                                    className="btn btn-primary h-8 px-3 text-sm"
                                >
                                    {isSaving ? 'Saving...' : 'Save'}
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div className="prose prose-sm max-w-none">
                            <ReactMarkdown>{content}</ReactMarkdown>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
