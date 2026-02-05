/**
 * Sessions API Route
 * Get all chat sessions from database
 */
import { existsSync } from 'fs';
import { OrchestratorAgent } from '@/lib/agent/orchestrator';
import * as db from '@/lib/db';

export const runtime = 'nodejs';

export async function GET() {
    try {
        // Get all sessions from database (without messages for list)
        const sessionsWithoutMessages = db.getAllSessions();
        
        // Load messages for orchestrator-managed sessions
        const sessions = sessionsWithoutMessages.map(s => {
            if (s.isOrchestratorManaged || s.orchestrateTaskId) {
                // Load full session with messages
                const fullSession = db.getSession(s.id);
                return fullSession || s;
            }
            return s;
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
