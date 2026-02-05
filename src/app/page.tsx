'use client';

import { useChat } from '@ai-sdk/react';
import { useRef, useEffect, useState, useCallback, useMemo, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { StreamdownDisplay } from '@/components/StreamdownDisplay';
import 'katex/dist/katex.min.css';

import { Sidebar } from '@/components/Sidebar';
import { OrchestratePanel } from '@/components/OrchestratePanel';
import { MentionInput } from '@/components/MentionInput';
import { TaskEditor } from '@/components/TaskEditor';
import { SettingsPanel, AppSettings, getStoredSettings, saveSettings } from '@/components/SettingsPanel';
import { ChatSession, ChatStatus } from '@/lib/types';
import { generateId } from '@/lib/utils/id';
import { isManualChat, isOrchestratorMain, isOrchestratorSubtask } from '@/lib/utils/session';

// Message type for display
interface DisplayMessage {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: Date;
    metadata?: { source?: 'agent_manager' | 'orchestrator' | 'user' | 'cursor' | 'thinking' };
}

const SESSION_MESSAGE_LIMIT = 50;
const STORAGE_MESSAGE_LIMIT = 50;
const STORAGE_SAVE_DEBOUNCE_MS = 500;
const ORCHESTRATOR_POLL_LIMIT = 50;
const SUBTASK_POLL_LIMIT = 200;
const SUBTASK_INITIAL_TAIL = 200;

// Loading spinner component
function LoadingSpinner() {
    return (
        <div className="p-4 h-screen">
            <div className="flex h-full items-center justify-center bg-[var(--bg-primary)] rounded-xl border border-[var(--border)] shadow-[var(--app-shadow)]">
                <div className="flex items-center gap-3">
                    <svg className="animate-spin h-5 w-5 text-[var(--text-muted)]" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    <span className="text-sm text-[var(--text-muted)]">Loading...</span>
                </div>
            </div>
        </div>
    );
}

// Wrap the main component to use Suspense for useSearchParams
export default function Home() {
    return (
        <Suspense fallback={<LoadingSpinner />}>
            <HomeContent />
        </Suspense>
    );
}

function HomeContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    
    // Chat sessions state
    const [sessions, setSessions] = useState<ChatSession[]>([]);
    const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
    const [pendingManualMessage, setPendingManualMessage] = useState<{ chatId: string; content: string } | null>(null);

    // Orchestrate panel state
    const [isOrchestrateOpen, setIsOrchestrateOpen] = useState(false);
    
    // Settings state
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [settings, setSettings] = useState<AppSettings>(() => getStoredSettings());
    const workdir = settings.workdir;
    
    // Hydrate settings from server defaults (fills blanks / supports cross-device)
    useEffect(() => {
        const controller = new AbortController();
        (async () => {
            try {
                const res = await fetch('/api/settings', { signal: controller.signal });
                if (!res.ok) return;
                const serverSettings = (await res.json()) as AppSettings;
                
                setSettings((prev) => {
                    const merged: AppSettings = {
                        workdir: prev.workdir || serverSettings.workdir,
                        skillsPath: prev.skillsPath || serverSettings.skillsPath,
                        model: prev.model || serverSettings.model,
                    };
                    
                    if (merged.workdir === prev.workdir && merged.skillsPath === prev.skillsPath && merged.model === prev.model) {
                        return prev;
                    }
                    
                    saveSettings(merged);
                    return merged;
                });
            } catch {
                // Ignore
            }
        })();
        return () => controller.abort();
    }, []);

    // For orchestrator-managed chats, we track messages separately
    const [orchestratorMessages, setOrchestratorMessages] = useState<Map<string, DisplayMessage[]>>(new Map());

    // Track message counts to detect new messages during polling
    const lastMessageCounts = useRef<Map<string, number>>(new Map());

    // Check if current session is a main orchestrator conversation (e.g., Telegram)
    // Sub-tasks have orchestrateTaskId but NOT isOrchestratorManaged, so they allow input
    const currentSession = sessions.find((s) => s.id === currentSessionId);
    const isOrchestratorManaged = isOrchestratorMain(currentSession);

    // System status for monitoring active Cursor calls
    const [systemStatus, setSystemStatus] = useState<{
        activeCursorCalls: { count: number; calls: Array<{ id: string; chatTitle?: string; task: string; durationMs: number }> };
    } | null>(null);
    const [isStatusExpanded, setIsStatusExpanded] = useState(false);

    // Chat hook for manual chats only
    const { messages, input, handleInputChange, handleSubmit, isLoading, error, setMessages, append, status, stop } =
        useChat({
            api: '/api/chat',
            id: currentSessionId || undefined,
            body: {
                // Pass workdir - backend will prefer session's workdir if set
                workdir: currentSession?.workdir || workdir,
            },
            onFinish: (message) => {
                // Clear waiting state when response is received
                setIsWaitingForResponse(false);
                
                if (currentSessionId && message.role === 'assistant' && !isOrchestratorManaged) {
                    setSessions((prev) =>
                        prev.map((s) => {
                            if (s.id === currentSessionId && s.title === 'New Chat') {
                                const title =
                                    message.content.slice(0, 50) + (message.content.length > 50 ? '...' : '');
                                return { ...s, title };
                            }
                            return s;
                        })
                    );
                }

                // Ensure status goes idle after manual chat finishes
                if (currentSessionId && !isOrchestratorManaged) {
                    setSessions((prev) =>
                        prev.map((s) => (s.id === currentSessionId ? { ...s, status: 'idle' } : s))
                    );
                }
            },
            onError: () => {
                // Clear waiting state on error too
                setIsWaitingForResponse(false);
            },
        });

    type ChatUiMessage = (typeof messages)[number];
    type ChatUiMessageWithMetadata = ChatUiMessage & {
        metadata?: { source?: 'agent_manager' | 'orchestrator' | 'user' | 'cursor' | 'thinking' };
    };

    // Handle stop/abort for current chat
    const handleStopChat = useCallback(async () => {
        // Stop the streaming response from useChat
        stop();
        
        // If it's an orchestrator-managed session, also try to abort on server
        if (currentSessionId && (isOrchestratorManaged || currentSession?.orchestrateTaskId)) {
            try {
                await fetch('/api/chat/abort', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chatId: currentSessionId }),
                });
                
                // Update session status
                setSessions((prev) =>
                    prev.map((s) =>
                        s.id === currentSessionId ? { ...s, status: 'idle' } : s
                    )
                );
            } catch (e) {
                console.error('Failed to abort chat:', e);
            }
        }
    }, [stop, currentSessionId, isOrchestratorManaged, currentSession?.orchestrateTaskId]);

    const messagesEndRef = useRef<HTMLDivElement>(null);
    const saveSessionsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const saveOrchestratorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Load sessions from server and localStorage on mount
    useEffect(() => {
        const loadSessions = async () => {
            // Check URL for chatId parameter
            const urlChatId = searchParams.get('chat');
            
            // First try to load from server (includes Telegram sessions)
            try {
                const response = await fetch(`/api/sessions?messageLimit=${SESSION_MESSAGE_LIMIT}`);
                if (response.ok) {
                    const data = await response.json();
                    if (data.sessions && data.sessions.length > 0) {
                        const restored = data.sessions.map((s: { id: string; createdAt: string | Date; messages: Array<{ timestamp: string | Date }> }) => ({
                            ...s,
                            createdAt: new Date(s.createdAt),
                            messages: (s.messages || []).map((m) => ({
                                ...m,
                                timestamp: new Date(m.timestamp),
                            })),
                        }));
                        console.log('[loadSessions] Restored sessions from server', restored.map((s: { id: string; title?: string; messages?: unknown[] }) => ({
                            id: s.id,
                            title: s.title,
                            messagesCount: s.messages?.length ?? 0,
                        })));
                        setSessions(restored);
                        
                        // If URL has chatId, select that session and load its messages
                        if (urlChatId) {
                            const urlSession = restored.find((s: { id: string }) => s.id === urlChatId);
                            if (urlSession) {
                                setCurrentSessionId(urlChatId);
                                
                                // Load messages for sub-tasks from server
                                if (urlSession.orchestrateTaskId && !urlSession.isOrchestratorManaged) {
                                    try {
                                        const msgResponse = await fetch(`/api/chat-status?chatId=${urlChatId}&includeMessages=1`);
                                        if (msgResponse.ok) {
                                            const msgData = await msgResponse.json();
                                            if (msgData.messages && msgData.messages.length > 0) {
                                                const messageCount = typeof msgData.messageCount === 'number'
                                                    ? msgData.messageCount
                                                    : msgData.messages.length;
                                                const mapped: ChatUiMessageWithMetadata[] = msgData.messages.map(
                                                    (m: { id: string; role: string; content: string; timestamp: string; metadata?: { source?: 'agent_manager' | 'orchestrator' | 'user' | 'cursor' | 'thinking' } }) => ({
                                                        id: m.id,
                                                        role: m.role as ChatUiMessage['role'],
                                                        content: m.content,
                                                        createdAt: new Date(m.timestamp),
                                                        metadata: m.metadata,
                                                    })
                                                );
                                                setMessages(mapped);
                                                lastMessageCounts.current.set(urlChatId, messageCount);
                                            }
                                        }
                                    } catch (e) {
                                        console.error('Failed to load messages for URL session:', e);
                                    }
                                } else if (isManualChat(urlSession) && urlSession.messages?.length > 0) {
                                    // Manual chat - restore from session
                                    setMessages(
                                        urlSession.messages.map((m: { id: string; role: string; content: string; timestamp: Date }) => ({
                                            id: m.id,
                                            role: m.role,
                                            content: m.content,
                                            createdAt: new Date(m.timestamp),
                                        }))
                                    );
                                }
                            }
                        } else if (restored.length > 0 && !currentSessionId) {
                            // Only auto-select non-orchestrator sessions
                            const normalSession = restored.find((s: ChatSession) => isManualChat(s));
                            if (normalSession) {
                                setCurrentSessionId(normalSession.id);
                                // Auto-restore messages for the first manual chat
                                if (normalSession.messages && normalSession.messages.length > 0) {
                                    setMessages(
                                        normalSession.messages.map(
                                            (m: { id: string; role: string; content: string; timestamp: string | Date }) => ({
                                                id: m.id,
                                                role: m.role as ChatUiMessage['role'],
                                                content: m.content,
                                                createdAt: new Date(m.timestamp),
                                            })
                                        )
                                    );
                                }
                            }
                            // If only orchestrator sessions exist, don't auto-select any
                        }
                        
                        // Check if there are any sidebar-visible sessions (subtasks or manual chats)
                        const sidebarVisibleSessions = restored.filter((s: ChatSession) => !isOrchestratorMain(s));
                        if (sidebarVisibleSessions.length === 0) {
                            // No subtasks or manual chats - auto-open Orchestrator
                            setIsOrchestrateOpen(true);
                        }
                        
                        // Also populate orchestrator messages for orchestrator-managed sessions
                        const newOrchestratorMsgs = new Map<string, DisplayMessage[]>();
                        for (const session of restored) {
                            // Check both orchestrateTaskId and isOrchestratorManaged (for Telegram sessions)
                            const isOrchManaged = session.orchestrateTaskId || session.isOrchestratorManaged;
                            if (isOrchManaged && session.messages.length > 0) {
                                newOrchestratorMsgs.set(session.id, session.messages.map((m: { id: string; role: string; content: string; timestamp: Date }) => ({
                                    id: m.id,
                                    role: m.role as 'user' | 'assistant' | 'system',
                                    content: m.content,
                                    timestamp: m.timestamp,
                                })));
                            }
                        }
                        if (newOrchestratorMsgs.size > 0) {
                            setOrchestratorMessages(prev => {
                                const merged = new Map(prev);
                                newOrchestratorMsgs.forEach((value, key) => {
                                    if (!merged.has(key) || merged.get(key)!.length < value.length) {
                                        merged.set(key, value);
                                    }
                                });
                                return merged;
                            });
                        }
                        return; // Server data loaded successfully
                    }
                }
            } catch (e) {
                console.error('Failed to load sessions from server:', e);
            }
            
            // Fall back to localStorage
            const saved = localStorage.getItem('cursor-pilot-sessions');
            if (saved) {
                try {
                    const parsed = JSON.parse(saved);
                    const restored = parsed.map((s: { createdAt: string | Date; messages: Array<{ timestamp: string | Date }> }) => ({
                        ...s,
                        createdAt: new Date(s.createdAt),
                        messages: (s.messages || []).map((m) => ({
                            ...m,
                            timestamp: new Date(m.timestamp),
                        })),
                    }));
                    setSessions(restored);
                    if (restored.length > 0) {
                        // Only auto-select non-orchestrator sessions
                        const normalSession = restored.find((s: ChatSession) => isManualChat(s));
                        if (normalSession) {
                            setCurrentSessionId(normalSession.id);
                            // Auto-restore messages for the first manual chat from localStorage
                            if (normalSession.messages && normalSession.messages.length > 0) {
                                setMessages(
                                    normalSession.messages.map(
                                        (m: { id: string; role: string; content: string; timestamp: string | Date }) => ({
                                            id: m.id,
                                            role: m.role as ChatUiMessage['role'],
                                            content: m.content,
                                            createdAt: new Date(m.timestamp),
                                        })
                                    )
                                );
                            }
                        }
                        
                        // Check if there are any sidebar-visible sessions
                        const sidebarVisibleSessions = restored.filter((s: ChatSession) => !isOrchestratorMain(s));
                        if (sidebarVisibleSessions.length === 0) {
                            setIsOrchestrateOpen(true);
                        }
                    } else {
                        // No sessions at all - auto-open Orchestrator
                        setIsOrchestrateOpen(true);
                    }
                } catch (e) {
                    console.error('Failed to load sessions from localStorage:', e);
                    // Error loading - auto-open Orchestrator
                    setIsOrchestrateOpen(true);
                }
            } else {
                // No saved sessions - auto-open Orchestrator
                setIsOrchestrateOpen(true);
            }
            
            // Also load orchestrator messages from localStorage
            const savedOrchestratorMsgs = localStorage.getItem('cursor-pilot-orchestrator-messages');
            if (savedOrchestratorMsgs) {
                try {
                    const parsed = JSON.parse(savedOrchestratorMsgs);
                    const restoredMap = new Map<string, DisplayMessage[]>();
                    for (const [key, msgs] of Object.entries(parsed)) {
                        restoredMap.set(key, (msgs as DisplayMessage[]).map(m => ({
                            ...m,
                            timestamp: new Date(m.timestamp),
                        })));
                    }
                    setOrchestratorMessages(restoredMap);
                } catch (e) {
                    console.error('Failed to load orchestrator messages:', e);
                }
            }
        };
        
        loadSessions();
    }, []);

    // Poll system status for active Cursor calls
    useEffect(() => {
        const fetchStatus = async () => {
            try {
                const res = await fetch('/api/system-status');
                if (res.ok) {
                    const data = await res.json();
                    setSystemStatus(data);
                }
            } catch {
                // Ignore errors
            }
        };
        
        fetchStatus();
        const interval = setInterval(fetchStatus, 3000); // Poll every 3 seconds
        return () => clearInterval(interval);
    }, []);

    // Save sessions to localStorage when changed
    useEffect(() => {
        if (saveSessionsTimeoutRef.current) {
            clearTimeout(saveSessionsTimeoutRef.current);
        }
        if (sessions.length === 0) return;
        
        saveSessionsTimeoutRef.current = setTimeout(() => {
            const trimmedSessions = sessions.map((s) => ({
                ...s,
                messages: Array.isArray(s.messages)
                    ? s.messages.slice(-STORAGE_MESSAGE_LIMIT)
                    : [],
            }));
            localStorage.setItem('cursor-pilot-sessions', JSON.stringify(trimmedSessions));
        }, STORAGE_SAVE_DEBOUNCE_MS);
        
        return () => {
            if (saveSessionsTimeoutRef.current) {
                clearTimeout(saveSessionsTimeoutRef.current);
            }
        };
    }, [sessions]);

    // Save orchestrator messages to localStorage when changed
    useEffect(() => {
        if (saveOrchestratorTimeoutRef.current) {
            clearTimeout(saveOrchestratorTimeoutRef.current);
        }
        if (orchestratorMessages.size === 0) return;
        
        saveOrchestratorTimeoutRef.current = setTimeout(() => {
            const obj: Record<string, DisplayMessage[]> = {};
            orchestratorMessages.forEach((value, key) => {
                obj[key] = value.slice(-STORAGE_MESSAGE_LIMIT);
            });
            localStorage.setItem('cursor-pilot-orchestrator-messages', JSON.stringify(obj));
        }, STORAGE_SAVE_DEBOUNCE_MS);
        
        return () => {
            if (saveOrchestratorTimeoutRef.current) {
                clearTimeout(saveOrchestratorTimeoutRef.current);
            }
        };
    }, [orchestratorMessages]);

    // Auto-scroll to bottom when messages change or session changes
    useEffect(() => {
        // Use setTimeout to ensure DOM is updated after session switch
        setTimeout(() => {
            messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        }, 50);
    }, [messages, orchestratorMessages, currentSessionId]);

    // Send pending manual message after session is created
    useEffect(() => {
        if (!pendingManualMessage || !currentSessionId || isOrchestratorManaged) return;
        if (pendingManualMessage.chatId !== currentSessionId) return;

        append({
            role: 'user',
            content: pendingManualMessage.content,
        });
        setPendingManualMessage(null);
    }, [pendingManualMessage, currentSessionId, isOrchestratorManaged, append]);

    // Sync isLoading status to current session (for sidebar indicator)
    useEffect(() => {
        if (!currentSessionId || isOrchestratorManaged) return;
        
        setSessions((prev) =>
            prev.map((s) => {
                if (s.id === currentSessionId) {
                    const newStatus = isLoading ? 'running' : (s.status === 'running' ? 'idle' : s.status);
                    if (s.status !== newStatus) {
                        return { ...s, status: newStatus };
                    }
                }
                return s;
            })
        );
    }, [isLoading, currentSessionId, isOrchestratorManaged]);

    // Persist latest messages into session state after streaming completes
    useEffect(() => {
        if (!currentSessionId || isOrchestratorManaged) return;
        if (isLoading) return;
        // 如果当前没有 useChat 消息（例如刚刷新页面），不要用空数组把从后端加载的历史消息覆盖掉
        if (messages.length === 0) return;

        setSessions((prev) =>
            prev.map((s) => {
                if (s.id !== currentSessionId) return s;

                const mapped = messages.map((m) => ({
                    id: m.id,
                    role: m.role as 'user' | 'assistant' | 'system',
                    content: m.content,
                    timestamp: (m as { createdAt?: Date }).createdAt || new Date(),
                    metadata: (m as { metadata?: { source?: 'agent_manager' | 'orchestrator' | 'user' | 'cursor' | 'thinking' } }).metadata,
                }));

                const prevLast = s.messages[s.messages.length - 1];
                const nextLast = mapped[mapped.length - 1];
                if (s.messages.length === mapped.length && prevLast?.content === nextLast?.content) {
                    return s;
                }

                return { ...s, messages: mapped };
            })
        );
    }, [messages, isLoading, currentSessionId, isOrchestratorManaged]);

    // Get display messages based on session type
    // 优先使用 session 上从后端加载的 messages，这样刷新后也能还原历史
    // 但是当正在加载时（isLoading），优先使用 useChat 的 messages，因为它包含最新的用户输入
    const displayMessages: DisplayMessage[] = useMemo(() => {
        // 1) Orchestrator 主会话：用 orchestratorMessages
        if (isOrchestratorManaged && currentSessionId) {
            return orchestratorMessages.get(currentSessionId) || [];
        }

        // 2) 如果正在加载（发送/接收消息中），优先使用 useChat 的 messages，因为它包含最新的用户输入
        if (isLoading && messages.length > 0) {
            console.log('[displayMessages] Using useChat messages (loading)', {
                currentSessionId,
                count: messages.length,
            });
            return messages.map((m) => ({
                id: m.id,
                role: m.role as 'user' | 'assistant' | 'system',
                content: m.content,
                timestamp: (m as { createdAt?: Date }).createdAt || new Date(),
                metadata: (m as { metadata?: { source?: 'agent_manager' | 'orchestrator' | 'user' | 'cursor' | 'thinking' } }).metadata,
            }));
        }

        // 3) 任何 session 只要有 session.messages（来自 /api/sessions 的数据），都优先用它
        if (currentSession && Array.isArray((currentSession as any).messages) && (currentSession as any).messages.length > 0) {
            console.log('[displayMessages] Using currentSession.messages', {
                sessionId: currentSession.id,
                count: (currentSession as any).messages.length,
            });
            return (currentSession as any).messages.map((m: any) => ({
                id: m.id,
                role: m.role as 'user' | 'assistant' | 'system',
                content: m.content,
                timestamp: m.timestamp ? new Date(m.timestamp) : new Date(),
                metadata: m.metadata,
            }));
        }

        // 4) 回退：用 useChat 的内存 messages（新会话或 streaming 中）
        console.log('[displayMessages] Using useChat messages', {
            currentSessionId,
            isOrchestratorManaged,
            count: messages.length,
        });
        return messages.map((m) => ({
            id: m.id,
            role: m.role as 'user' | 'assistant' | 'system',
            content: m.content,
            timestamp: (m as { createdAt?: Date }).createdAt || new Date(),
            metadata: (m as { metadata?: { source?: 'agent_manager' | 'orchestrator' | 'user' | 'cursor' | 'thinking' } }).metadata,
        }));
    }, [isOrchestratorManaged, currentSessionId, orchestratorMessages, messages, currentSession, isLoading]);

    const resolveSystemLabel = (msg: DisplayMessage) => {
        const source = msg.metadata?.source;
        if (source === 'thinking') return 'Thinking';
        if (source === 'agent_manager') return 'Agent Manager';
        if (source === 'orchestrator') return 'Orchestrator';

        const trimmed = msg.content.trim();
        if (trimmed.startsWith('🤖') || trimmed.startsWith('✅')) return 'Agent Manager';
        if (isOrchestratorSubtask(currentSession)) return 'Agent Manager';
        return isOrchestratorManaged ? 'Orchestrator' : 'System';
    };
    
    // Check if a message is a thinking message
    const isThinkingMessage = (msg: DisplayMessage) => {
        return msg.metadata?.source === 'thinking';
    };

    // Create a new chat session (manual)
    const createNewSession = useCallback(
        (workdirOrTitle?: string) => {
            // If provided string looks like a path, use it as workdir; otherwise treat as title
            const isPath = workdirOrTitle && (workdirOrTitle.startsWith('/') || workdirOrTitle.startsWith('~'));
            const sessionWorkdir = isPath ? workdirOrTitle : workdir;
            
            // Extract folder name from path for title
            let title = 'New Chat';
            if (isPath && workdirOrTitle) {
                // Remove trailing slashes and get the last part of the path
                const cleanPath = workdirOrTitle.replace(/\/+$/, '');
                const parts = cleanPath.split('/').filter(p => p.length > 0);
                title = parts.length > 0 ? parts[parts.length - 1] : 'New Chat';
            } else if (workdirOrTitle) {
                title = workdirOrTitle;
            }
            
            const newSession: ChatSession = {
                id: generateId(),
                title,
                createdAt: new Date(),
                status: 'idle',
                messages: [],
                workdir: sessionWorkdir, // Store workdir for this session
                // No orchestrateTaskId = manual chat
            };
            setSessions((prev) => [newSession, ...prev]);
            setCurrentSessionId(newSession.id);
            setMessages([]);
            // Update URL with new chat ID
            router.push(`/?chat=${newSession.id}`, { scroll: false });
            
            // Save to server database immediately (fire and forget)
            fetch('/api/sessions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: newSession.id,
                    title: newSession.title,
                    workdir: newSession.workdir,
                }),
            }).catch((e) => {
                console.error('Failed to save session to server:', e);
            });
            
            return newSession.id;
        },
        [setMessages, router, workdir]
    );

    // Select a session
    const selectSession = useCallback(
        async (id: string) => {
            const session = sessions.find((s) => s.id === id);
            if (session) {
                setCurrentSessionId(id);
                // Clear waiting state when switching sessions
                setIsWaitingForResponse(false);
                
                // Update URL with chat ID
                router.push(`/?chat=${id}`, { scroll: false });
                
                if (isOrchestratorSubtask(session)) {
                    console.log(`[selectSession] Selected subtask: id=${id}, status=${session.status}, orchestrateTaskId=${session.orchestrateTaskId}`);
                    
                    // Sub-task - load messages from server
                    try {
                        const response = await fetch(`/api/chat-status?chatId=${id}&includeMessages=1`);
                        if (response.ok) {
                            const data = await response.json();
                            console.log(`[selectSession] Loaded ${data.messages?.length || 0} messages, status=${data.status}`);
                            
                            const messageCount = typeof data.messageCount === 'number'
                                ? data.messageCount
                                : data.messages?.length ?? 0;

                            if (data.messages && data.messages.length > 0) {
                                const mapped: ChatUiMessageWithMetadata[] = data.messages.map(
                                    (m: { id: string; role: string; content: string; timestamp: string; metadata?: { source?: 'agent_manager' | 'orchestrator' | 'user' | 'cursor' | 'thinking' } }) => ({
                                        id: m.id,
                                        role: m.role as ChatUiMessage['role'],
                                        content: m.content,
                                        createdAt: new Date(m.timestamp),
                                        metadata: m.metadata,
                                    })
                                );
                                setMessages(mapped);
                                lastMessageCounts.current.set(id, messageCount);
                            } else {
                                setMessages([]);
                                lastMessageCounts.current.set(id, messageCount);
                            }
                            
                            // Also update session status from server if different
                            if (data.status && data.status !== session.status) {
                                console.log(`[selectSession] Updating session status from ${session.status} to ${data.status}`);
                                setSessions((prev) =>
                                    prev.map((s) => s.id === id ? { ...s, status: data.status } : s)
                                );
                            }
                        }
                    } catch (e) {
                        console.error('Failed to load sub-task messages:', e);
                        setMessages([]);
                    }
                } else if (isManualChat(session)) {
                    // Manual chat - restore from session (messages were loaded via /api/sessions on mount)
                    setMessages(
                        (session.messages || []).map((m) => ({
                            ...m,
                            createdAt: new Date(m.timestamp),
                        }))
                    );
                }
                // For main orchestrator chats (isOrchestratorManaged), messages are in orchestratorMessages
            }
        },
        [sessions, setMessages, router]
    );

    // Delete a session
    const deleteSession = useCallback(
        async (id: string) => {
            try {
                // First, check if this session is running and abort it
                const sessionToDelete = sessions.find((s) => s.id === id);
                if (sessionToDelete && (sessionToDelete.status === 'running' || sessionToDelete.status === 'waiting_response')) {
                    // Abort the running chat first
                    try {
                        await fetch('/api/chat/abort', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ chatId: id }),
                        });
                    } catch (e) {
                        console.error('Failed to abort chat before delete:', e);
                    }
                }
                
                // If this is the current session and using useChat, stop it
                if (id === currentSessionId) {
                    stop();
                }
                
                const response = await fetch(`/api/sessions/${id}`, {
                    method: 'DELETE',
                });
                
                if (response.ok) {
                    // Remove from local state
                    setSessions((prev) => {
                        const filtered = prev.filter((s) => s.id !== id);
                        
                        // Check if there are any sidebar-visible sessions left
                        const sidebarVisible = filtered.filter((s) => !isOrchestratorMain(s));
                        if (sidebarVisible.length === 0) {
                            // No sessions left - auto-open Orchestrator
                            setIsOrchestrateOpen(true);
                        }
                        
                        return filtered;
                    });
                    
                    // Clear orchestrator messages for this session
                    setOrchestratorMessages((prev) => {
                        const newMap = new Map(prev);
                        newMap.delete(id);
                        return newMap;
                    });
                    
                    // Also remove from localStorage
                    const saved = localStorage.getItem('cursor-pilot-sessions');
                    if (saved) {
                        try {
                            const parsed = JSON.parse(saved);
                            const filtered = parsed.filter((s: { id: string }) => s.id !== id);
                            localStorage.setItem('cursor-pilot-sessions', JSON.stringify(filtered));
                        } catch (e) {
                            console.error('Failed to update localStorage:', e);
                        }
                    }
                    
                    // If this was the current session, clear selection and URL
                    if (currentSessionId === id) {
                        setCurrentSessionId(null);
                        setMessages([]);
                        router.push('/', { scroll: false });
                    }
                } else {
                    const errorData = await response.json().catch(() => ({}));
                    console.error('Failed to delete session:', errorData);
                    
                    // Even if server delete fails, remove from local state if session doesn't exist
                    if (response.status === 404) {
                        setSessions((prev) => prev.filter((s) => s.id !== id));
                        if (currentSessionId === id) {
                            setCurrentSessionId(null);
                            setMessages([]);
                            router.push('/', { scroll: false });
                        }
                    }
                }
            } catch (error) {
                console.error('Error deleting session:', error);
            }
        },
        [currentSessionId, setMessages, router, sessions, stop]
    );

    // Handle chat created from orchestrate
    const handleChatCreated = useCallback(
        (chatId: string, title: string, task: string, taskMd?: string, chatWorkdir?: string) => {
            console.log(`[handleChatCreated] Creating subtask session: chatId=${chatId}, title=${title}, workdir=${chatWorkdir || workdir}`);
            
            // Create new session marked as sub-task (orchestrateTaskId set, but NOT isOrchestratorManaged)
            const newSession: ChatSession = {
                id: chatId,
                title,
                createdAt: new Date(),
                status: 'running',
                messages: [],
                orchestrateTaskId: chatId, // Use chatId as orchestrateTaskId for consistency
                taskMd, // Include task.md content
                workdir: chatWorkdir || workdir, // Store workdir for this task
            };
            
            console.log(`[handleChatCreated] New session:`, { id: newSession.id, status: newSession.status, orchestrateTaskId: newSession.orchestrateTaskId, isOrchestratorManaged: newSession.isOrchestratorManaged });
            
            setSessions((prev) => {
                console.log(`[handleChatCreated] Adding session to sessions array. Previous count: ${prev.length}`);
                return [newSession, ...prev];
            });
            setCurrentSessionId(chatId);

            // Set initial user message in useChat messages for display
            // This is a sub-task, so it uses useChat messages (not orchestratorMessages)
            setMessages([
                {
                    id: generateId(),
                    role: 'user',
                    content: task,
                    createdAt: new Date(),
                },
            ]);

            // Initialize message count for polling - use -1 to ensure first poll always triggers update
            // This is important because backend may have more messages than what we display initially
            lastMessageCounts.current.set(chatId, -1);
            
            // Update URL with new chat ID
            router.push(`/?chat=${chatId}`, { scroll: false });
        },
        [setMessages, router]
    );

    // Add a message to orchestrator-managed chat
    const addOrchestratorMessage = useCallback((chatId: string, role: 'user' | 'assistant' | 'system', content: string) => {
        setOrchestratorMessages((prev) => {
            const newMap = new Map(prev);
            const existing = newMap.get(chatId) || [];
            newMap.set(chatId, [
                ...existing,
                {
                    id: generateId(),
                    role,
                    content,
                    timestamp: new Date(),
                },
            ]);
            return newMap;
        });
    }, []);

    // Handle chat status / error update from orchestrate
    // 默认只更新状态；如果有 errorMessage，则在对应聊天中也插入一条 system 消息，让错误出现在主对话流里
    const handleChatUpdate = useCallback((
        chatId: string,
        status: ChatStatus,
        _messageContent?: string,
        _messageType?: 'cursor_response' | 'ai_followup',
        errorMessage?: string
    ) => {
        // 1) 更新 session 状态 + 挂上 errorMessage
        setSessions((prev) =>
            prev.map((s) => {
                if (s.id === chatId) {
                    return {
                        ...s,
                        status,
                        errorMessage: status === 'error' ? errorMessage : undefined,
                    };
                }
                return s;
            })
        );

        // 2) 如果是 error，并且有错误信息，把它作为一条 system 消息插到对应聊天里
        if (status === 'error' && errorMessage) {
            const systemContent = `❌ ${errorMessage}`;

            // 更新 sessions 里的 messages（用于刷新后恢复）
            setSessions((prev) =>
                prev.map((s) => {
                    if (s.id !== chatId) return s;
                    const existing = Array.isArray((s as any).messages) ? (s as any).messages : [];
                    const now = new Date();
                    const newMsg = {
                        id: generateId(),
                        role: 'system' as const,
                        content: systemContent,
                        timestamp: now,
                        metadata: { source: 'orchestrator' as const },
                    };
                    return {
                        ...s,
                        messages: [...existing, newMsg],
                    };
                })
            );

            // 如果当前正打开的是这个聊天，把错误也追加到前端 messages 里，让它立刻显示出来
            if (currentSessionId === chatId) {
                setMessages((prev) => [
                    ...prev,
                    {
                        id: generateId(),
                        role: 'system',
                        content: systemContent,
                        createdAt: new Date(),
                        metadata: { source: 'orchestrator' as const },
                    },
                ]);
            }
        }
    }, [currentSessionId, setMessages, setSessions]);

    // Poll for chat status updates for main orchestrator chats (e.g., Telegram sessions)
    // Note: Sub-tasks (orchestrateTaskId set but NOT isOrchestratorManaged) are shown in sidebar
    // and their messages are loaded directly, not via polling to orchestratorMessages
    useEffect(() => {
        // Only poll for main orchestrator conversations (isOrchestratorManaged = true)
        const chatsToWatch = sessions.filter(
            (s) => s.isOrchestratorManaged && s.status !== 'idle' && s.status !== 'error'
        );

        if (chatsToWatch.length === 0) return;

        // Poll function - also called immediately
        const pollChats = async () => {
            for (const chat of chatsToWatch) {
                try {
                    const lastCount = lastMessageCounts.current.get(chat.id);
                    const isFirstPoll = typeof lastCount !== 'number';
                    const params = new URLSearchParams({ chatId: chat.id });
                    if (!isFirstPoll) {
                        params.set('after', String(lastCount));
                        params.set('limit', String(ORCHESTRATOR_POLL_LIMIT));
                    } else {
                        // First poll - get recent messages
                        params.set('tail', String(ORCHESTRATOR_POLL_LIMIT));
                    }
                    const response = await fetch(`/api/chat-status?${params.toString()}`);
                    if (!response.ok) continue;

                    const data = await response.json();

                    const messageCount = typeof data.messageCount === 'number'
                        ? data.messageCount
                        : (typeof lastCount === 'number' ? lastCount : 0);

                    if (data.messages && data.messages.length > 0) {
                        if (isFirstPoll) {
                            // First poll - set messages directly (replace)
                            const mapped: DisplayMessage[] = data.messages.map(
                                (msg: { id: string; role: string; content: string; timestamp: string }) => ({
                                    id: msg.id,
                                    role: msg.role as 'user' | 'assistant' | 'system',
                                    content: msg.content,
                                    timestamp: new Date(msg.timestamp),
                                })
                            );
                            setOrchestratorMessages((prev) => {
                                const newMap = new Map(prev);
                                newMap.set(chat.id, mapped);
                                return newMap;
                            });
                        } else {
                            // Subsequent polls - add new messages
                            for (const msg of data.messages) {
                                if (msg.role === 'assistant') {
                                    addOrchestratorMessage(chat.id, 'assistant', msg.content);
                                } else if (msg.role === 'user') {
                                    // Agent Manager's follow-up (including "Mission Complete")
                                    const prefix = msg.content === 'Mission Complete' ? '✅ ' : '🤖 ';
                                    addOrchestratorMessage(chat.id, 'system', `${prefix}${msg.content}`);
                                }
                            }
                        }
                    }
                    
                    lastMessageCounts.current.set(chat.id, messageCount);

                    // Update status if changed
                    if (data.status !== chat.status) {
                        setSessions((prev) =>
                            prev.map((s) => (s.id === chat.id ? { ...s, status: data.status } : s))
                        );
                    }
                } catch (err) {
                    console.error('Poll error:', err);
                }
            }
        };

        // Poll immediately on mount/change
        pollChats();

        // Only continue polling if there are running chats
        const hasRunningChats = chatsToWatch.some(
            (s) => s.status === 'running' || s.status === 'waiting_response'
        );

        if (!hasRunningChats) return;

        const pollInterval = setInterval(pollChats, 5000); // Poll every 5 seconds

        return () => clearInterval(pollInterval);
    }, [sessions, addOrchestratorMessage]);

    // Poll for updates on current sub-task session
    // This enables real-time message updates for orchestrator-created chats
    useEffect(() => {
        // Debug: Log when this effect runs
        console.log(`[Poll Effect] Running. currentSessionId=${currentSessionId}, currentSession=${!!currentSession}, orchestrateTaskId=${currentSession?.orchestrateTaskId}, isOrchestratorManaged=${currentSession?.isOrchestratorManaged}, status=${currentSession?.status}`);
        
        // Only poll if current session is a sub-task (has orchestrateTaskId, not orchestrator-main)
        if (!currentSession || !currentSessionId) {
            console.log(`[Poll Effect] Skipping: no currentSession or currentSessionId`);
            return;
        }
        
        const isSubtask = isOrchestratorSubtask(currentSession);
        console.log(`[Poll Effect] isOrchestratorSubtask=${isSubtask}`);
        
        if (!isSubtask) {
            console.log(`[Poll Effect] Skipping: not a subtask`);
            return;
        }
        
        // Only poll when status is 'running' or 'waiting_response'
        const isActiveStatus = currentSession.status === 'running' || currentSession.status === 'waiting_response';
        
        // Skip if status is 'idle', 'completed', or 'error' - no need to poll
        if (!isActiveStatus) {
            console.log(`[Poll Effect] Skipping: status is ${currentSession.status} (not active)`);
            return;
        }

        console.log(`[Poll] Starting poll for session ${currentSessionId}, status: ${currentSession.status}`);

        // Poll loop with simple backoff (reduces polling pressure when nothing changes)
        const controller = new AbortController();
        let stopped = false;
        let delayMs = 500; // Start at 500ms for faster initial response
        const MAX_DELAY_MS = 2000; // Cap at 2s for better UX
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        let lastKnownCount = lastMessageCounts.current.get(currentSessionId) ?? -1; // -1 means "never fetched"
        let lastKnownStatus: ChatStatus | undefined;

        const pollLoop = async () => {
            if (stopped) return;
            
            try {
                const params = new URLSearchParams({ chatId: currentSessionId });
                if (lastKnownCount === -1) {
                    params.set('tail', String(SUBTASK_INITIAL_TAIL));
                } else {
                    params.set('after', String(lastKnownCount));
                    params.set('limit', String(SUBTASK_POLL_LIMIT));
                }

                const response = await fetch(`/api/chat-status?${params.toString()}`, { signal: controller.signal });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                
                const data = await response.json();
                
                const nextCount = typeof data.messageCount === 'number'
                    ? data.messageCount
                    : lastKnownCount;
                const nextStatus = data.status as ChatStatus | undefined;
                const nextTaskMd = data.taskMd as string | undefined;
                
                // Detect changes - use lastKnownCount to handle first fetch correctly
                const messagesChanged = lastKnownCount === -1
                    ? (data.messages?.length ?? 0) > 0
                    : nextCount !== lastKnownCount;
                const statusChanged = nextStatus !== undefined && nextStatus !== lastKnownStatus;
                const changed = messagesChanged || statusChanged;
                
                console.log(`[Poll] Session ${currentSessionId}: messages=${nextCount} (changed=${messagesChanged}), status=${nextStatus} (changed=${statusChanged})`);
                
                // Always update messages if there are any changes or first fetch
                if (data.messages && messagesChanged) {
                    const mapped: ChatUiMessageWithMetadata[] = data.messages.map(
                        (m: { id: string; role: string; content: string; timestamp: string; metadata?: { source?: 'agent_manager' | 'orchestrator' | 'user' | 'cursor' | 'thinking' } }) => ({
                            id: m.id,
                            role: m.role as ChatUiMessage['role'],
                            content: m.content,
                            createdAt: new Date(m.timestamp),
                            metadata: m.metadata,
                        })
                    );
                    if (lastKnownCount === -1) {
                        setMessages(mapped);
                    } else {
                        setMessages((prev) => [...prev, ...mapped]);
                    }
                    if (typeof nextCount === 'number') {
                        lastMessageCounts.current.set(currentSessionId, nextCount);
                        lastKnownCount = nextCount;
                    }
                }

                if (typeof nextCount === 'number' && nextCount !== lastKnownCount) {
                    lastMessageCounts.current.set(currentSessionId, nextCount);
                    lastKnownCount = nextCount;
                }
                
                // Update status and taskMd if changed
                if (statusChanged || nextTaskMd !== undefined) {
                    setSessions((prev) => {
                        const currentSess = prev.find(s => s.id === currentSessionId);
                        if (!currentSess) return prev;
                        
                        const needsUpdate = 
                            (nextStatus && currentSess.status !== nextStatus) ||
                            (nextTaskMd && currentSess.taskMd !== nextTaskMd);
                        
                        if (needsUpdate) {
                            console.log(`[Poll] Updating session ${currentSessionId}: status=${nextStatus}, taskMd=${!!nextTaskMd}`);
                            return prev.map((s) => 
                                s.id === currentSessionId 
                                    ? { 
                                        ...s, 
                                        status: nextStatus || s.status,
                                        taskMd: nextTaskMd || s.taskMd,
                                    } 
                                    : s
                            );
                        }
                        return prev;
                    });
                    lastKnownStatus = nextStatus;
                }
                
                // Check if we should stop polling - status changed to completed/error
                const isNowFinal = nextStatus === 'completed' || nextStatus === 'error';
                if (isNowFinal) {
                    console.log(`[Poll] Session ${currentSessionId} status changed to ${nextStatus}, stopping poll`);
                    stopped = true;
                    return;
                }
                
                // Backoff: if something changed, poll quickly; otherwise slow down
                delayMs = changed ? 500 : Math.min(Math.round(delayMs * 1.2), MAX_DELAY_MS);
            } catch (err) {
                // If aborted, stop silently
                if ((err as Error).name === 'AbortError') {
                    stopped = true;
                    return;
                }
                console.error(`[Poll] Error polling session ${currentSessionId}:`, err);
                // Backoff on errors
                delayMs = Math.min(Math.round(delayMs * 1.5), MAX_DELAY_MS);
            } finally {
                if (!stopped) {
                    timeoutId = setTimeout(pollLoop, delayMs);
                }
            }
        };

        // Start immediately (no initial delay)
        pollLoop();

        return () => {
            stopped = true;
            controller.abort();
            if (timeoutId) clearTimeout(timeoutId);
        };
    // Dependencies: Include sessions.length to detect when new sessions are added
    // Also include a stringified version of key session properties to ensure re-evaluation
    }, [currentSessionId, currentSession?.orchestrateTaskId, currentSession?.isOrchestratorManaged, currentSession?.status, setMessages, setSessions, sessions.length]);

    // Custom input state for MentionInput
    const [chatInput, setChatInput] = useState('');
    const [isSendingToOrchestrator, setIsSendingToOrchestrator] = useState(false);
    // Track if we're waiting for a response (for showing processing indicator)
    const [isWaitingForResponse, setIsWaitingForResponse] = useState(false);

    // Handle message submission with @mention routing
    const handleMentionSubmit = useCallback(async (message: string, mentionedIds: string[]) => {
        if (!message.trim()) return;

        const hasOrchestratorMention = mentionedIds.includes('orchestrator');
        
        // Remove the @Orchestrator mention from the message for clean display
        const cleanMessage = message.replace(/@Orchestrator\s*/gi, '').trim();
        
        if (hasOrchestratorMention) {
            // Route through Orchestrator - continue in current chat if exists
            setIsSendingToOrchestrator(true);
            
            // Ensure we have a session
            let chatId = currentSessionId;
            if (!chatId) {
                chatId = createNewSession();
            }
            
            // Add user message to display immediately
            const userMessage = {
                id: generateId(),
                role: 'user' as const,
                content: cleanMessage,
                createdAt: new Date(),
            };
            setMessages((prev) => [...prev, userMessage]);
            
            // Update session status to running
            setSessions((prev) =>
                prev.map((s) =>
                    s.id === chatId ? { ...s, status: 'running' as ChatStatus, orchestrateTaskId: s.orchestrateTaskId || chatId } : s
                )
            );
            
            try {
                // Get current chat history for context
                const chatHistory = messages.map((m) => ({
                    role: m.role,
                    content: m.content,
                }));
                
                const response = await fetch('/api/orchestrate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        request: cleanMessage, 
                        workdir, 
                        skillsPath: settings.skillsPath,
                        chatId, // Pass current chat ID
                        chatHistory, // Pass chat history for context
                    }),
                });

                if (!response.ok) throw new Error('Orchestrate request failed');

                const reader = response.body?.getReader();
                if (!reader) throw new Error('No response body');

                const decoder = new TextDecoder();

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    const chunk = decoder.decode(value, { stream: true });
                    const lines = chunk.split('\n');

                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            try {
                                const eventData = JSON.parse(line.slice(6));
                                
                                if (eventData.type === 'message' && eventData.content) {
                                    // Orchestrator's thinking/message - add to current chat
                                    setMessages((prev) => {
                                        // Check if last message is from assistant and append to it
                                        const lastMsg = prev[prev.length - 1];
                                        if (lastMsg && lastMsg.role === 'assistant') {
                                            return prev.map((m, i) =>
                                                i === prev.length - 1
                                                    ? { ...m, content: m.content + eventData.content }
                                                    : m
                                            );
                                        }
                                        // Otherwise add new assistant message
                                        return [
                                            ...prev,
                                            {
                                                id: generateId(),
                                                role: 'assistant' as const,
                                                content: eventData.content,
                                                createdAt: new Date(),
                                            },
                                        ];
                                    });
                                } else if (eventData.type === 'tool_start') {
                                    // Tool execution started
                                    setMessages((prev) => [
                                        ...prev,
                                        {
                                            id: generateId(),
                                            role: 'assistant' as const,
                                            content: `🔧 Executing: ${eventData.content}`,
                                            createdAt: new Date(),
                                        },
                                    ]);
                                } else if (eventData.type === 'tool_end') {
                                    // Tool execution completed - update last message
                                    setMessages((prev) => {
                                        const lastMsg = prev[prev.length - 1];
                                        if (lastMsg && lastMsg.content.startsWith('🔧 Executing:')) {
                                            return prev.map((m, i) =>
                                                i === prev.length - 1
                                                    ? { ...m, content: `✅ ${eventData.content}` }
                                                    : m
                                            );
                                        }
                                        return prev;
                                    });
                                } else if (eventData.type === 'cursor_progress' && eventData.content) {
                                    // Cursor response - add to chat
                                    setMessages((prev) => [
                                        ...prev,
                                        {
                                            id: generateId(),
                                            role: 'assistant' as const,
                                            content: eventData.content,
                                            createdAt: new Date(),
                                        },
                                    ]);
                                } else if (eventData.type === 'chat_created') {
                                    // Orchestrator created a new subtask - add it to sessions
                                    try {
                                        const { task, title, chatId: newChatId, taskMd } = JSON.parse(eventData.content || '{}');
                                        const finalChatId = newChatId || eventData.chatId;
                                        
                                        if (finalChatId) {
                                            console.log(`[MentionSubmit] chat_created event: chatId=${finalChatId}, title=${title}`);
                                            
                                            // Create new session for the subtask
                                            const newSession: ChatSession = {
                                                id: finalChatId,
                                                title: title || 'Subtask',
                                                createdAt: new Date(),
                                                status: 'running' as ChatStatus,
                                                messages: [],
                                                orchestrateTaskId: finalChatId,
                                                taskMd,
                                                workdir, // Store workdir for this task
                                            };
                                            
                                            setSessions((prev) => {
                                                // Check if session already exists
                                                if (prev.some(s => s.id === finalChatId)) {
                                                    return prev;
                                                }
                                                return [newSession, ...prev];
                                            });
                                            
                                            // Initialize message count for polling
                                            lastMessageCounts.current.set(finalChatId, -1);
                                            
                                            // Add status message to current chat
                                            setMessages((prev) => [
                                                ...prev,
                                                {
                                                    id: generateId(),
                                                    role: 'assistant' as const,
                                                    content: `📋 Created subtask: **${title}**`,
                                                    createdAt: new Date(),
                                                },
                                            ]);
                                        }
                                    } catch (e) {
                                        console.error('[MentionSubmit] Failed to parse chat_created event:', e);
                                    }
                                } else if (eventData.type === 'chat_update') {
                                    // Subtask status update
                                    if (eventData.chatId && eventData.chatStatus) {
                                        setSessions((prev) =>
                                            prev.map((s) =>
                                                s.id === eventData.chatId
                                                    ? { ...s, status: eventData.chatStatus as ChatStatus }
                                                    : s
                                            )
                                        );
                                    }
                                } else if (eventData.type === 'chat_complete') {
                                    // Subtask completed
                                    try {
                                        const { chatId: completedChatId, success, error } = JSON.parse(eventData.content || '{}');
                                        if (completedChatId) {
                                            setSessions((prev) =>
                                                prev.map((s) =>
                                                    s.id === completedChatId
                                                        ? { ...s, status: success ? 'completed' : 'error', errorMessage: error }
                                                        : s
                                                )
                                            );
                                        }
                                    } catch (e) {
                                        console.error('[MentionSubmit] Failed to parse chat_complete event:', e);
                                    }
                                } else if (eventData.type === 'result') {
                                    // Final result
                                    setSessions((prev) =>
                                        prev.map((s) =>
                                            s.id === chatId
                                                ? { ...s, status: eventData.success ? 'completed' : 'error' }
                                                : s
                                        )
                                    );
                                } else if (eventData.type === 'error') {
                                    // Error occurred
                                    const errorMsg = eventData.error || 'Unknown error';
                                    setMessages((prev) => [
                                        ...prev,
                                        {
                                            id: generateId(),
                                            role: 'assistant' as const,
                                            content: `❌ Error: ${errorMsg}`,
                                            createdAt: new Date(),
                                        },
                                    ]);
                                    setSessions((prev) =>
                                        prev.map((s) =>
                                            s.id === chatId ? { ...s, status: 'error', errorMessage: errorMsg } : s
                                        )
                                    );
                                }
                            } catch {
                                // Ignore parse errors
                            }
                        }
                    }
                }
            } catch (error) {
                console.error('Orchestrator error:', error);
                const errorMsg = error instanceof Error ? error.message : String(error);
                setMessages((prev) => [
                    ...prev,
                    {
                        id: generateId(),
                        role: 'assistant' as const,
                        content: `❌ Error: ${errorMsg}`,
                        createdAt: new Date(),
                    },
                ]);
                setSessions((prev) =>
                    prev.map((s) =>
                        s.id === chatId ? { ...s, status: 'error', errorMessage: errorMsg } : s
                    )
                );
            } finally {
                setIsSendingToOrchestrator(false);
            }
        } else {
            // Direct to Cursor via useChat
            // Set waiting state immediately for UI feedback
            setIsWaitingForResponse(true);
            
            // First ensure we have a session
            if (!currentSessionId) {
                const newChatId = createNewSession();
                setSessions((prev) =>
                    prev.map((s) => (s.id === newChatId ? { ...s, status: 'running' as ChatStatus } : s))
                );
                setPendingManualMessage({ chatId: newChatId, content: cleanMessage });
            } else {
                setSessions((prev) =>
                    prev.map((s) => (s.id === currentSessionId ? { ...s, status: 'running' as ChatStatus } : s))
                );
                // Use the append function from useChat
                append({
                    role: 'user',
                    content: cleanMessage,
                });
            }
        }
        
        setChatInput('');
    }, [workdir, currentSessionId, append, createNewSession, messages, setMessages, settings.skillsPath, setSessions, setPendingManualMessage, setChatInput]);

    // Filter sessions for sidebar:
    // - Show sub-tasks (orchestrateTaskId set but NOT isOrchestratorManaged)
    // - Show manual chats (no orchestrateTaskId)
    // - Hide main orchestrator conversations (isOrchestratorManaged = true, e.g., Telegram sessions)
    const sidebarSessions = sessions.filter((s) => !isOrchestratorMain(s));

    // Auto-select first chat when no chat is selected (and sessions are loaded)
    useEffect(() => {
        if (!currentSessionId && sidebarSessions.length > 0) {
            // Select the first available chat
            selectSession(sidebarSessions[0].id);
        }
    }, [currentSessionId, sidebarSessions, selectSession]);

    // Get status badge style
    const getStatusBadge = (status: ChatStatus) => {
        switch (status) {
            case 'running':
            case 'waiting_response':
                return 'badge-warning';
            case 'completed':
                return 'badge-success';
            case 'error':
                return 'badge-destructive';
            default:
                return 'badge-default';
        }
    };

    return (
        <div className="p-4 h-screen">
        <div className="flex h-full bg-[var(--bg-primary)] rounded-xl border border-[var(--border)] shadow-[var(--app-shadow)] overflow-hidden">
            <Sidebar
                sessions={sidebarSessions}
                currentId={currentSessionId}
                onSelect={selectSession}
                onNew={createNewSession}
                onDelete={deleteSession}
                defaultWorkdir={workdir}
            />

            <main className="flex-1 flex flex-col relative">
                {/* Header */}
                <header className="h-14 flex items-center justify-between px-6 border-b bg-[var(--bg-primary)]">
                    <div className="flex items-center gap-4">
                        <h1 className="text-sm font-medium text-[var(--text-primary)] truncate max-w-[300px]">
                            {currentSession?.title || 'New Chat'}
                        </h1>

                        {currentSession && (
                            <div className="flex items-center gap-2">
                                {isOrchestratorManaged && (
                                    <span className="badge badge-default">
                                        Auto
                                    </span>
                                )}
                                {currentSession.status !== 'idle' && (
                                    <span
                                        className={`badge ${getStatusBadge(currentSession.status)}`}
                                        title={currentSession.status === 'error' && currentSession.errorMessage 
                                            ? `Error: ${currentSession.errorMessage}` 
                                            : undefined}
                                    >
                                        {currentSession.status === 'running' || currentSession.status === 'waiting_response' ? (
                                            <span className="flex items-center gap-1">
                                                <span className="w-1.5 h-1.5 bg-current rounded-full animate-pulse" />
                                                Running
                                            </span>
                                        ) : (
                                            currentSession.status.charAt(0).toUpperCase() + currentSession.status.slice(1)
                                        )}
                                    </span>
                                )}
                                {/* Task.md button in header */}
                                {currentSession.taskMd && currentSessionId && (
                                    <TaskEditor
                                        sessionId={currentSessionId}
                                        initialContent={currentSession.taskMd}
                                        onUpdate={(newContent) => {
                                            setSessions((prev) =>
                                                prev.map((s) =>
                                                    s.id === currentSessionId ? { ...s, taskMd: newContent } : s
                                                )
                                            );
                                        }}
                                        compact={true}
                                    />
                                )}
                            </div>
                        )}
                    </div>

                    {/* Right Side: Settings and Orchestrator buttons */}
                    <div className="flex items-center gap-2">
                        {/* Active Cursor Calls Indicator */}
                        <div className="relative">
                            <button
                                onClick={() => setIsStatusExpanded(!isStatusExpanded)}
                                className={`btn btn-ghost h-8 px-3 text-xs ${
                                    systemStatus?.activeCursorCalls?.count && systemStatus.activeCursorCalls.count > 0
                                        ? 'text-[var(--warning)]'
                                        : ''
                                }`}
                                title="Active Cursor Calls"
                            >
                                <span className={`w-1.5 h-1.5 rounded-full ${
                                    systemStatus?.activeCursorCalls?.count && systemStatus.activeCursorCalls.count > 0
                                        ? 'bg-[var(--warning)] animate-pulse'
                                        : 'bg-[var(--success)]'
                                }`} />
                                <span className="ml-1.5">
                                    {systemStatus?.activeCursorCalls?.count ?? 0} active
                                </span>
                            </button>
                            
                            {/* Expanded Status Panel */}
                            {isStatusExpanded && (
                                <div className="absolute right-0 top-full mt-2 w-80 card p-4 z-50">
                                    <div className="text-xs font-medium text-[var(--text-primary)] mb-3 pb-2 border-b">
                                        Agent Status
                                    </div>
                                    {systemStatus?.activeCursorCalls?.count && systemStatus.activeCursorCalls.count > 0 ? (
                                        <div className="space-y-2">
                                            {systemStatus.activeCursorCalls.calls.map((call) => (
                                                <div key={call.id} className="text-xs p-2 bg-[var(--bg-secondary)] rounded-md">
                                                    <div className="flex justify-between items-center mb-1">
                                                        <span className="text-[var(--warning)] font-medium flex items-center gap-1">
                                                            <span className="w-1.5 h-1.5 bg-[var(--warning)] rounded-full animate-pulse" />
                                                            Running
                                                        </span>
                                                        <span className="text-[var(--text-muted)]">
                                                            {Math.round(call.durationMs / 1000)}s
                                                        </span>
                                                    </div>
                                                    {call.chatTitle && (
                                                        <div className="text-[var(--text-secondary)] truncate">
                                                            {call.chatTitle}
                                                        </div>
                                                    )}
                                                    <div className="text-[var(--text-muted)] truncate mt-1">
                                                        {call.task.slice(0, 100)}...
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <div className="text-xs text-[var(--success)] flex items-center gap-1.5">
                                            <span className="w-1.5 h-1.5 bg-[var(--success)] rounded-full" />
                                            System idle
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Settings Button */}
                        <button
                            onClick={() => setIsSettingsOpen(true)}
                            className="btn btn-secondary h-8 px-2 text-xs"
                            title="Settings"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M10.343 3.94c.09-.542.56-.94 1.11-.94h1.093c.55 0 1.02.398 1.11.94l.149.894c.07.424.384.764.78.93.398.164.855.142 1.205-.108l.737-.527a1.125 1.125 0 011.45.12l.773.774c.39.389.44 1.002.12 1.45l-.527.737c-.25.35-.272.806-.107 1.204.165.397.505.71.93.78l.893.15c.543.09.94.559.94 1.109v1.094c0 .55-.397 1.02-.94 1.11l-.894.149c-.424.07-.764.383-.929.78-.165.398-.143.854.107 1.204l.527.738c.32.447.269 1.06-.12 1.45l-.774.773a1.125 1.125 0 01-1.449.12l-.738-.527c-.35-.25-.806-.272-1.203-.107-.398.165-.71.505-.781.929l-.149.894c-.09.542-.56.94-1.11.94h-1.094c-.55 0-1.019-.398-1.11-.94l-.148-.894c-.071-.424-.384-.764-.781-.93-.398-.164-.854-.142-1.204.108l-.738.527c-.447.32-1.06.269-1.45-.12l-.773-.774a1.125 1.125 0 01-.12-1.45l.527-.737c.25-.35.272-.806.108-1.204-.165-.397-.506-.71-.93-.78l-.894-.15c-.542-.09-.94-.56-.94-1.109v-1.094c0-.55.398-1.02.94-1.11l.894-.149c.424-.07.765-.383.93-.78.165-.398.143-.854-.108-1.204l-.526-.738a1.125 1.125 0 01.12-1.45l.773-.773a1.125 1.125 0 011.45-.12l.737.527c.35.25.807.272 1.204.107.397-.165.71-.505.78-.929l.15-.894z" />
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                            </svg>
                        </button>
                        
                        {/* Orchestrator Button */}
                        <button
                            onClick={() => setIsOrchestrateOpen(true)}
                            className="btn btn-primary h-8 px-3 text-xs"
                        >
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={1.5}
                                    d="M13 10V3L4 14h7v7l9-11h-7z"
                                />
                            </svg>
                            Orchestrator
                        </button>
                    </div>
                </header>

                {/* Messages */}
                <div className="flex-1 overflow-y-auto px-6 py-6">
                    {displayMessages.length === 0 && (
                        <div className="flex items-center justify-center h-full">
                            <div className="text-center max-w-md">
                                {isOrchestratorManaged ? (
                                    <>
                                        <div className="w-12 h-12 rounded-full bg-[var(--bg-tertiary)] flex items-center justify-center mx-auto mb-4">
                                            <svg className="w-6 h-6 text-[var(--text-muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
                                            </svg>
                                        </div>
                                        <h3 className="text-lg font-medium text-[var(--text-primary)] mb-2">Orchestrator Active</h3>
                                        <p className="text-sm text-[var(--text-muted)]">Managing task execution...</p>
                                    </>
                                ) : (
                                    <>
                                        <div className="w-12 h-12 rounded-full bg-[var(--bg-tertiary)] flex items-center justify-center mx-auto mb-4">
                                            <svg className="w-6 h-6 text-[var(--text-muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                                            </svg>
                                        </div>
                                        <h3 className="text-lg font-medium text-[var(--text-primary)] mb-2">Start a conversation</h3>
                                        <p className="text-sm text-[var(--text-muted)] mb-4">
                                            Type a message below to chat with Cursor Agent, or use{' '}
                                            <button
                                                onClick={() => setIsOrchestrateOpen(true)}
                                                className="text-[var(--text-primary)] underline underline-offset-2 hover:no-underline"
                                            >
                                                Orchestrator
                                            </button>
                                            {' '}for complex tasks.
                                        </p>
                                    </>
                                )}
                            </div>
                        </div>
                    )}

                    <div className="mx-auto space-y-4">
                        {displayMessages.map((msg) => (
                            <div
                                key={msg.id}
                                className={`flex ${msg.role === 'assistant' ? 'justify-start' : 'justify-end'}`}
                            >
                                {msg.role === 'system' ? (
                                    // System messages (Agent Manager, Orchestrator, Thinking)
                                    isThinkingMessage(msg) ? (
                                        // Thinking messages - special collapsible style
                                        <div className="max-w-[85%] bg-gradient-to-r from-[var(--bg-tertiary)] to-[var(--bg-secondary)] rounded-lg border border-dashed border-[var(--border)] overflow-hidden">
                                            <details className="group">
                                                <summary className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none hover:bg-[var(--bg-muted)] transition-colors">
                                                    <svg className="w-3.5 h-3.5 text-[var(--text-muted)] transition-transform group-open:rotate-90" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                                    </svg>
                                                    <span className="text-xs font-medium text-[var(--text-muted)] italic">💭 Thinking...</span>
                                                    <span className="text-xs text-[var(--text-muted)] opacity-60">
                                                        {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                                    </span>
                                                </summary>
                                                <div className="px-3 py-2 text-xs text-[var(--text-secondary)] italic border-t border-dashed border-[var(--border)] bg-[var(--bg-tertiary)]/50">
                                                    {msg.content}
                                                </div>
                                            </details>
                                        </div>
                                    ) : (
                                        // Regular system messages (Agent Manager, Orchestrator)
                                        <div className="max-w-[85%] bg-[var(--bg-muted)] rounded-lg p-4 border border-[var(--border)]">
                                            <div className="flex items-center gap-2 mb-2">
                                                <span className="text-xs font-medium text-[var(--text-muted)]">
                                                    {resolveSystemLabel(msg)}
                                                </span>
                                                <span className="text-xs text-[var(--text-muted)]">
                                                    {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                                </span>
                                            </div>
                                            <div className="prose prose-sm max-w-none">
                                                <StreamdownDisplay>
                                                    {msg.content}
                                                </StreamdownDisplay>
                                            </div>
                                        </div>
                                    )
                                ) : msg.role === 'user' ? (
                                    // User messages
                                    <div className="max-w-[85%] bg-[var(--user-msg-bg)] text-[var(--user-msg-text)] rounded-lg p-4 user-message-content">
                                        <div className="flex items-center justify-end gap-2 mb-2">
                                            <span className="text-xs font-medium opacity-80">You</span>
                                            <span className="text-xs opacity-70">
                                                {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                            </span>
                                        </div>
                                        <p className="whitespace-pre-wrap text-sm">{msg.content}</p>
                                    </div>
                                ) : (
                                    // Assistant messages
                                    <div className="max-w-[85%] bg-[var(--bg-secondary)] rounded-lg p-4 border border-[var(--border)]">
                                        <div className="flex items-center gap-2 mb-2">
                                            <span className="text-xs font-medium text-[var(--text-muted)]">Cursor</span>
                                            <span className="text-xs text-[var(--text-muted)]">
                                                {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                            </span>
                                        </div>
                                        <div className="prose prose-sm max-w-none">
                                            <StreamdownDisplay
                                                isAnimating={isLoading && msg.id === displayMessages[displayMessages.length - 1]?.id}
                                            >
                                                {msg.content}
                                            </StreamdownDisplay>
                                        </div>
                                    </div>
                                )}
                            </div>
                        ))}

                        {(isLoading || isSendingToOrchestrator || isWaitingForResponse || currentSession?.status === 'running' || currentSession?.status === 'waiting_response') && (() => {
                            // Determine loading position based on last message
                            // If last message is from assistant (Cursor), next will be system (Agent Manager) -> right side
                            // If last message is from user or system, next will be assistant (Cursor) -> left side
                            const lastMsg = displayMessages[displayMessages.length - 1];
                            const isWaitingForAgentManager = lastMsg?.role === 'assistant';
                            const justifyClass = isWaitingForAgentManager ? 'justify-end' : 'justify-start';
                            const bgClass = isWaitingForAgentManager 
                                ? 'bg-[var(--bg-muted)] border-[var(--border)]' 
                                : 'bg-[var(--bg-secondary)] border-[var(--border)]';
                            
                            return (
                                <div className={`flex ${justifyClass}`}>
                                    <div className="group flex items-center gap-2">
                                        <div className={`rounded-lg px-3 py-2 border ${bgClass}`}>
                                            <div className="flex items-center gap-1">
                                                <span className="w-1.5 h-1.5 bg-[var(--text-muted)] rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                                                <span className="w-1.5 h-1.5 bg-[var(--text-muted)] rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                                                <span className="w-1.5 h-1.5 bg-[var(--text-muted)] rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                                            </div>
                                        </div>
                                        <button
                                            onClick={handleStopChat}
                                            className="btn btn-ghost h-7 w-7 p-0 text-[var(--destructive)] hover:bg-[var(--destructive)] hover:text-white transition-all"
                                            title="Stop"
                                        >
                                            <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                                                <rect x="6" y="6" width="12" height="12" rx="2" />
                                            </svg>
                                        </button>
                                    </div>
                                </div>
                            );
                        })()}

                        {error && (
                            <div className="flex justify-center">
                                <div className="badge badge-destructive px-3 py-1.5">
                                    Error: {error.message}
                                </div>
                            </div>
                        )}

                        <div ref={messagesEndRef} />
                    </div>
                </div>

                {/* Input */}
                <div className="px-6 py-4 border-t bg-[var(--bg-primary)]">
                    <div className="max-w-3xl mx-auto">
                        <MentionInput
                            value={chatInput}
                            onChange={setChatInput}
                            onSubmit={handleMentionSubmit}
                            placeholder="Type @ to mention, Enter to send..."
                            disabled={isOrchestratorManaged}
                            isLoading={isLoading || isSendingToOrchestrator || isWaitingForResponse}
                            onStop={handleStopChat}
                        />
                        <p className="text-xs text-[var(--text-muted)] mt-2">
                            @Orchestrator for AI-managed tasks, or send directly to Cursor
                        </p>
                    </div>
                </div>
            </main>

            {/* Global Orchestrate Panel */}
            <OrchestratePanel
                isOpen={isOrchestrateOpen}
                onClose={(lastCreatedChatId) => {
                    setIsOrchestrateOpen(false);
                    // Auto-activate the last created subtask when closing
                    if (lastCreatedChatId) {
                        const session = sessions.find(s => s.id === lastCreatedChatId);
                        if (session) {
                            selectSession(lastCreatedChatId);
                        }
                    }
                }}
                workdir={workdir}
                onChatCreated={handleChatCreated}
                onChatUpdate={handleChatUpdate}
                skillsPath={settings.skillsPath}
                onOpenSettings={() => setIsSettingsOpen(true)}
            />

            {/* Settings Panel */}
            <SettingsPanel
                isOpen={isSettingsOpen}
                onClose={() => setIsSettingsOpen(false)}
                settings={settings}
                onSettingsChange={setSettings}
            />
        </div>
        </div>
    );
}
