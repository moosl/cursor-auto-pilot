/**
 * Chat Status API Route
 * Allows frontend to poll for chat session status updates
 */
import { OrchestratorAgent, chatStore } from '@/lib/agent/orchestrator';

export const runtime = 'nodejs';

export async function GET(req: Request) {
    const url = new URL(req.url);
    const chatId = url.searchParams.get('chatId');
    const allChats = OrchestratorAgent.getAllChats();

    if (!chatId) {
        // Return all chats
        return new Response(
            JSON.stringify({
                chats: allChats.map((chat) => ({
                    id: chat.id,
                    title: chat.title,
                    status: chat.status,
                    messageCount: chat.messages.length,
                    lastMessage: chat.messages[chat.messages.length - 1],
                    createdAt: chat.createdAt,
                })),
            }),
            { headers: { 'Content-Type': 'application/json' } }
        );
    }

    // Return specific chat
    console.log(`[chat-status] Getting chat for chatId=${chatId}`);
    const chat = OrchestratorAgent.getChat(chatId);

    if (!chat) {
        console.log(`[chat-status] Chat not found for chatId=${chatId}`);
        return new Response(
            JSON.stringify({ error: 'Chat not found', chatId }),
            { status: 404, headers: { 'Content-Type': 'application/json' } }
        );
    }
    
    console.log(`[chat-status] Found chat: ${chat.title}, messages: ${chat.messages.length}`);

    return new Response(
        JSON.stringify({
            id: chat.id,
            title: chat.title,
            status: chat.status,
            messages: chat.messages,
            createdAt: chat.createdAt,
            cursorSessionId: chat.cursorSessionId,
            taskMd: chat.taskMd, // Include task.md content
            workdir: chat.workdir, // Include working directory
        }),
        { headers: { 'Content-Type': 'application/json' } }
    );
}
