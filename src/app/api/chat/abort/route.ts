/**
 * Chat Abort API Route
 * Allows aborting/stopping an ongoing chat session
 */
import * as db from '@/lib/db';
import { abortChat } from '@/lib/agent/abort-controller';
import { killCursorProcessesByChatId } from '@/lib/agent/cursor-executor';

/**
 * POST /api/chat/abort
 * 
 * Request body:
 * - chatId: the chat session ID to abort
 */
export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { chatId } = body;

        if (!chatId) {
            return new Response(JSON.stringify({ error: 'chatId is required' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        // Try to abort the controller if it exists
        const hadActiveController = abortChat(chatId);

        // Kill any running Cursor processes for this chat
        const processesKilled = killCursorProcessesByChatId(chatId);
        console.log(`[Abort] chatId=${chatId}, hadActiveController=${hadActiveController}, processesKilled=${processesKilled}`);

        // Update session status in database
        const session = db.getSessionMeta(chatId);
        if (session) {
            db.updateSession({
                id: chatId,
                status: 'idle',
            });
        }

        return new Response(JSON.stringify({ 
            success: true, 
            message: 'Chat aborted',
            hadActiveController,
            processesKilled,
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (error) {
        console.error('Error aborting chat:', error);
        return new Response(JSON.stringify({ 
            error: 'Failed to abort chat',
            details: error instanceof Error ? error.message : String(error),
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
}
