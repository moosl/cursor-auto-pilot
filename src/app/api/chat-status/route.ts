/**
 * Chat Status API Route
 * Allows frontend to poll for chat session status updates
 */
import { OrchestratorAgent, chatStore } from '@/lib/agent/orchestrator';
import * as db from '@/lib/db';

export const runtime = 'nodejs';

const MAX_MESSAGE_LIMIT = 500;
const DEFAULT_INCREMENT_LIMIT = 200;
const DEFAULT_TAIL_LIMIT = 50;

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

export async function GET(req: Request) {
    const url = new URL(req.url);
    const chatId = url.searchParams.get('chatId');

    if (!chatId) {
        const allChats = OrchestratorAgent.getAllChats();
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

    const after = parsePositiveInt(url.searchParams.get('after'));
    const tail = parsePositiveInt(url.searchParams.get('tail'));
    const limit = parsePositiveInt(url.searchParams.get('limit'));
    const includeMessages = parseBoolean(url.searchParams.get('includeMessages'));

    const dbSession = db.getSessionMeta(chatId);
    const cachedSession = chatStore.get(chatId);
    const chat = dbSession ?? cachedSession;

    if (!chat) {
        console.log(`[chat-status] Chat not found for chatId=${chatId}`);
        return new Response(
            JSON.stringify({ error: 'Chat not found', chatId }),
            { status: 404, headers: { 'Content-Type': 'application/json' } }
        );
    }

    const messageCount = dbSession
        ? db.getMessageCount(chatId)
        : cachedSession?.messages?.length ?? 0;

    let messages = [] as typeof chat.messages;
    const hasAfter = after !== undefined;
    const hasTail = tail !== undefined;

    if (dbSession) {
        if (hasAfter) {
            const limitValue = clamp(limit ?? DEFAULT_INCREMENT_LIMIT, 1, MAX_MESSAGE_LIMIT);
            if (after < messageCount) {
                messages = db.getMessagesRange(chatId, limitValue, after);
            }
        } else if (hasTail) {
            const tailValue = clamp(tail ?? DEFAULT_TAIL_LIMIT, 1, MAX_MESSAGE_LIMIT);
            messages = db.getRecentMessages(chatId, tailValue);
        } else if (includeMessages) {
            messages = db.getMessages(chatId);
        }
    } else if (cachedSession) {
        const allMessages = cachedSession.messages || [];
        if (hasAfter) {
            const limitValue = clamp(limit ?? DEFAULT_INCREMENT_LIMIT, 1, MAX_MESSAGE_LIMIT);
            messages = allMessages.slice(after, after + limitValue);
        } else if (hasTail) {
            const tailValue = clamp(tail ?? DEFAULT_TAIL_LIMIT, 1, MAX_MESSAGE_LIMIT);
            messages = allMessages.slice(-tailValue);
        } else if (includeMessages) {
            messages = allMessages;
        }
    }

    console.log(`[chat-status] Found chat: ${chat.title}, messageCount: ${messageCount}`);

    return new Response(
        JSON.stringify({
            id: chat.id,
            title: chat.title,
            status: chat.status,
            messages,
            messageCount,
            createdAt: chat.createdAt,
            cursorSessionId: chat.cursorSessionId,
            taskMd: chat.taskMd, // Include task.md content
            workdir: chat.workdir, // Include working directory
        }),
        { headers: { 'Content-Type': 'application/json' } }
    );
}
