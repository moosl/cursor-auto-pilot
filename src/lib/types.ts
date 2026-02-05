/**
 * Type definitions for CursorPilot
 */

// ============ Chat Session Types ============

export type ChatStatus = 'idle' | 'running' | 'waiting_response' | 'completed' | 'error';

export interface Message {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: Date;
    metadata?: {
        toolCalls?: string[];
        thinking?: string;
        source?: 'agent_manager' | 'orchestrator' | 'user' | 'cursor' | 'thinking';
    };
}

export interface ChatSession {
    id: string;
    title: string;
    createdAt: Date;
    status: ChatStatus;
    messages: Message[];
    // If created by orchestrate, track the parent task
    orchestrateTaskId?: string;
    // Cursor agent session ID for resuming
    cursorSessionId?: string;
    // Whether this session is managed by orchestrator
    isOrchestratorManaged?: boolean;
    // Source of the session: 'web' or 'telegram'
    source?: 'web' | 'telegram';
    // Working directory for this chat (project context)
    workdir?: string;
    // True if workdir no longer exists on filesystem
    workdirMissing?: boolean;
    // Task description in markdown format (for sub-tasks)
    taskMd?: string;
    // Error message when status is 'error'
    errorMessage?: string;
}

// ============ Orchestrate Types ============

export interface OrchestrateMessage {
    id: string;
    role: 'user' | 'assistant' | 'status';
    content: string;
    timestamp: Date;
    subContent?: LogEntry[];
}

export interface LogEntry {
    type: 'thinking' | 'assistant' | 'tool_call' | 'status' | 'raw';
    content: string;
}

export interface OrchestrateTask {
    id: string;
    chatId: string;
    title: string;
    task: string;
    status: 'pending' | 'running' | 'waiting_confirmation' | 'completed' | 'error';
    createdAt: Date;
}

// ============ Cursor Agent Types ============

export interface CursorAgentMessage {
    type: 'system' | 'user' | 'assistant' | 'thinking' | 'tool_call' | 'result';
    message?: { content: Array<{ type: string; text?: string }> };
    text?: string;
    session_id?: string;
    model?: string;
    subtype?: string;
    is_error?: boolean;
    // Duration in milliseconds (for result type)
    duration_ms?: number;
    tool_call?: {
        name?: string;
        params?: Record<string, unknown>;
        // Tool call results (for completed subtype)
        writeToolCall?: {
            args?: { path?: string };
            result?: {
                success?: {
                    linesCreated?: number;
                    fileSize?: number;
                };
            };
        };
        readToolCall?: {
            args?: { path?: string };
            result?: {
                success?: {
                    totalLines?: number;
                };
            };
        };
    };
}

export interface ToolCallResult {
    toolName: string;
    path?: string;
    success: boolean;
    linesCreated?: number;
    linesRead?: number;
    fileSize?: number;
}

export interface CursorTaskResult {
    success: boolean;
    content: string;
    sessionId?: string;
    model?: string; // The model used by Cursor
    toolCalls: string[];
    toolCallResults?: ToolCallResult[]; // Detailed tool call results
    error?: string;
    durationMs?: number; // Total duration in milliseconds
}

// ============ API Event Types ============

export interface ChatStreamEvent {
    type: 'content' | 'thinking' | 'tool_call' | 'status' | 'complete' | 'error';
    content?: string;
    sessionId?: string;
    toolName?: string;
    error?: string;
    isTaskComplete?: boolean;
}

export interface OrchestrateStreamEvent {
    type: 'thinking' | 'message' | 'tool_start' | 'tool_end' | 'dispatch_order' | 'chat_update' | 'cursor_progress' | 'result' | 'error';
    content?: string;
    chatId?: string;
    taskId?: string;
    success?: boolean;
    tasksExecuted?: number;
    error?: string;
}

// ============ Store/State Types ============

export interface ChatStore {
    sessions: Map<string, ChatSession>;
    activeProcesses: Map<string, AbortController>;
}

export interface OrchestrateState {
    messages: OrchestrateMessage[];
    activeTasks: Map<string, OrchestrateTask>;
    isRunning: boolean;
}
