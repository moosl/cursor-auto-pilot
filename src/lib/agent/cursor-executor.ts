/**
 * Cursor Agent CLI Executor
 * Manages subprocess communication with cursor-agent CLI
 * Supports persistent sessions and bidirectional conversation
 */
import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { CursorAgentMessage, CursorTaskResult, ChatStreamEvent, ToolCallResult } from '../types';
import { getSettings } from '../settings';

export interface TaskProgress {
    type: 'thinking' | 'assistant' | 'tool_call' | 'tool_result' | 'status' | 'model_info';
    content: string;
    // Additional details for tool results
    toolResult?: {
        toolName: string;
        path?: string;
        success: boolean;
        linesCreated?: number;
        linesRead?: number;
        fileSize?: number;
    };
    // Model info for system init
    model?: string;
}

/**
 * Active Cursor Call Tracker
 * Tracks all ongoing Cursor agent calls globally
 */
export interface ActiveCursorCall {
    id: string;
    chatId?: string;
    chatTitle?: string;
    task: string;
    workdir: string;
    startTime: Date;
    status: 'running' | 'completed' | 'error';
    model?: string; // The model being used by Cursor
    process?: ChildProcess; // Reference to the actual process for killing
}

// Use globalThis for persistence across hot reloads
const globalForCursorTracker = globalThis as unknown as {
    activeCursorCalls: Map<string, ActiveCursorCall> | undefined;
};

export const activeCursorCalls = globalForCursorTracker.activeCursorCalls ?? new Map<string, ActiveCursorCall>();
if (process.env.NODE_ENV !== 'production') {
    globalForCursorTracker.activeCursorCalls = activeCursorCalls;
}

function generateCallId(): string {
    return `call_${Date.now().toString(36)}_${Math.random().toString(36).substr(2, 6)}`;
}

export function registerCursorCall(task: string, workdir: string, chatId?: string, chatTitle?: string): string {
    const id = generateCallId();
    activeCursorCalls.set(id, {
        id,
        chatId,
        chatTitle,
        task: task.slice(0, 200), // Truncate for display
        workdir,
        startTime: new Date(),
        status: 'running',
    });
    console.log('[registerCursorCall] Registered', { id, chatId, activeCount: activeCursorCalls.size, runningCount: getActiveCursorCalls().length });
    return id;
}

export function setCallProcess(id: string, process: ChildProcess): void {
    const call = activeCursorCalls.get(id);
    if (call) {
        call.process = process;
    }
}

export function completeCursorCall(id: string, success: boolean): void {
    const call = activeCursorCalls.get(id);
    if (call) {
        call.status = success ? 'completed' : 'error';
        call.process = undefined; // Clear process reference
        console.log('[completeCursorCall] Completed', { id, success, activeCount: activeCursorCalls.size, runningCount: getActiveCursorCalls().length });
        // Remove after a short delay to allow UI to show completion
        setTimeout(() => {
            activeCursorCalls.delete(id);
            console.log('[completeCursorCall] Removed', { id, activeCount: activeCursorCalls.size, runningCount: getActiveCursorCalls().length });
        }, 5000);
    } else {
        console.warn('[completeCursorCall] Call not found', { id });
    }
}

export function getActiveCursorCalls(): ActiveCursorCall[] {
    return Array.from(activeCursorCalls.values()).filter(c => c.status === 'running');
}

/**
 * Kill all Cursor processes associated with a chatId
 * @returns number of processes killed
 */
export function killCursorProcessesByChatId(chatId: string): number {
    let killed = 0;
    for (const [id, call] of activeCursorCalls.entries()) {
        if (call.chatId === chatId && call.status === 'running' && call.process) {
            try {
                call.process.kill('SIGKILL'); // Use SIGKILL for immediate termination
                call.status = 'error';
                call.process = undefined;
                killed++;
                console.log(`[CursorExecutor] Killed process for chatId=${chatId}, callId=${id}`);
            } catch (e) {
                console.error(`[CursorExecutor] Failed to kill process for callId=${id}:`, e);
            }
        }
    }
    return killed;
}

/**
 * Interactive Cursor Agent Session
 * Maintains a persistent process for bidirectional communication
 */
export class CursorAgentSession extends EventEmitter {
    private process: ChildProcess | null = null;
    private sessionId?: string;
    private modelName?: string;
    private buffer: string = '';
    private isRunning: boolean = false;
    private responseResolve: ((result: CursorTaskResult) => void) | null = null;
    private currentContent: string = '';
    private currentToolCalls: string[] = [];
    private currentToolCallResults: ToolCallResult[] = [];
    private workdir: string;
    private resumeSessionId?: string;
    private configuredModel?: string;

