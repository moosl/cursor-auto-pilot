'use client';

import { useState } from 'react';
import { ThemeToggle } from '@/components/ThemeToggle';
import { ChatSession, ChatStatus } from '@/lib/types';

interface SidebarProps {
    sessions: ChatSession[];
    currentId: string | null;
    onSelect: (id: string) => void;
    onNew: (workdir: string) => void;
    onDelete: (id: string) => void;
    defaultWorkdir: string;
}

function getStatusIcon(status: ChatStatus): React.ReactNode {
    switch (status) {
        case 'running':
        case 'waiting_response':
            return (
                <span 
                    className="w-2 h-2 rounded-full animate-pulse" 
                    style={{ backgroundColor: '#f59e0b' }}
                    title={`Status: ${status}`} 
                />
            );
        case 'completed':
            return (
                <svg 
                    className="w-3 h-3" 
                    viewBox="0 0 16 16" 
                    fill="none"
                    aria-label={`Status: ${status}`}
                >
                    <path 
                        d="M13.5 4.5L6 12L2.5 8.5" 
                        stroke="#22c55e" 
                        strokeWidth="2" 
                        strokeLinecap="round" 
                        strokeLinejoin="round"
                    />
                </svg>
            );
        case 'error':
            return (
                <span 
                    className="w-2 h-2 rounded-full" 
                    style={{ backgroundColor: '#ef4444' }}
                    title={`Status: ${status}`} 
                />
            );
        default:
            return (
                <span 
                    className="w-2 h-2 rounded-full" 
                    style={{ backgroundColor: '#a1a1aa' }}
                    title={`Status: ${status || 'idle'}`} 
                />
            );
    }
}

