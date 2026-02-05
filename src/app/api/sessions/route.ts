/**
 * Sessions API Route
 * Get all chat sessions from database
 */
import { existsSync } from 'fs';
import { OrchestratorAgent } from '@/lib/agent/orchestrator';
import * as db from '@/lib/db';
import { ChatSession } from '@/lib/types';

export const runtime = 'nodejs';

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

export async function GET() {
    try {
        // Get all sessions from database (metadata only)
        const sessionsWithoutMessages = db.getAllSessions();
        
        // Load messages for all sessions so manual chats restore correctly after refresh
        const sessions = sessionsWithoutMessages.map((s) => {
            const fullSession = db.getSessionWithMessages(s.id);
            return fullSession || s;
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
