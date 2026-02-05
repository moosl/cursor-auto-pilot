/**
 * Orchestrate API Route
 * Handles complex requests through Claude Agent orchestration
 */
import { OrchestratorAgent } from '@/lib/agent/orchestrator';
import * as db from '@/lib/db';

export const runtime = 'nodejs';
export const maxDuration = 300; // 5 minutes

interface ChatHistoryMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
}

export async function POST(req: Request) {
    const encoder = new TextEncoder();

    try {
        const { request, workdir, skillsPath, chatId, chatHistory } = await req.json();

        if (!request || !workdir) {
            return new Response(
                JSON.stringify({ error: 'Missing request or workdir' }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }

        // If chatId provided, update session status and save user message
        if (chatId) {
            console.log(`[orchestrate] Processing request for chatId=${chatId}`);
            const session = db.getSessionMeta(chatId);
            if (session) {
                console.log(`[orchestrate] Session exists, updating status`);
                db.updateSession({ id: chatId, status: 'running' });
            } else {
                // Create session if it doesn't exist
                // Check if this is the web orchestrator main session
                const isWebOrchestratorMain = chatId === 'web_orchestrator_main';
                console.log(`[orchestrate] Creating new session, isWebOrchestratorMain=${isWebOrchestratorMain}`);
                db.createSession({
                    id: chatId,
                    title: isWebOrchestratorMain ? 'Web Orchestrator' : request.substring(0, 50) + (request.length > 50 ? '...' : ''),
                    status: 'running',
                    messages: [],
                    createdAt: new Date(),
                    workdir,
                    orchestrateTaskId: isWebOrchestratorMain ? undefined : chatId,
                    isOrchestratorManaged: isWebOrchestratorMain, // Hide from sidebar
                });
            }
            
            // Save user message
            console.log(`[orchestrate] Saving user message to chatId=${chatId}`);
            db.addMessage(chatId, {
                id: Date.now().toString(36) + Math.random().toString(36).substr(2),
                role: 'user',
                content: request,
                timestamp: new Date(),
                metadata: { source: 'user' },
            });
        }

        // Create streaming response
        const stream = new ReadableStream({
            async start(controller) {
                const agent = new OrchestratorAgent({ skillsPath });
                let isClosed = false;

                // Safe enqueue function that checks if controller is still open
                const safeEnqueue = (data: string) => {
                    if (!isClosed) {
                        try {
                            controller.enqueue(encoder.encode(data));
                        } catch {
                            // Controller is closed, mark it
                            isClosed = true;
                        }
                    }
                };

                try {
                    // Build context from chat history if provided
                    const contextMessages: ChatHistoryMessage[] = chatHistory || [];
                    
                    const result = await agent.run(
                        request, 
                        workdir, 
                        (event) => {
                            // Send progress events as SSE
                            const data = JSON.stringify(event) + '\n';
                            safeEnqueue(`data: ${data}\n`);
                            
                            // Save messages to database
                            if (chatId) {
                                if (event.type === 'message' && event.content) {
                                    // Assistant's text messages
                                    db.addMessage(chatId, {
                                        id: Date.now().toString(36) + Math.random().toString(36).substr(2),
                                        role: 'assistant',
                                        content: event.content,
                                        timestamp: new Date(),
                                        metadata: { source: 'orchestrator' },
                                    });
                                } else if (event.type === 'tool_start' && event.content) {
                                    // Tool execution start
                                    db.addMessage(chatId, {
                                        id: Date.now().toString(36) + Math.random().toString(36).substr(2),
                                        role: 'system',
                                        content: `🔧 Executing: ${event.content}`,
                                        timestamp: new Date(),
                                        metadata: { source: 'orchestrator' },
                                    });
                                }
                            }
                        },
                        chatId, // Pass chatId to orchestrator
                        contextMessages // Pass chat history for context
                    );

                    // Update session status on completion and save result message
                    if (chatId) {
                        db.updateSession({ 
                            id: chatId, 
                            status: result.success ? 'idle' : 'error'  // Use 'idle' so panel can be used again
                        });
                        
                        // Save result as system message
                        db.addMessage(chatId, {
                            id: Date.now().toString(36) + Math.random().toString(36).substr(2),
                            role: 'system',
                            content: result.success 
                                ? `✅ Orchestration complete! (${result.tasks_executed} tasks)`
                                : `❌ Failed: ${result.error}`,
                            timestamp: new Date(),
                            metadata: { source: 'orchestrator' },
                        });
                    }

                    // Send final result
                    safeEnqueue(`data: ${JSON.stringify({ type: 'result', ...result })}\n\n`);
                } catch (error) {
                    if (chatId) {
                        db.updateSession({ id: chatId, status: 'error' });
                    }
                    safeEnqueue(
                        `data: ${JSON.stringify({
                            type: 'error',
                            error: error instanceof Error ? error.message : String(error),
                        })}\n\n`
                    );
                } finally {
                    if (!isClosed) {
                        isClosed = true;
                        controller.close();
                    }
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
    } catch (error) {
        return new Response(
            JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
}