export function Sidebar({ sessions, currentId, onSelect, onNew, onDelete, defaultWorkdir }: SidebarProps) {
    const [showNewChatModal, setShowNewChatModal] = useState(false);
    const [newChatWorkdir, setNewChatWorkdir] = useState(defaultWorkdir);

    const handleDelete = (e: React.MouseEvent, id: string) => {
        e.stopPropagation(); // Prevent selecting the session
        if (confirm('Delete this chat? This cannot be undone.')) {
            onDelete(id);
        }
    };

    const handleNewChat = () => {
        setNewChatWorkdir(defaultWorkdir);
        setShowNewChatModal(true);
    };

    const handleCreateChat = () => {
        if (newChatWorkdir.trim()) {
            onNew(newChatWorkdir.trim());
            setShowNewChatModal(false);
        }
    };

    return (
        <>
        {/* New Chat Modal */}
        {showNewChatModal && (
            <div className="fixed inset-0 z-50 flex items-center justify-center overlay">
                <div className="bg-[var(--bg-primary)] w-[450px] rounded-xl border shadow-xl overflow-hidden">
                    <div className="flex items-center justify-between px-5 py-4 border-b">
                        <h3 className="font-semibold text-[var(--text-primary)]">New Chat</h3>
                        <button
                            onClick={() => setShowNewChatModal(false)}
                            className="btn btn-ghost h-8 w-8 p-0"
                        >
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    </div>
                    <div className="p-5">
                        <label className="block text-sm font-medium text-[var(--text-secondary)] mb-2">
                            Project Directory
                        </label>
                        <input
                            type="text"
                            value={newChatWorkdir}
                            onChange={(e) => setNewChatWorkdir(e.target.value)}
                            placeholder="/path/to/your/project"
                            className="input w-full font-mono text-sm"
                            autoFocus
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    handleCreateChat();
                                } else if (e.key === 'Escape') {
                                    setShowNewChatModal(false);
                                }
                            }}
                        />
                        <p className="text-xs text-[var(--text-muted)] mt-2">
                            Enter the path to your project folder. Cursor Agent will work in this directory.
                        </p>
                    </div>
                    <div className="flex justify-end gap-2 px-5 py-4 border-t bg-[var(--bg-secondary)]">
                        <button
                            onClick={() => setShowNewChatModal(false)}
                            className="btn btn-secondary"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleCreateChat}
                            disabled={!newChatWorkdir.trim()}
                            className="btn btn-primary"
                        >
                            Create Chat
                        </button>
                    </div>
                </div>
            </div>
        )}
        <aside className="w-64 h-full flex flex-col border-r bg-[var(--bg-secondary)]">
            {/* Header / Title */}
            <div className="h-14 flex items-center px-4 border-b">
                <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-lg bg-[var(--accent)] flex items-center justify-center">
                        <svg className="w-4 h-4 text-[var(--accent-foreground)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                        </svg>
                    </div>
                    <span className="font-semibold text-[var(--text-primary)]">CursorPilot</span>
                </div>
            </div>

            {/* New Chat Button */}
            <div className="p-3">
                <button
                    onClick={handleNewChat}
                    className="w-full btn btn-secondary h-9 text-sm justify-start gap-2"
                >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
                    </svg>
                    New Chat
                </button>
            </div>

            {/* Chat List */}
            <div className="flex-1 overflow-y-auto px-2 pt-3 pb-3">
                {sessions.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-8 text-center">
                        <div className="w-10 h-10 rounded-full bg-[var(--bg-tertiary)] flex items-center justify-center mb-3">
                            <svg className="w-5 h-5 text-[var(--text-muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                            </svg>
                        </div>
                        <p className="text-sm text-[var(--text-muted)]">No chats yet</p>
                        <p className="text-xs text-[var(--text-muted)] mt-1">Start a new conversation</p>
                    </div>
                ) : (
                    <div className="space-y-0.5">
                        {sessions.map((session) => (
                            <div
                                key={session.id}
                                onClick={() => onSelect(session.id)}
                                className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-all group cursor-pointer ${
                                    session.workdirMissing
                                        ? 'border border-[var(--destructive)]/30 bg-[var(--destructive)]/5'
                                        : ''
                                } ${session.id === currentId
                                        ? 'bg-[var(--bg-tertiary)]'
                                        : 'hover:bg-[var(--bg-tertiary)]/50'
                                    }`}
                            >
                                <div className="flex items-center gap-2.5">
                                    <span
                                        className="shrink-0 inline-flex items-center justify-center w-3 h-3"
                                        title={session.status === 'error' && session.errorMessage 
                                            ? `Error: ${session.errorMessage}` 
                                            : session.status}
                                    >
                                        {session.workdirMissing ? (
                                            <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: '#ef4444' }} />
                                        ) : (
                                            getStatusIcon(session.status)
                                        )}
                                    </span>
                                    <span className={`truncate flex-1 text-[var(--text-primary)] ${session.workdirMissing ? 'line-through opacity-50' : ''}`}>
                                        {session.title || 'New Chat'}
                                    </span>
                                    {/* Delete button - visible on hover */}
                                    <button
                                        onClick={(e) => handleDelete(e, session.id)}
                                        className="opacity-0 group-hover:opacity-100 p-1 rounded-md hover:bg-[var(--bg-primary)] transition-all text-[var(--text-muted)] hover:text-[var(--destructive)]"
                                        title="Delete chat"
                                    >
                                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                        </svg>
                                    </button>
                                </div>
                                {session.workdirMissing && (
                                    <div className="text-[10px] mt-1 text-[var(--destructive)] ml-[18px]">
                                        Project folder deleted
                                    </div>
                                )}
                                {!session.workdirMissing && session.orchestrateTaskId && (
                                    <div className="text-[10px] mt-0.5 text-[var(--text-muted)] ml-[18px]">
                                        via Orchestrator
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Footer */}
            <div className="p-3 border-t flex items-center justify-between">
                <ThemeToggle />
                <span className="text-xs text-[var(--text-muted)]">v0.2</span>
            </div>
        </aside>
        </>
    );
}
