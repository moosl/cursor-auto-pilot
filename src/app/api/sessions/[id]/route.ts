/**
 * Session API Route - Individual session operations
 */
import * as db from '@/lib/db';
import { OrchestratorAgent } from '@/lib/agent/orchestrator';

export const runtime = 'nodejs';

// DELETE /api/sessions/[id] - Delete a session
export async function DELETE(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params;
        
        if (!id) {
            return new Response(
                JSON.stringify({ error: 'Session ID is required' }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }

        // Check if session exists
        // Return full session with messages so UI can restore chat history
        const session = db.getSessionWithMessages(id);
        if (!session) {
            // Also try to remove from memory if exists there
            OrchestratorAgent.removeChat(id);
            return new Response(
                JSON.stringify({ error: 'Session not found' }),
                { status: 404, headers: { 'Content-Type': 'application/json' } }
            );
        }

        // If session is running, try to abort it first
        if (session.status === 'running' || session.status === 'waiting_response') {
            // Update status to idle to signal abort
            db.updateSession({ id, status: 'idle' });
            console.log(`[Sessions API] Aborted running session ${id}`);
        }

        // Remove from orchestrator memory
        OrchestratorAgent.removeChat(id);

        // Delete the session (messages are deleted via CASCADE)
        db.deleteSession(id);

        return new Response(
            JSON.stringify({ success: true, id }),
            { headers: { 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        console.error('[Sessions API] Delete error:', error);
        return new Response(
            JSON.stringify({ error: 'Failed to delete session' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
}

// GET /api/sessions/[id] - Get a single session with messages
export async function GET(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params;
        
        if (!id) {
            return new Response(
                JSON.stringify({ error: 'Session ID is required' }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }

        const session = db.getSessionMeta(id);
        if (!session) {
            return new Response(
                JSON.stringify({ error: 'Session not found' }),
                { status: 404, headers: { 'Content-Type': 'application/json' } }
            );
        }

        return new Response(
            JSON.stringify({ session }),
            { headers: { 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        console.error('[Sessions API] Get error:', error);
        return new Response(
            JSON.stringify({ error: 'Failed to get session' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
}

// PATCH /api/sessions/[id] - Update session (e.g., taskMd)
export async function PATCH(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params;
        const body = await req.json();
        
        if (!id) {
            return new Response(
                JSON.stringify({ error: 'Session ID is required' }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }

        const session = db.getSession(id);
        if (!session) {
            return new Response(
                JSON.stringify({ error: 'Session not found' }),
                { status: 404, headers: { 'Content-Type': 'application/json' } }
            );
        }

        // Update allowed fields
        const updates: { id: string; taskMd?: string; title?: string } = { id };
        
        if (body.taskMd !== undefined) {
            updates.taskMd = body.taskMd;
        }
        if (body.title !== undefined) {
            updates.title = body.title;
        }

        db.updateSession(updates);

        // Return updated session
        const updatedSession = db.getSession(id);

        return new Response(
            JSON.stringify({ success: true, session: updatedSession }),
            { headers: { 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        console.error('[Sessions API] Update error:', error);
        return new Response(
            JSON.stringify({ error: 'Failed to update session' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
}
