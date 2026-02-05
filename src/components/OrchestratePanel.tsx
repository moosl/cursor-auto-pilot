'use client';

import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { OrchestrateMessage, LogEntry, ChatStatus } from '@/lib/types';
import { generateId } from '@/lib/utils/id';

// Fixed session ID for the web orchestrator panel
const ORCHESTRATOR_SESSION_ID = 'web_orchestrator_main';
const MAX_HISTORY_MESSAGES = 20;

interface OrchestrateEvent {
    type:
    | 'thinking'
    | 'message'
    | 'tool_start'
    | 'tool_end'
    | 'cursor_progress'
    | 'dispatch_order'
    | 'chat_created'
    | 'chat_update'
    | 'chat_complete'
    | 'result'
    | 'error';
    content?: string;
    chatId?: string;
    chatStatus?: ChatStatus;
    success?: boolean;
    tasks_executed?: number;
    error?: string;
}

interface OrchestratePanelProps {
    isOpen: boolean;
    onClose: (lastCreatedChatId?: string) => void; // Pass last created chat ID when closing
    workdir: string;
    onChatCreated: (chatId: string, title: string, task: string, taskMd?: string, chatWorkdir?: string) => void;
    onChatUpdate: (chatId: string, status: ChatStatus, messageContent?: string, messageType?: 'cursor_response' | 'ai_followup', errorMessage?: string) => void;
    skillsPath?: string;
    onOpenSettings?: () => void;
}

