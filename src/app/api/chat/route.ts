/**
 * Chat API Route
 * Supports both single message and auto-conversation modes
 * Compatible with Vercel AI SDK v4 stream format
 */
import { spawn } from 'child_process';
import { ChatManager } from '@/lib/agent/chat-manager';
import { CursorAgentMessage, Message } from '@/lib/types';
import * as db from '@/lib/db';
import { generateId } from '@/lib/utils/id';
import { getSettings } from '@/lib/settings';
import {
    registerCursorCall,
    setCallProcess,
    completeCursorCall,
} from '@/lib/agent/cursor-executor';

/**
 * Extract text content from Cursor message
 */
function extractText(msg: CursorAgentMessage): string | null {
    if (msg.type === 'assistant' && msg.message?.content) {
        return msg.message.content
            .filter((c) => c.type === 'text' && c.text)
            .map((c) => c.text)
            .join('');
    }
    if (msg.type === 'thinking' && msg.text) {
        return `💭 ${msg.text}`;
    }
    if (msg.type === 'tool_call' && msg.subtype === 'started' && msg.tool_call?.name) {
        return `🔧 Calling: ${msg.tool_call.name}`;
    }
    return null;
}

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * POST /api/chat
 *
 * Request body:
 * - messages: array of messages (for AI SDK compatibility)
 * - mode: 'single' | 'auto' (default: 'single')
 * - workdir: working directory (required for 'auto' mode)
 * - sessionId: cursor session ID to resume
 */
export async function POST(req: Request) {
    const body = await req.json();
    const { messages, mode = 'single', workdir: requestWorkdir, sessionId, id: chatId } = body;

    // Get the last user message
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage || lastMessage.role !== 'user') {
        return new Response('No user message', { status: 400 });
    }

    const prompt = lastMessage.content;

    // Get session's workdir and cursorSessionId if available
    let effectiveWorkdir = requestWorkdir;
    let effectiveSessionId = sessionId;
    const session = chatId ? db.getSessionMeta(chatId) : null;
    
    if (session?.workdir) {
        effectiveWorkdir = session.workdir;
    }
    if (session?.cursorSessionId && !effectiveSessionId) {
        effectiveSessionId = session.cursorSessionId; // Resume previous Cursor conversation
    }

    // Save user message to database if chatId is provided
    if (chatId) {
        // Check if session exists, if not create it
        if (!session) {
            db.createSession({
                id: chatId,
                title: prompt.substring(0, 50) + (prompt.length > 50 ? '...' : ''),
                status: 'running',
                messages: [],
                createdAt: new Date(),
                workdir: effectiveWorkdir,
            });
        } else {
            db.updateSession({ id: chatId, status: 'running' });
        }
        
        // Save user message
        const userMsg: Message = {
            id: lastMessage.id || generateId(),
            role: 'user',
            content: prompt,
            timestamp: new Date(),
            metadata: { source: 'user' },
        };
        db.addMessage(chatId, userMsg);
    }

    // Auto-conversation mode
    if (mode === 'auto') {
        if (!effectiveWorkdir) {
            return new Response('workdir is required for auto mode', { status: 400 });
        }

        return handleAutoMode(prompt, effectiveWorkdir, effectiveSessionId);
    }

    // Single message mode (default) - direct Cursor interaction
    return handleSingleMode(prompt, effectiveSessionId, chatId, effectiveWorkdir);
}

/**
 * Handle single message mode - streams directly from Cursor
 * Uses Vercel AI SDK v4 stream format:
 * - 0: text content (JSON string)
 * - 2: data array (must be JSON array, not object)
 * - d: done message
 *
 * 同时会通过 cursor-executor 的全局 tracker 统计当前运行中的 Cursor 进程，
 * 这样右上角的 "X active" 能实时反映 New Chat 调用的 agent 进程数。
 */
