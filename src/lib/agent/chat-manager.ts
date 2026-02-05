/**
 * Chat Manager
 * Manages chat sessions with Cursor Agent
 * Uses Agent Manager prompt for intelligent conversation flow
 */
import Anthropic from '@anthropic-ai/sdk';
import { executeCursorTask } from './cursor-executor';
import { Message, ChatStatus, CursorTaskResult } from '../types';
import { buildAgentManagerPrompt } from '../prompts';
import { generateId } from '../utils/id';

/**
 * Extract task.md content from Agent Manager response
 * Simply looks for ```task.md ... ``` block - Agent Manager handles the formatting
 */
function extractTaskMd(response: string): string | null {
    const match = response.match(/```task\.md\s*([\s\S]*?)```/);
    if (match && match[1].trim()) {
        return match[1].trim();
    }
    return null;
}

export interface ChatManagerConfig {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    maxTurns?: number; // Maximum conversation turns before stopping
}

export interface ChatProgressEvent {
    type: 'cursor_response' | 'ai_followup' | 'thinking' | 'tool_call' | 'tool_result' | 'model_info' | 'status_change' | 'complete' | 'state_detected' | 'task_md_update';
    content?: string;
    status?: ChatStatus;
    isTaskComplete?: boolean;
    turn?: number;
    state?: AgentState;
    taskMd?: string; // Updated task.md content
    model?: string; // The model being used by Cursor
}

export type ChatProgressCallback = (event: ChatProgressEvent) => void;

// Agent states based on the Agent Manager prompt
export type AgentState = 'WORKING' | 'BLOCKED' | 'ASKING' | 'COMPLETED' | 'PARTIAL' | 'UNKNOWN';

/**
 * Manages a chat session with intelligent conversation flow
 */
export class ChatManager {
    private client: Anthropic;
    private model: string;
    private maxTurns: number;

    constructor(config: ChatManagerConfig = {}) {
        this.client = new Anthropic({
            apiKey: config.apiKey || process.env.ANTHROPIC_API_KEY,
            baseURL: config.baseUrl || process.env.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_API_BASE,
        });
        this.model = config.model || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
        this.maxTurns = config.maxTurns || 10;
    }

