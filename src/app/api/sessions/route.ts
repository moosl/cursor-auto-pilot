/**
 * Sessions API Route
 * Get all chat sessions from database
 */
import { existsSync } from 'fs';
import { OrchestratorAgent } from '@/lib/agent/orchestrator';
import * as db from '@/lib/db';
import { ChatSession } from '@/lib/types';

export const runtime = 'nodejs';

const DEFAULT_MESSAGE_LIMIT = 50;
const MAX_MESSAGE_LIMIT = 500;

function parsePositiveInt(value: string | null): number | undefined {
    if (!value) return undefined;
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed) || parsed < 0) return undefined;
    return parsed;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function parseBoolean(value: string | null): boolean {
    return value === '1' || value === 'true';
}

/**
 * POST /api/sessions - Create a new session
 */
export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { id, title, workdir } = body;
        
        if (!id) {
            return new Response(
                JSON.stringify({ error: 'Session ID is required' }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }
        
        // Check if session already exists
        const existing = db.getSessionMeta(id);
        if (existing) {
            // Return existing session instead of error
            return new Response(
                JSON.stringify({ session: existing, created: false }),
                { headers: { 'Content-Type': 'application/json' } }
            );
        }
        
        // Create new session
        const newSession: ChatSession = {
            id,
            title: title || 'New Chat',
            status: 'idle',
            messages: [],
            createdAt: new Date(),
            workdir: workdir || undefined,
        };
        
        db.createSession(newSession);
        console.log(`[Sessions API] Created new session: ${id}, title: ${title}`);
        
        return new Response(
            JSON.stringify({ session: newSession, created: true }),
            { status: 201, headers: { 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        console.error('[Sessions API] Create error:', error);
        return new Response(
            JSON.stringify({ error: 'Failed to create session' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
}

export async function GET(req: Request) {
    try {
        const url = new URL(req.url);
        const includeMessages = parseBoolean(url.searchParams.get('includeMessages'));
        const messageLimitParam = parsePositiveInt(url.searchParams.get('messageLimit'));
        const messageLimit = clamp(
            messageLimitParam ?? DEFAULT_MESSAGE_LIMIT,
            0,
            MAX_MESSAGE_LIMIT
        );

        // Get all sessions from database (metadata only)
        const sessionsWithoutMessages = db.getAllSessions();
        
        // Load recent messages for all sessions so manual chats restore correctly after refresh
        const sessions = sessionsWithoutMessages.map((s) => {
            if (includeMessages) {
                const fullSession = db.getSessionWithMessages(s.id);
                return fullSession || s;
            }
            if (messageLimit === 0) {
                return s;
            }
            return {
                ...s,
                messages: db.getRecentMessages(s.id, messageLimit),
            };
        });
        
        // Also include any active sessions from memory
        const allSessions = OrchestratorAgent.getAllChats();
        
        // Merge - prefer DB version (has messages), only add memory sessions if not in DB
        const sessionMap = new Map(sessions.map(s => [s.id, s]));
        for (const session of allSessions) {
            if (!sessionMap.has(session.id)) {
                sessionMap.set(session.id, session);
            } else {
                // Merge: keep DB messages but update status from memory if running
                const dbSession = sessionMap.get(session.id)!;
                if (session.status === 'running' || session.status === 'waiting_response') {
                    sessionMap.set(session.id, {
                        ...dbSession,
                        status: session.status,
                    });
                }
            }
        }
        
        // Check if workdir exists for each session and mark if missing
        const result = Array.from(sessionMap.values())
            .map(s => ({
                ...s,
                workdirMissing: s.workdir ? !existsSync(s.workdir) : false,
            }))
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

        return new Response(JSON.stringify({ sessions: result }), {
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (error) {
        console.error('[Sessions API] Error:', error);
        return new Response(
            JSON.stringify({ error: 'Failed to get sessions' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
}