function handleSingleMode(prompt: string, sessionId?: string, chatId?: string, workdir?: string): Response {
    const encoder = new TextEncoder();

    // Get model from settings
    const settings = getSettings();
    const model = settings.model || 'auto';

    // Build command args
    const args = ['-p', '--output-format=stream-json', '--force'];
    if (sessionId) {
        args.push('--resume', sessionId);
    }
    // Always add model parameter (even for 'auto' to let Cursor choose)
    if (model) {
        args.push('--model', model);
    }

    // Register this call for system-status tracking
    const effectiveWorkdir = workdir || process.cwd();
    const callId = registerCursorCall(prompt, effectiveWorkdir, chatId, undefined);
    console.log('[handleSingleMode] Registered cursor call', { callId, chatId, workdir: effectiveWorkdir, prompt: prompt.slice(0, 50) });

    // Spawn cursor agent process with workdir as cwd
    const agent = spawn('agent', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: effectiveWorkdir,
    });

    // Save process reference so it can be killed if needed
    setCallProcess(callId, agent);

    const stream = new ReadableStream({
        async start(controller) {
            let buffer = '';
            let cursorSessionId: string | undefined;
            let fullResponse = ''; // Accumulate full response for saving
            let stderrBuffer = ''; // Capture stderr for error messages

            // Send prompt to stdin and close
            agent.stdin.write(prompt);
            agent.stdin.end();

            // Process stdout line by line
            agent.stdout.on('data', (chunk: Buffer) => {
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (!line.trim()) continue;

                    try {
                        const msg: CursorAgentMessage = JSON.parse(line);

                        // Capture session ID (don't send as data part to avoid format issues)
                        if (msg.session_id && !cursorSessionId) {
                            cursorSessionId = msg.session_id;
                        }

                        const text = extractText(msg);
                        if (text) {
                            // Accumulate response (skip tool calls and thinking for saved message)
                            if (msg.type === 'assistant') {
                                fullResponse += text;
                            }
                            
                            // Send as AI SDK compatible format (text part)
                            const data = `0:${JSON.stringify(text)}\n`;
                            controller.enqueue(encoder.encode(data));
                        }
                    } catch {
                        // Ignore non-JSON lines
                    }
                }
            });

            // Capture stderr for error messages
            agent.stderr.on('data', (chunk: Buffer) => {
                const text = chunk.toString();
                stderrBuffer += text;
                console.error('[Agent stderr]', text);
            });

            // Handle process completion
            agent.on('close', (code) => {
                if (code !== 0) {
                    // Extract meaningful error message from stderr
                    let errorMsg = `⚠️ Agent exited with code ${code}`;
                    
                    // Common error patterns to extract
                    if (stderrBuffer.includes('Slow Pool Error')) {
                        // Extract the specific error message about model availability
                        const match = stderrBuffer.match(/Slow Pool Error[^.]+\./);
                        if (match) {
                            errorMsg = `⚠️ ${match[0]} Please check your Cursor subscription settings.`;
                        }
                    } else if (stderrBuffer.includes('rate limit')) {
                        errorMsg = '⚠️ Rate limit exceeded. Please wait a moment and try again.';
                    } else if (stderrBuffer.includes('authentication') || stderrBuffer.includes('unauthorized')) {
                        errorMsg = '⚠️ Authentication error. Please check your Cursor login status.';
                    } else if (stderrBuffer.includes('network') || stderrBuffer.includes('ECONNREFUSED')) {
                        errorMsg = '⚠️ Network error. Please check your internet connection.';
                    } else if (stderrBuffer.trim()) {
                        // Use the stderr content if available but not matched above
                        const cleanedStderr = stderrBuffer.trim().split('\n')[0]; // First line
                        if (cleanedStderr.length < 200) {
                            errorMsg = `⚠️ ${cleanedStderr}`;
                        }
                    }
                    
                    controller.enqueue(encoder.encode(`0:${JSON.stringify('\n\n' + errorMsg)}\n`));
                }
                
                // Mark call as completed / errored for system-status
                console.log('[handleSingleMode] Completing cursor call', { callId, success: code === 0 });
                completeCursorCall(callId, code === 0);

                // Save assistant response and cursor session ID to database
                if (chatId && fullResponse) {
                    const assistantMsg: Message = {
                        id: generateId(),
                        role: 'assistant',
                        content: fullResponse,
                        timestamp: new Date(),
                        metadata: { source: 'cursor' },
                    };
                    db.addMessage(chatId, assistantMsg);
                    db.updateSession({ 
                        id: chatId, 
                        status: 'completed',
                        cursorSessionId: cursorSessionId, // Save for resuming conversation
                    });
                }
                
                // Send finish message (d: done)
                // Note: finishReason is standard, custom data should not be in d: part
                controller.enqueue(
                    encoder.encode(`d:{"finishReason":"stop"}\n`)
                );
                controller.close();
            });

            // Handle errors
            agent.on('error', (err) => {
                const errorMsg = `Error: ${err.message}`;
                controller.enqueue(encoder.encode(`0:${JSON.stringify(errorMsg)}\n`));
                controller.enqueue(encoder.encode('d:{"finishReason":"error"}\n'));
                // Mark call as error
                console.log('[handleSingleMode] Completing cursor call (error)', { callId });
                completeCursorCall(callId, false);

                if (chatId) {
                    db.updateSession({ id: chatId, status: 'error' });
                }
                controller.close();
            });
        },
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'X-Vercel-AI-Data-Stream': 'v1',
        },
    });
}

/**
 * Handle auto-conversation mode - AI manages the conversation until task complete
 */
function handleAutoMode(task: string, workdir: string, sessionId?: string): Response {
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
        async start(controller) {
            const chatManager = new ChatManager();

            try {
                const result = await chatManager.runConversation(
                    task,
                    workdir,
                    (event) => {
                        // Stream progress events
                        const eventData = JSON.stringify(event);
                        controller.enqueue(encoder.encode(`data: ${eventData}\n\n`));
                    },
                    sessionId
                );

                // Send final result
                controller.enqueue(
                    encoder.encode(
                        `data: ${JSON.stringify({
                            type: 'final_result',
                            success: result.success,
                            turns: result.turns,
                            cursorSessionId: result.cursorSessionId,
                            messageCount: result.messages.length,
                        })}\n\n`
                    )
                );
            } catch (error) {
                controller.enqueue(
                    encoder.encode(
                        `data: ${JSON.stringify({
                            type: 'error',
                            error: error instanceof Error ? error.message : String(error),
                        })}\n\n`
                    )
                );
            } finally {
                controller.close();
            }
        },
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
        },
    });
}