    /**
     * Run an automatic conversation loop with Cursor Agent
     * Uses Agent Manager prompt to intelligently manage the conversation
     * 
     * Flow:
     * 1. Task (with TODO request) is sent to Cursor
     * 2. Cursor responds with TODO list
     * 3. Agent Manager extracts TODO, saves to task.md, confirms
     * 4. Loop: Cursor works → Agent Manager responds → repeat until done
     */
    async runConversation(
        initialTask: string,
        workdir: string,
        onProgress?: ChatProgressCallback,
        existingSessionId?: string,
        taskMd?: string // Task description for completion checking
    ): Promise<{
        success: boolean;
        messages: Message[];
        cursorSessionId?: string;
        turns: number;
        finalTaskMd?: string; // Final task.md content with progress
    }> {
        const messages: Message[] = [];
        let cursorSessionId = existingSessionId;
        let turn = 0;
        let isTaskComplete = false;
        let currentTaskMd = taskMd || ''; // Track task.md content

        // Build initial task with working rules
        const workingRules = `
## WORKING RULES (IMPORTANT - Follow strictly)

1. **One task at a time**: Complete only ONE task from the TODO list, then STOP and wait for my confirmation before starting the next task.

2. **Ask before acting**: If you have ANY questions, uncertainties, or need to make important decisions (like choosing between approaches, file locations, naming conventions, etc.), you MUST ask me and wait for my confirmation before proceeding.

3. **Report completion**: After completing each task, clearly state what you did and ask "Should I proceed with the next task?"

4. **No assumptions**: Do NOT assume answers to questions. Always ask if unsure.

---

## TASK:
${initialTask}`;

        // Add initial task as user message
        messages.push({
            id: generateId(),
            role: 'user',
            content: workingRules,
            timestamp: new Date(),
        });

        onProgress?.({ type: 'status_change', status: 'running' });

        console.log(`[ChatManager] Starting conversation loop, maxTurns=${this.maxTurns}`);
        
        while (turn < this.maxTurns && !isTaskComplete) {
            turn++;
            console.log(`[ChatManager] Turn ${turn}: Starting, isTaskComplete=${isTaskComplete}`);
            onProgress?.({ type: 'status_change', status: 'running', turn });

            // Get the last message to send to Cursor
            const lastMessage = messages[messages.length - 1];
            
            // CRITICAL: If last message contains "Mission Complete", stop immediately
            // This prevents sending completion messages to Cursor
            if (lastMessage.content.toLowerCase().includes('mission complete')) {
                console.log('[ChatManager] Detected Mission Complete in last message, stopping loop');
                isTaskComplete = true;
                break;
            }
            
            // For system messages (from Agent Manager), extract the actual content without the emoji prefix
            let messageToSend = lastMessage.content;
            if (lastMessage.role === 'system' && messageToSend.startsWith('🤖 ')) {
                messageToSend = messageToSend.slice(3); // Remove "🤖 " prefix
            }
            if (lastMessage.role === 'system' && messageToSend.startsWith('✅ ')) {
                messageToSend = messageToSend.slice(3); // Remove "✅ " prefix
            }

            // Send to Cursor Agent
            const cursorResult = await executeCursorTask(messageToSend, workdir, {
                sessionId: cursorSessionId,
                onProgress: (progress) => {
                    if (progress.type === 'thinking') {
                        onProgress?.({ type: 'thinking', content: progress.content });
                    } else if (progress.type === 'tool_call') {
                        onProgress?.({ type: 'tool_call', content: progress.content });
                    } else if (progress.type === 'tool_result') {
                        onProgress?.({ type: 'tool_result', content: progress.content });
                    } else if (progress.type === 'model_info') {
                        onProgress?.({ type: 'model_info', content: progress.content, model: progress.model });
                    }
                },
            });

            // Update session ID if first turn
            if (!cursorSessionId && cursorResult.sessionId) {
                cursorSessionId = cursorResult.sessionId;
            }

            // Add Cursor's response
            messages.push({
                id: generateId(),
                role: 'assistant',
                content: cursorResult.content,
                timestamp: new Date(),
                metadata: {
                    toolCalls: cursorResult.toolCalls,
                },
            });

            onProgress?.({
                type: 'cursor_response',
                content: cursorResult.content,
                isTaskComplete: false,
                turn,
            });

            // If Cursor failed, stop
            if (!cursorResult.success) {
                onProgress?.({ type: 'status_change', status: 'error' });
                return {
                    success: false,
                    messages,
                    cursorSessionId,
                    turns: turn,
                    finalTaskMd: currentTaskMd,
                };
            }

            // Use Agent Manager to analyze response and decide next action
            const { nextAction, state, isComplete, newTaskMd } = await this.analyzeAndDecide(
                initialTask,
                messages,
                currentTaskMd,
                turn // Pass turn number to help Agent Manager know context
            );

            // Handle task.md updates from Agent Manager
            // Agent Manager is responsible for extracting and formatting the TODO list
            if (newTaskMd) {
                currentTaskMd = newTaskMd;
                onProgress?.({
                    type: 'task_md_update',
                    taskMd: currentTaskMd,
                    content: 'TODO list updated',
                });
            }

            // Report detected state
            onProgress?.({
                type: 'state_detected',
                state,
                content: `State: ${state}`,
            });

            // Clean the nextAction - remove task.md block and UPDATE_TASK commands
            let cleanedAction = nextAction;
            
            // Extract and emit thinking block if present
            const thinkMatch = cleanedAction.match(/<think>([\s\S]*?)<\/think>/);
            let thinkContent: string | undefined;
            if (thinkMatch) {
                thinkContent = thinkMatch[1].trim();
                if (thinkContent) {
                    onProgress?.({ type: 'thinking', content: thinkContent });
                }
                // Remove thinking block from the action
                cleanedAction = cleanedAction.replace(/<think>[\s\S]*?<\/think>/, '').trim();
            }
            
            cleanedAction = cleanedAction.replace(/```task\.md[\s\S]*?```/g, '').trim();
            cleanedAction = cleanedAction.replace(/\[UPDATE_TASK:[^\]]+\]/g, '').trim();
            
            // Check if original response contained "mission complete" before cleaning it
            const hadMissionComplete = /mission\s*complete/gi.test(cleanedAction);
            cleanedAction = cleanedAction.replace(/mission\s*complete/gi, '').trim();

            // Check if task is complete - STOP THE LOOP
            // Trust Agent Manager's judgment (isComplete from prompt response)
            if (isComplete) {
                console.log(`[ChatManager] Turn ${turn}: Agent Manager says complete, breaking loop`);
                isTaskComplete = true;
                
                // Build completion message with thinking if available
                let completionContent = '✅ Mission Complete';
                if (thinkContent) {
                    completionContent = `${thinkContent}\n\n✅ Mission Complete`;
                }
                
                onProgress?.({ type: 'ai_followup', content: completionContent });
                messages.push({
                    id: generateId(),
                    role: 'system',
                    content: completionContent,
                    timestamp: new Date(),
                });
                break;
            }
            
            // If Agent Manager gave an empty response after cleaning
            if (!cleanedAction || cleanedAction.length < 3) {
                // If the original response had "Mission Complete", treat as completed
                if (hadMissionComplete) {
                    console.log(`[ChatManager] Turn ${turn}: Agent Manager said Mission Complete (detected in cleaned response)`);
                    isTaskComplete = true;
                    
                    // Build completion message with thinking if available
                    let completionContent = '✅ Mission Complete';
                    if (thinkContent) {
                        completionContent = `${thinkContent}\n\n✅ Mission Complete`;
                    }
                    
                    onProgress?.({ type: 'ai_followup', content: completionContent });
                    messages.push({
                        id: generateId(),
                        role: 'system',
                        content: completionContent,
                        timestamp: new Date(),
                    });
                    break;
                }
                
                console.log(`[ChatManager] Turn ${turn}: Agent Manager returned empty response after cleaning, not sending to Cursor`);
                console.warn(`[ChatManager] Warning: Agent Manager returned empty/minimal response. Original: "${nextAction}"`);
                
                // Notify UI about the empty response
                onProgress?.({ 
                    type: 'ai_followup', 
                    content: '[Agent Manager 没有返回有效的后续指令，对话暂停]' 
                });
                
                // Break the loop - we shouldn't send empty messages to Cursor
                // The user can review the state and continue manually if needed
                break;
            }
            
            // Add AI's follow-up as system message (Agent Manager speaking)
            onProgress?.({ type: 'ai_followup', content: cleanedAction });

            messages.push({
                id: generateId(),
                role: 'system', // Mark as system message (Agent Manager)
                content: `🤖 ${cleanedAction}`,
                timestamp: new Date(),
            });
        }