export function OrchestratePanel({
    isOpen,
    onClose,
    workdir,
    onChatCreated,
    onChatUpdate,
    skillsPath,
    onOpenSettings,
}: OrchestratePanelProps) {
    const [messages, setMessages] = useState<OrchestrateMessage[]>([]);
    const [input, setInput] = useState('');
    const [isRunning, setIsRunning] = useState(false);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    // Track created chat IDs to avoid duplicates
    const createdChatIds = useRef<Set<string>>(new Set());
    // Track the last created chat ID for auto-activation on close
    const lastCreatedChatId = useRef<string | null>(null);
    const abortControllerRef = useRef<AbortController | null>(null);
    // Track if we've loaded history
    const hasLoadedHistory = useRef(false);

    // Track last known message count for polling
    const lastMessageCount = useRef<number>(0);

    // Load orchestrator messages history from server
    const loadHistory = async (isPolling = false) => {
        try {
            // Load from the dedicated orchestrator session
            if (!isPolling) {
                console.log(`[OrchestratePanel] Loading history for chatId=${ORCHESTRATOR_SESSION_ID}`);
            }
            const response = await fetch(`/api/chat-status?chatId=${ORCHESTRATOR_SESSION_ID}`);
            
            if (!response.ok) {
                if (!isPolling) {
                    console.log(`[OrchestratePanel] Response not ok: ${response.status}`);
                }
                return;
            }
            
            const data = await response.json();
            
            if (data.messages && data.messages.length > 0) {
                // Only update if there are new messages (or first load)
                if (!isPolling || data.messages.length > lastMessageCount.current) {
                    // Get last N messages
                    const recentMessages = data.messages.slice(-MAX_HISTORY_MESSAGES);
                    
                    const historyMessages: OrchestrateMessage[] = recentMessages.map(
                        (msg: { id: string; role: string; content: string; timestamp: string }) => ({
                            id: msg.id,
                            role: msg.role === 'system' ? 'status' : msg.role,
                            content: msg.content,
                            timestamp: new Date(msg.timestamp),
                        })
                    );
                    
                    if (!isPolling) {
                        console.log(`[OrchestratePanel] Setting ${historyMessages.length} messages`);
                    }
                    lastMessageCount.current = data.messages.length;
                    setMessages(historyMessages);
                }
            } else if (!isPolling) {
                console.log(`[OrchestratePanel] No messages found or error:`, data.error);
            }
        } catch (e) {
            if (!isPolling) {
                console.error('[OrchestratePanel] Failed to load history:', e);
            }
        }
    };

    // Load history on mount
    useEffect(() => {
        if (hasLoadedHistory.current) return;
        hasLoadedHistory.current = true;
        loadHistory();
    }, []);

    // Poll for new messages when panel is open (for Telegram messages)
    useEffect(() => {
        if (!isOpen) return;
        
        // Poll every 3 seconds when panel is open
        const pollInterval = setInterval(() => {
            if (!isRunning) {
                loadHistory(true);
            }
        }, 3000);
        
        // Also load immediately when panel opens
        loadHistory(true);
        
        return () => clearInterval(pollInterval);
    }, [isOpen, isRunning]);

    // Scroll to bottom when panel opens or messages change
    useEffect(() => {
        if (isOpen) {
            // Use setTimeout to ensure DOM is updated
            setTimeout(() => {
                messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
            }, 100);
        }
    }, [isOpen]);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    const textareaRef = useRef<HTMLTextAreaElement>(null);

    const handleSubmit = async () => {
        if (!input.trim() || isRunning) return;

        const userMessage = input.trim(); // Trim whitespace from both ends
        setInput('');
        // Reset textarea height to default
        if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
        }
        setIsRunning(true);

        // Setup abort controller
        const controller = new AbortController();
        abortControllerRef.current = controller;

        // Add user message
        const userMsg: OrchestrateMessage = {
            id: generateId(),
            role: 'user',
            content: userMessage,
            timestamp: new Date(),
        };
        setMessages((prev) => [...prev, userMsg]);

        // Track current assistant message ID for updates
        let currentAssistantMsgId: string | null = null;

        try {
            const response = await fetch('/api/orchestrate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    request: userMessage, 
                    workdir, 
                    skillsPath,
                    chatId: ORCHESTRATOR_SESSION_ID, // Save to dedicated session
                }),
                signal: controller.signal,
            });

            if (!response.ok) throw new Error('Orchestrate request failed');

            const reader = response.body?.getReader();
            if (!reader) throw new Error('No response body');

            const decoder = new TextDecoder();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const text = decoder.decode(value);
                const lines = text.split('\n').filter((line) => line.startsWith('data: '));

                for (const line of lines) {
                    try {
                        const event: OrchestrateEvent = JSON.parse(line.slice(6));

                        if (event.type === 'message') {
                            const newContent = event.content || '';

                            setMessages((prev) => {
                                // Find current assistant message or create new one
                                if (currentAssistantMsgId) {
                                    // Append to existing message
                                    return prev.map((m) =>
                                        m.id === currentAssistantMsgId
                                            ? { ...m, content: m.content + newContent }
                                            : m
                                    );
                                } else {
                                    // Create new assistant message
                                    const newId = generateId();
                                    currentAssistantMsgId = newId;
                                    return [
                                        ...prev,
                                        {
                                            id: newId,
                                            role: 'assistant' as const,
                                            content: newContent,
                                            timestamp: new Date(),
                                        },
                                    ];
                                }
                            });
                        } else if (event.type === 'tool_start') {
                            // Reset assistant message tracking when a tool starts
                            currentAssistantMsgId = null;

                            setMessages((prev) => [
                                ...prev,
                                {
                                    id: generateId(),
                                    role: 'status' as const,
                                    content: `Executing: ${event.content}`,
                                    timestamp: new Date(),
                                    subContent: [],
                                },
                            ]);
                        } else if (event.type === 'tool_end') {
                            // Reset assistant message tracking when a tool ends
                            currentAssistantMsgId = null;
                        } else if (event.type === 'chat_created') {
                            // Only handle chat_created, ignore dispatch_order to avoid duplicates
                            try {
                                const { task, title, chatId, taskMd } = JSON.parse(event.content || '{}');

                                // Use chatId from content (same as event.chatId)
                                const finalChatId = chatId || event.chatId;

                                // Check if we've already created this chat
                                if (finalChatId && !createdChatIds.current.has(finalChatId)) {
                                    createdChatIds.current.add(finalChatId);
                                    // Track the last created chat for auto-activation
                                    lastCreatedChatId.current = finalChatId;

                                    setMessages((prev) => [
                                        ...prev,
                                        {
                                            id: generateId(),
                                            role: 'status' as const,
                                            content: `Creating chat: ${title}`,
                                            timestamp: new Date(),
                                        },
                                    ]);

                                    // Notify parent to create chat with taskMd and workdir
                                    onChatCreated(finalChatId, title, task, taskMd, workdir);
                                }
                            } catch (e) {
                                console.error('Parse error', e);
                            }
                        } else if (event.type === 'dispatch_order') {
                            // dispatch_order is handled by chat_created, skip to avoid duplicates
                            // But if chat_created wasn't sent, handle it here
                            try {
                                const { task, title, chatId } = JSON.parse(event.content || '{}');

                                if (chatId && !createdChatIds.current.has(chatId)) {
                                    createdChatIds.current.add(chatId);
                                    // Track the last created chat for auto-activation
                                    lastCreatedChatId.current = chatId;

                                    setMessages((prev) => [
                                        ...prev,
                                        {
                                            id: generateId(),
                                            role: 'status' as const,
                                            content: `Creating chat: ${title}`,
                                            timestamp: new Date(),
                                        },
                                    ]);

                                    onChatCreated(chatId, title, task, undefined, workdir);
                                }
                            } catch (e) {
                                console.error('Parse error', e);
                            }
                        } else if (event.type === 'chat_update') {
                            try {
                                const updateData = JSON.parse(event.content || '{}');

                                // Pass messages to the chat display based on type
                                if (event.chatId) {
                                    if (updateData.type === 'cursor_response' && updateData.content) {
                                        // Cursor's response
                                        onChatUpdate(event.chatId, event.chatStatus || 'running', updateData.content, 'cursor_response');
                                    } else if (updateData.type === 'ai_followup' && updateData.content) {
                                        // Agent Manager's verification question
                                        onChatUpdate(event.chatId, event.chatStatus || 'running', updateData.content, 'ai_followup');
                                    } else if (event.chatStatus) {
                                        // Status update only
                                        onChatUpdate(event.chatId, event.chatStatus);
                                    }
                                }
                            } catch {
                                // Ignore
                            }
                        } else if (event.type === 'chat_complete') {
                            try {
                                const { chatId, success, turns, error } = JSON.parse(event.content || '{}');
                                setMessages((prev) => [
                                    ...prev,
                                    {
                                        id: generateId(),
                                        role: 'status' as const,
                                        content: success
                                            ? `Chat completed (${turns} turns)`
                                            : `Chat needs attention${error ? `: ${error}` : ''}`,
                                        timestamp: new Date(),
                                    },
                                ]);

                                if (chatId) {
                                    onChatUpdate(chatId, success ? 'completed' : 'error', undefined, undefined, error);
                                }
                            } catch {
                                // Ignore
                            }
                        } else if (event.type === 'cursor_progress') {
                            try {
                                const progressData = JSON.parse(event.content || '{}');
                                setMessages((prev) => {
                                    const newMessages = [...prev];
                                    // Find the last status message
                                    for (let i = newMessages.length - 1; i >= 0; i--) {
                                        if (newMessages[i].role === 'status') {
                                            const subContent = newMessages[i].subContent || [];
                                            const lastSub = subContent[subContent.length - 1];

                                            if (
                                                lastSub &&
                                                lastSub.type === progressData.type &&
                                                progressData.type !== 'tool_call'
                                            ) {
                                                // Append to last sub-content of same type
                                                const updatedSubContent = [...subContent];
                                                updatedSubContent[updatedSubContent.length - 1] = {
                                                    ...lastSub,
                                                    content: lastSub.content + (progressData.content || ''),
                                                };
                                                newMessages[i] = {
                                                    ...newMessages[i],
                                                    subContent: updatedSubContent,
                                                };
                                            } else {
                                                // Add new sub-content
                                                newMessages[i] = {
                                                    ...newMessages[i],
                                                    subContent: [
                                                        ...subContent,
                                                        {
                                                            type: progressData.type || 'status',
                                                            content: progressData.content || '',
                                                        },
                                                    ],
                                                };
                                            }
                                            break;
                                        }
                                    }
                                    return newMessages;
                                });
                            } catch {
                                // Ignore
                            }
                        } else if (event.type === 'result') {
                            // Reset tracking
                            currentAssistantMsgId = null;

                            setMessages((prev) => [
                                ...prev,
                                {
                                    id: generateId(),
                                    role: 'status' as const,
                                    content: event.success
                                        ? `Orchestration complete (${event.tasks_executed} tasks)`
                                        : `Failed: ${event.error}`,
                                    timestamp: new Date(),
                                },
                            ]);
                        } else if (event.type === 'error') {
                            currentAssistantMsgId = null;

                            setMessages((prev) => [
                                ...prev,
                                {
                                    id: generateId(),
                                    role: 'status' as const,
                                    content: `Error: ${event.error}`,
                                    timestamp: new Date(),
                                },
                            ]);
                        }
                    } catch {
                        // Ignore parse errors
                    }
                }
            }
        } catch (err: unknown) {
            if ((err as Error).name === 'AbortError') {
                setMessages((prev) => [
                    ...prev,
                    {
                        id: generateId(),
                        role: 'status' as const,
                        content: 'Orchestration interrupted',
                        timestamp: new Date(),
                    },
                ]);
            } else {
                setMessages((prev) => [
                    ...prev,
                    {
                        id: generateId(),
                        role: 'status' as const,
                        content: `Error: ${err instanceof Error ? err.message : String(err)}`,
                        timestamp: new Date(),
                    },
                ]);
            }
        } finally {
            setIsRunning(false);
            abortControllerRef.current = null;
            // Clear created chat IDs for next request
            createdChatIds.current.clear();
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center overlay">
            <div className="bg-[var(--bg-primary)] w-[800px] h-[600px] rounded-xl flex flex-col overflow-hidden border shadow-xl">
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b bg-[var(--bg-primary)]">
                    <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-[var(--accent)] flex items-center justify-center">
                            <svg className="w-4 h-4 text-[var(--accent-foreground)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                            </svg>
                        </div>
                        <div>
                            <h2 className="font-semibold text-[var(--text-primary)]">
                                Orchestrator
                            </h2>
                            <p className="text-xs text-[var(--text-muted)] max-w-[280px]">
                                AI-managed task execution
                            </p>
                        </div>
                    </div>
                    <div className="flex items-center gap-3">
                        {/* Show current workdir - clickable to open settings */}
                        <button
                            onClick={onOpenSettings}
                            className="text-xs text-[var(--text-muted)] font-mono bg-[var(--bg-secondary)] px-2 py-1 rounded hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-secondary)] transition-colors cursor-pointer"
                            title="Click to change working directory"
                        >
                            {workdir}
                        </button>
                        <button
                            onClick={() => onClose(lastCreatedChatId.current || undefined)}
                            className="btn btn-ghost h-8 w-8 p-0"
                        >
                            <svg
                                className="w-4 h-4"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={1.5}
                                    d="M6 18L18 6M6 6l12 12"
                                />
                            </svg>
                        </button>
                    </div>
                </div>

                {/* Messages */}
                <div className="flex-1 overflow-y-auto p-5 space-y-3">
                    {messages.length === 0 && (
                        <div className="flex items-center justify-center h-full">
                            <div className="text-center max-w-sm">
                                <div className="w-12 h-12 rounded-full bg-[var(--bg-tertiary)] flex items-center justify-center mx-auto mb-4">
                                    <svg className="w-6 h-6 text-[var(--text-muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
                                    </svg>
                                </div>
                                <h3 className="text-base font-medium text-[var(--text-primary)] mb-2">AI Task Orchestrator</h3>
                                <p className="text-sm text-[var(--text-muted)] mb-3">
                                    Describe what you want to build or accomplish. The Orchestrator will:
                                </p>
                                <ul className="text-sm text-[var(--text-muted)] text-left space-y-1">
                                    <li>• Analyze and break down complex tasks</li>
                                    <li>• Create subtask chats automatically</li>
                                    <li>• Manage Cursor Agent conversations</li>
                                    <li>• Track progress until completion</li>
                                </ul>
                            </div>
                        </div>
                    )}

                    {messages.map((msg) => (
                        <div
                            key={msg.id}
                            className={`flex ${msg.role === 'user'
                                ? 'justify-end'
                                : 'justify-start'
                                }`}
                        >
                            {msg.role === 'status' ? (
                                <div className="inline-flex items-center gap-2 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50 rounded-full px-3 py-1.5 text-xs text-amber-700 dark:text-amber-400">
                                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                    </svg>
                                    <span className="font-medium">{msg.content}</span>
                                    <span className="opacity-60">
                                        {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                    </span>
                                </div>
                            ) : (
                                <div
                                    className={`max-w-[80%] rounded-lg px-4 py-3 ${msg.role === 'user'
                                        ? 'bg-[var(--accent)] text-[var(--accent-foreground)] user-message-content'
                                        : 'bg-[var(--bg-secondary)] border'
                                        }`}
                                >
                                    {msg.role === 'assistant' ? (
                                        <>
                                            <div className="flex items-center gap-2 mb-2">
                                                <span className="text-xs font-medium text-[var(--text-muted)]">Orchestrator</span>
                                                <span className="text-xs text-[var(--text-muted)]">
                                                    {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                                </span>
                                            </div>
                                            <div className="prose prose-sm max-w-none">
                                                <ReactMarkdown>{msg.content}</ReactMarkdown>
                                            </div>
                                        </>
                                    ) : msg.role === 'user' ? (
                                        <>
                                            <div className="flex items-center justify-end gap-2 mb-1">
                                                <span className="text-xs font-medium opacity-80">You</span>
                                                <span className="text-xs opacity-60">
                                                    {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                                </span>
                                            </div>
                                            <p className="whitespace-pre-wrap text-sm">{msg.content}</p>
                                        </>
                                    ) : (
                                        <p className="whitespace-pre-wrap text-sm">{msg.content}</p>
                                    )}
                                </div>
                            )}
                        </div>
                    ))}

                    {isRunning && (
                        <div className="flex justify-start">
                            <div className="bg-[var(--bg-secondary)] rounded-lg px-4 py-3 border">
                                <div className="flex items-center gap-1">
                                    <span className="w-1.5 h-1.5 bg-[var(--text-muted)] rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                                    <span className="w-1.5 h-1.5 bg-[var(--text-muted)] rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                                    <span className="w-1.5 h-1.5 bg-[var(--text-muted)] rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                                </div>
                            </div>
                        </div>
                    )}

                    <div ref={messagesEndRef} />
                </div>

                {/* Input */}
                <div className="px-5 py-4 border-t bg-[var(--bg-primary)]">
                    <div className="flex items-end gap-2">
                        <textarea
                            ref={textareaRef}
                            value={input}
                            onChange={(e) => {
                                setInput(e.target.value);
                                // Auto-resize textarea
                                e.target.style.height = 'auto';
                                e.target.style.height = Math.min(e.target.scrollHeight, 200) + 'px';
                            }}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && e.shiftKey) {
                                    e.preventDefault();
                                    handleSubmit();
                                }
                            }}
                            placeholder="Describe a complex development task..."
                            className="input flex-1 resize-none min-h-[44px] max-h-[200px] py-3"
                            disabled={isRunning}
                            rows={1}
                        />
                        {isRunning ? (
                            <button
                                onClick={() => {
                                    abortControllerRef.current?.abort();
                                }}
                                className="btn btn-destructive h-11 px-4"
                            >
                                Stop
                            </button>
                        ) : (
                            <button
                                onClick={handleSubmit}
                                disabled={!input.trim()}
                                className="btn btn-primary h-11 px-4"
                            >
                                Execute
                            </button>
                        )}
                    </div>
                    <p className="text-xs text-[var(--text-muted)] mt-2">Press Shift+Enter to send</p>
                </div>
            </div>
        </div>
    );
}
