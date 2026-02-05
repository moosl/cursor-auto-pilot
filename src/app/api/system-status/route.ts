/**
 * System Status API
 * Shows current system state including memory cache and database
 */
import { OrchestratorAgent, chatStore } from '@/lib/agent/orchestrator';
import { getActiveCursorCalls, activeCursorCalls } from '@/lib/agent/cursor-executor';
import * as db from '@/lib/db';

export const runtime = 'nodejs';

export async function GET() {
    try {
        // Get sessions from database
        const dbSessions = db.getAllSessions();
        
        // Get sessions from memory cache
        const memorySessions: Array<{
            id: string;
            title: string;
            status: string;
            isOrchestratorManaged?: boolean;
            orchestrateTaskId?: string;
        }> = [];
        
        for (const [id, session] of chatStore.entries()) {
            memorySessions.push({
                id,
                title: session.title,
                status: session.status,
                isOrchestratorManaged: session.isOrchestratorManaged,
                orchestrateTaskId: session.orchestrateTaskId,
            });
        }
        
        // Find discrepancies
        const discrepancies: Array<{
            id: string;
            title: string;
            memoryStatus: string;
            dbStatus: string;
        }> = [];
        
        for (const memSession of memorySessions) {
            const dbSession = dbSessions.find(s => s.id === memSession.id);
            if (dbSession && dbSession.status !== memSession.status) {
                discrepancies.push({
                    id: memSession.id,
                    title: memSession.title,
                    memoryStatus: memSession.status,
                    dbStatus: dbSession.status,
                });
            }
        }
        
        // Count by status
        const dbStats = {
            total: dbSessions.length,
            idle: dbSessions.filter(s => s.status === 'idle').length,
            running: dbSessions.filter(s => s.status === 'running' || s.status === 'waiting_response').length,
            completed: dbSessions.filter(s => s.status === 'completed').length,
            error: dbSessions.filter(s => s.status === 'error').length,
        };
        
        const memoryStats = {
            total: memorySessions.length,
            idle: memorySessions.filter(s => s.status === 'idle').length,
            running: memorySessions.filter(s => s.status === 'running' || s.status === 'waiting_response').length,
            completed: memorySessions.filter(s => s.status === 'completed').length,
            error: memorySessions.filter(s => s.status === 'error').length,
        };
        
        // Get running sessions details
        const runningInMemory = memorySessions.filter(s => s.status === 'running' || s.status === 'waiting_response');
        const runningInDb = dbSessions
            .filter(s => s.status === 'running' || s.status === 'waiting_response')
            .map(s => ({
                id: s.id,
                title: s.title,
                status: s.status,
                isOrchestratorManaged: s.isOrchestratorManaged,
            }));

        // Get active Cursor calls (actual ongoing requests to Cursor)
        const activeCalls = getActiveCursorCalls().map(call => ({
            id: call.id,
            chatId: call.chatId,
            chatTitle: call.chatTitle,
            task: call.task,
            workdir: call.workdir,
            startTime: call.startTime.toISOString(),
            durationMs: Date.now() - call.startTime.getTime(),
        }));

        return new Response(JSON.stringify({
            // Active Cursor calls - THE KEY METRIC
            activeCursorCalls: {
                count: activeCalls.length,
                calls: activeCalls,
            },
            database: {
                stats: dbStats,
                running: runningInDb,
            },
            memory: {
                stats: memoryStats,
                running: runningInMemory,
            },
            discrepancies,
            timestamp: new Date().toISOString(),
        }, null, 2), {
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (error) {
        console.error('[System Status API] Error:', error);
        return new Response(JSON.stringify({ 
            error: 'Failed to get system status',
            details: error instanceof Error ? error.message : String(error),
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
}

/**
 * POST /api/system-status
 * Actions: sync (sync memory with db), clear-stale (clear stale running sessions)
 */
export async function POST(req: Request) {
    try {
        const { action } = await req.json();
        
        if (action === 'sync') {
            // Sync memory cache with database
            let synced = 0;
            for (const [id, session] of chatStore.entries()) {
                const dbSession = db.getSessionMeta(id);
                if (dbSession && dbSession.status !== session.status) {
                    // Update memory to match DB
                    session.status = dbSession.status;
                    synced++;
                }
            }
            
            return new Response(JSON.stringify({
                success: true,
                message: `Synced ${synced} sessions`,
            }), {
                headers: { 'Content-Type': 'application/json' },
            });
        }
        
        if (action === 'clear-stale') {
            // Clear stale running sessions in database
            // (sessions that have been "running" for too long are probably stuck)
            const dbSessions = db.getAllSessions();
            let cleared = 0;
            
            for (const session of dbSessions) {
                if (session.status === 'running' || session.status === 'waiting_response') {
                    // Check if it's in memory cache and still active
                    const memSession = chatStore.get(session.id);
                    if (!memSession) {
                        // Not in memory, probably stale - mark as idle
                        db.updateSession({ id: session.id, status: 'idle' });
                        cleared++;
                    }
                }
            }
            
            return new Response(JSON.stringify({
                success: true,
                message: `Cleared ${cleared} stale sessions`,
            }), {
                headers: { 'Content-Type': 'application/json' },
            });
        }
        
        if (action === 'clear-memory') {
            // Clear all memory cache
            const size = chatStore.size;
            chatStore.clear();
            
            return new Response(JSON.stringify({
                success: true,
                message: `Cleared ${size} sessions from memory cache`,
            }), {
                headers: { 'Content-Type': 'application/json' },
            });
        }
        
        return new Response(JSON.stringify({
            error: 'Unknown action',
            availableActions: ['sync', 'clear-stale', 'clear-memory'],
        }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (error) {
        return new Response(JSON.stringify({
            error: 'Failed to execute action',
            details: error instanceof Error ? error.message : String(error),
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
}