        onProgress?.({
            type: 'complete',
            isTaskComplete,
            turn,
            status: isTaskComplete ? 'completed' : 'idle',
            taskMd: currentTaskMd,
        });

        return {
            success: isTaskComplete,
            messages,
            cursorSessionId,
            turns: turn,
            finalTaskMd: currentTaskMd,
        };
    }

    /**
     * Analyze Cursor's response and decide next action using Agent Manager prompt
     */
    private async analyzeAndDecide(
        originalTask: string,
        messages: Message[],
        taskMd?: string,
        turn?: number
    ): Promise<{
        nextAction: string;
        state: AgentState;
        isComplete: boolean;
        newTaskMd?: string; // Newly extracted task.md from first response
    }> {
        // Build conversation context
        const conversationContext = messages
            .map((m) => `[${m.role.toUpperCase()}]: ${m.content}`)
            .join('\n\n');

        // Build the full prompt with task context
        const systemPrompt = buildAgentManagerPrompt(originalTask);

        // Include current task.md if available
        const isFirstResponse = turn === 1;
        const taskMdSection = taskMd 
            ? `\n\n---\n\n## Current TODO List\n\n${taskMd}\n\n---`
            : `\n\n---\n\nNo TODO list yet.${isFirstResponse ? ' If Cursor outputs a TODO list, extract and format it.' : ''}`;

        const response = await this.client.messages.create({
            model: this.model,
            max_tokens: 1024, // Increased to accommodate task.md output
            system: systemPrompt,
            messages: [
                {
                    role: 'user',
                    content: `Conversation history:\n\n${conversationContext}${taskMdSection}\n\n---\n\nAnalyze the AI's latest response and provide your decision.${isFirstResponse ? ' If TODO list is present, extract it.' : ''} Be concise.`,
                },
            ],
        });

        const textBlock = response.content.find((block) => block.type === 'text');
        const responseText = textBlock?.text?.trim() || '';
        
        // Debug: log Agent Manager's raw response
        console.log(`[ChatManager] Agent Manager raw response (turn ${turn}): "${responseText.substring(0, 200)}${responseText.length > 200 ? '...' : ''}"`);
        
        // Warn if response is unexpectedly empty or minimal
        if (!responseText || responseText.length < 5) {
            console.warn(`[ChatManager] Warning: Agent Manager returned very short/empty response. Full response:`, response.content);
        }
        
        // Extract task.md if Agent Manager provided one
        const extractedTaskMd = extractTaskMd(responseText);
        
        // Debug: log task.md extraction result
        if (extractedTaskMd) {
            console.log(`[ChatManager] Extracted task.md (turn ${turn}):\n${extractedTaskMd}`);
        } else {
            // Check if response contains TODO-like patterns but wasn't extracted
            const hasTodoPattern = responseText.includes('- [ ]') || responseText.includes('- [x]') || /\d+\.\s/.test(responseText);
            if (hasTodoPattern) {
                console.log(`[ChatManager] Response contains TODO pattern but no \`\`\`task.md\`\`\` block found (turn ${turn})`);
            }
        }

        // Check for completion signal - trust Agent Manager's judgment
        const isComplete = responseText.toLowerCase().includes('mission complete');

        // Detect state from response
        const state = this.detectState(responseText, messages);

        return {
            nextAction: responseText, // Keep full response including thinking
            state,
            isComplete,
            newTaskMd: extractedTaskMd || undefined,
        };
    }

    /**
     * Detect the agent's state based on response analysis
     */
    private detectState(aiResponse: string, messages: Message[]): AgentState {
        const lastCursorResponse = messages
            .filter((m) => m.role === 'assistant')
            .pop()?.content?.toLowerCase() || '';

        // If AI Manager says Mission Complete
        if (aiResponse.toLowerCase().includes('mission complete')) {
            return 'COMPLETED';
        }

        // Check for blocked signals
        if (
            lastCursorResponse.includes('error') ||
            lastCursorResponse.includes('failed') ||
            lastCursorResponse.includes('cannot') ||
            lastCursorResponse.includes('unable') ||
            lastCursorResponse.includes('错误')
        ) {
            return 'BLOCKED';
        }

        // Check for asking signals - Cursor is asking a question or presenting options
        if (
            lastCursorResponse.includes('?') ||
            lastCursorResponse.includes('请确认') ||
            lastCursorResponse.includes('是否') ||
            lastCursorResponse.includes('选择') ||
            /[①②③④⑤]|[1-5]\.|option|choose/i.test(lastCursorResponse)
        ) {
            return 'ASKING';
        }

        // Check for completion signals from Cursor
        if (
            lastCursorResponse.includes('已完成') ||
            lastCursorResponse.includes('完成了') ||
            lastCursorResponse.includes('已创建') ||
            lastCursorResponse.includes('successfully') ||
            (lastCursorResponse.includes('completed') && !lastCursorResponse.includes('not completed'))
        ) {
            return 'COMPLETED';
        }

        // Check for partial completion
        if (
            lastCursorResponse.includes('first') ||
            lastCursorResponse.includes('next step') ||
            lastCursorResponse.includes('接下来') ||
            lastCursorResponse.includes('remaining')
        ) {
            return 'PARTIAL';
        }

        // Default to working
        return 'WORKING';
    }

    /**
     * Send a single message to Cursor and get response (no auto-loop)
     */
    async sendSingleMessage(
        message: string,
        workdir: string,
        sessionId?: string,
        onProgress?: ChatProgressCallback
    ): Promise<CursorTaskResult> {
        onProgress?.({ type: 'status_change', status: 'running' });

        const result = await executeCursorTask(message, workdir, {
            sessionId,
            onProgress: (progress) => {
                if (progress.type === 'thinking') {
                    onProgress?.({ type: 'thinking', content: progress.content });
                } else if (progress.type === 'tool_call') {
                    onProgress?.({ type: 'tool_call', content: progress.content });
                } else if (progress.type === 'tool_result') {
                    onProgress?.({ type: 'tool_result', content: progress.content });
                } else if (progress.type === 'model_info') {
                    onProgress?.({ type: 'model_info', content: progress.content, model: progress.model });
                }
            },
        });

        onProgress?.({
            type: 'cursor_response',
            content: result.content,
        });

        return result;
    }
}