    constructor(workdir: string, resumeSessionId?: string, model?: string) {
        super();
        this.workdir = workdir;
        this.resumeSessionId = resumeSessionId;
        this.configuredModel = model;
    }

    get cursorSessionId(): string | undefined {
        return this.sessionId;
    }

    get cursorModel(): string | undefined {
        return this.modelName;
    }

    get running(): boolean {
        return this.isRunning;
    }

    /**
     * Start a new cursor agent process
     */
    async start(): Promise<void> {
        if (this.process) {
            throw new Error('Session already started');
        }

        // Get model from config or settings
        const settings = getSettings();
        const model = this.configuredModel || settings.model || 'auto';

        // Build command args - use print mode for interactive with streaming partial output
        const args = ['-p', '--output-format=stream-json', '--stream-partial-output', '--force'];
        if (this.resumeSessionId) {
            args.push('--resume', this.resumeSessionId);
        }
        // Always add model parameter (even for 'auto' to let Cursor choose)
        if (model) {
            args.push('--model', model);
        }

        this.process = spawn('agent', args, {
            cwd: this.workdir,
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        this.isRunning = true;
        this.setupProcessHandlers();
    }

    /**
     * Send a message to the cursor agent and wait for response
     */
    async sendMessage(message: string): Promise<CursorTaskResult> {
        if (!this.process || !this.isRunning) {
            throw new Error('Session not started or already closed');
        }

        this.currentContent = '';
        this.currentToolCalls = [];
        this.currentToolCallResults = [];

        return new Promise((resolve) => {
            this.responseResolve = resolve;

            // Send message to stdin
            this.process!.stdin?.write(message + '\n');
            this.process!.stdin?.end();
        });
    }

    /**
     * Stop the cursor agent process
     */
    stop(): void {
        if (this.process) {
            this.process.kill('SIGTERM');
            this.process = null;
            this.isRunning = false;
        }
    }

    private setupProcessHandlers(): void {
        if (!this.process) return;

        // Process stdout
        this.process.stdout?.on('data', (chunk: Buffer) => {
            this.buffer += chunk.toString();
            this.processBuffer();
        });

        // Process stderr
        this.process.stderr?.on('data', (chunk: Buffer) => {
            console.error('[Cursor Agent stderr]', chunk.toString());
        });

        // Handle close
        this.process.on('close', (code) => {
            this.isRunning = false;

            const result: CursorTaskResult = {
                success: code === 0,
                content: this.currentContent,
                sessionId: this.sessionId,
                model: this.modelName,
                toolCalls: this.currentToolCalls,
                toolCallResults: this.currentToolCallResults,
                error: code !== 0 ? `Agent exited with code ${code}` : undefined,
            };

            if (this.responseResolve) {
                this.responseResolve(result);
                this.responseResolve = null;
            }

            this.emit('close', result);
        });

        // Handle error
        this.process.on('error', (err) => {
            this.isRunning = false;

            const result: CursorTaskResult = {
                success: false,
                content: this.currentContent,
                sessionId: this.sessionId,
                model: this.modelName,
                toolCalls: this.currentToolCalls,
                toolCallResults: this.currentToolCallResults,
                error: err.message,
            };

            if (this.responseResolve) {
                this.responseResolve(result);
                this.responseResolve = null;
            }

            this.emit('error', err);
        });
    }

    private processBuffer(): void {
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || '';

        for (const line of lines) {
            if (!line.trim()) continue;

            try {
                const msg: CursorAgentMessage = JSON.parse(line);
                this.handleMessage(msg);
            } catch {
                // Ignore non-JSON lines
            }
        }
    }

    private handleMessage(msg: CursorAgentMessage): void {
        // Extract session ID
        if (msg.session_id && !this.sessionId) {
            this.sessionId = msg.session_id;
            this.emit('session', this.sessionId);
        }

        switch (msg.type) {
            case 'system':
                // Handle system init message to get model info
                if (msg.subtype === 'init' && msg.model) {
                    this.modelName = msg.model;
                    this.emit('model', { type: 'status', content: `Model: ${msg.model}` } as ChatStreamEvent);
                }
                break;

            case 'assistant':
                if (msg.message?.content) {
                    const text = msg.message.content
                        .filter((c) => c.type === 'text' && c.text)
                        .map((c) => c.text)
                        .join('');
                    this.currentContent += text;
                    this.emit('content', { type: 'content', content: text } as ChatStreamEvent);
                }
                break;

            case 'thinking':
                if (msg.text) {
                    this.emit('thinking', { type: 'thinking', content: msg.text } as ChatStreamEvent);
                }
                break;

            case 'tool_call':
                if (msg.subtype === 'started' && msg.tool_call?.name) {
                    this.currentToolCalls.push(msg.tool_call.name);
                    this.emit('tool_call', {
                        type: 'tool_call',
                        toolName: msg.tool_call.name,
                    } as ChatStreamEvent);
                } else if (msg.subtype === 'completed' && msg.tool_call) {
                    // Handle completed tool calls with results
                    const toolResult = this.extractToolResult(msg);
                    if (toolResult) {
                        this.currentToolCallResults.push(toolResult);
                        this.emit('tool_result', {
                            type: 'status',
                            content: this.formatToolResult(toolResult),
                        } as ChatStreamEvent);
                    }
                }
                break;

            case 'result':
                // Final result with duration
                if (msg.duration_ms) {
                    this.emit('complete', {
                        type: 'complete',
                        content: `Completed in ${msg.duration_ms}ms`,
                    } as ChatStreamEvent);
                }
                break;
        }
    }

    /**
     * Extract tool result from completed tool call message
     */
    private extractToolResult(msg: CursorAgentMessage): ToolCallResult | null {
        const toolCall = msg.tool_call;
        if (!toolCall) return null;

        // Handle write tool calls
        if (toolCall.writeToolCall) {
            const write = toolCall.writeToolCall;
            return {
                toolName: 'write',
                path: write.args?.path,
                success: !!write.result?.success,
                linesCreated: write.result?.success?.linesCreated,
                fileSize: write.result?.success?.fileSize,
            };
        }

        // Handle read tool calls
        if (toolCall.readToolCall) {
            const read = toolCall.readToolCall;
            return {
                toolName: 'read',
                path: read.args?.path,
                success: !!read.result?.success,
                linesRead: read.result?.success?.totalLines,
            };
        }

        // Generic tool call
        if (toolCall.name) {
            return {
                toolName: toolCall.name,
                success: true,
            };
        }

        return null;
    }

    /**
     * Format tool result for display
     */
    private formatToolResult(result: ToolCallResult): string {
        const status = result.success ? '✅' : '❌';
        const path = result.path ? ` ${result.path}` : '';
        
        if (result.toolName === 'write' && result.linesCreated !== undefined) {
            return `${status} Created${path} (${result.linesCreated} lines, ${result.fileSize} bytes)`;
        }
        if (result.toolName === 'read' && result.linesRead !== undefined) {
            return `${status} Read${path} (${result.linesRead} lines)`;
        }
        return `${status} ${result.toolName}${path}`;
    }
}

/**
 * Execute a one-shot task using Cursor Agent CLI
 */
export async function executeCursorTask(
    task: string,
    workdir: string,
    options?: {
        sessionId?: string;
        onProgress?: (progress: TaskProgress) => void;
        chatId?: string;
        chatTitle?: string;
        model?: string;
    }
): Promise<CursorTaskResult> {
    // Register this call for tracking
    const callId = registerCursorCall(task, workdir, options?.chatId, options?.chatTitle);
    
    // Get model from options or settings
    const settings = getSettings();
    const model = options?.model || settings.model || 'auto';
    
    return new Promise((resolve) => {
        // Build command args with stream-partial-output for real-time progress
        const args = ['-p', '--output-format=stream-json', '--stream-partial-output', '--force'];
        if (options?.sessionId) {
            args.push('--resume', options.sessionId);
        }
        // Always add model parameter (even for 'auto' to let Cursor choose)
        if (model) {
            args.push('--model', model);
        }

        // Spawn agent process
        const agent = spawn('agent', args, {
            cwd: workdir,
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        // Save process reference for killing
        setCallProcess(callId, agent);

        // State
        let sessionId: string | undefined;
        let modelName: string | undefined;
        let content = '';
        const toolCalls: string[] = [];
        const toolCallResults: ToolCallResult[] = [];
        let buffer = '';
        let durationMs: number | undefined;

        // Send task to stdin
        agent.stdin.write(task);
        agent.stdin.end();

        // Helper to extract tool result
        const extractToolResult = (msg: CursorAgentMessage): ToolCallResult | null => {
            const toolCall = msg.tool_call;
            if (!toolCall) return null;

            if (toolCall.writeToolCall) {
                const write = toolCall.writeToolCall;
                return {
                    toolName: 'write',
                    path: write.args?.path,
                    success: !!write.result?.success,
                    linesCreated: write.result?.success?.linesCreated,
                    fileSize: write.result?.success?.fileSize,
                };
            }

            if (toolCall.readToolCall) {
                const read = toolCall.readToolCall;
                return {
                    toolName: 'read',
                    path: read.args?.path,
                    success: !!read.result?.success,
                    linesRead: read.result?.success?.totalLines,
                };
            }

            if (toolCall.name) {
                return {
                    toolName: toolCall.name,
                    success: true,
                };
            }

            return null;
        };

        // Helper to format tool result
        const formatToolResult = (result: ToolCallResult): string => {
            const status = result.success ? '✅' : '❌';
            const path = result.path ? ` ${result.path}` : '';
            
            if (result.toolName === 'write' && result.linesCreated !== undefined) {
                return `${status} Created${path} (${result.linesCreated} lines, ${result.fileSize} bytes)`;
            }
            if (result.toolName === 'read' && result.linesRead !== undefined) {
                return `${status} Read${path} (${result.linesRead} lines)`;
            }
            return `${status} ${result.toolName}${path}`;
        };

        // Process stdout line by line
        agent.stdout.on('data', (chunk: Buffer) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.trim()) continue;

                try {
                    const msg: CursorAgentMessage = JSON.parse(line);

                    // Extract session_id
                    if (msg.session_id && !sessionId) {
                        sessionId = msg.session_id;
                    }

                    // Handle different message types
                    switch (msg.type) {
                        case 'system':
                            // Handle system init message to get model info
                            if (msg.subtype === 'init' && msg.model) {
                                modelName = msg.model;
                                options?.onProgress?.({
                                    type: 'model_info',
                                    content: `🤖 Using model: ${msg.model}`,
                                    model: msg.model,
                                });
                            }
                            break;

                        case 'assistant':
                            if (msg.message?.content) {
                                const text = msg.message.content
                                    .filter((c) => c.type === 'text' && c.text)
                                    .map((c) => c.text)
                                    .join('');
                                // Only add if this text is not already at the end of content
                                // This handles cases where Cursor sends cumulative content
                                if (text && !content.endsWith(text)) {
                                    // Check if this is a cumulative update (contains existing content)
                                    if (text.length > content.length && text.startsWith(content)) {
                                        // This is a cumulative update - replace content
                                        content = text;
                                    } else if (!content.includes(text)) {
                                        // This is new incremental content - append
                                        content += text;
                                    }
                                    // else: duplicate content, skip
                                }
                                options?.onProgress?.({ type: 'assistant', content: text });
                            }
                            break;

                        case 'thinking':
                            if (msg.text) {
                                options?.onProgress?.({ type: 'thinking', content: msg.text });
                            }
                            break;

                        case 'tool_call':
                            if (msg.subtype === 'started' && msg.tool_call?.name) {
                                toolCalls.push(msg.tool_call.name);
                                options?.onProgress?.({
                                    type: 'tool_call',
                                    content: msg.tool_call.name,
                                });
                            } else if (msg.subtype === 'completed' && msg.tool_call) {
                                // Handle completed tool calls with results
                                const toolResult = extractToolResult(msg);
                                if (toolResult) {
                                    toolCallResults.push(toolResult);
                                    options?.onProgress?.({
                                        type: 'tool_result',
                                        content: formatToolResult(toolResult),
                                        toolResult,
                                    });
                                }
                            }
                            break;

                        case 'result':
                            // Final result with duration
                            if (msg.duration_ms) {
                                durationMs = msg.duration_ms;
                                options?.onProgress?.({
                                    type: 'status',
                                    content: `⏱️ Completed in ${msg.duration_ms}ms`,
                                });
                            }
                            break;
                    }
                } catch {
                    // Ignore non-JSON lines
                }
            }
        });

        // Capture stderr
        let stderr = '';
        agent.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
        });

        // Handle process exit
        agent.on('close', (code) => {
            // Mark call as completed
            completeCursorCall(callId, code === 0);

            if (code === 0) {
                resolve({
                    success: true,
                    content,
                    sessionId,
                    model: modelName,
                    toolCalls,
                    toolCallResults,
                    durationMs,
                });
            } else {
                resolve({
                    success: false,
                    content,
                    sessionId,
                    model: modelName,
                    toolCalls,
                    toolCallResults,
                    error: stderr || `Agent exited with code ${code}`,
                    durationMs,
                });
            }
        });

        agent.on('error', (err) => {
            // Mark call as error
            completeCursorCall(callId, false);
            
            resolve({
                success: false,
                content,
                sessionId,
                model: modelName,
                toolCalls,
                toolCallResults,
                error: err.message,
            });
        });
    });
}

/**
 * Legacy streaming executor for backward compatibility
 */
export class CursorTaskRunner extends EventEmitter {
    private process: ChildProcess | null = null;

    async run(task: string, workdir: string, resumeSessionId?: string): Promise<CursorTaskResult> {
        return executeCursorTask(task, workdir, {
            sessionId: resumeSessionId,
            onProgress: (progress) => this.emit('progress', progress),
        });
    }

    cancel(): void {
        if (this.process) {
            this.process.kill('SIGTERM');
            this.process = null;
        }
    }
}

export type { CursorAgentMessage };
