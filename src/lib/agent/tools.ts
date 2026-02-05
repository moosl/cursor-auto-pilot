/**
 * Tool definitions for Claude Agent SDK
 */
import Anthropic from '@anthropic-ai/sdk';

export const TOOLS: Anthropic.Tool[] = [
    {
        name: 'create_chat',
        description: `Create a new chat session with Cursor Agent and start an automated conversation.
The chat will automatically continue until the task is completed or needs user intervention.

Use this tool when you have a specific coding task to delegate to Cursor.
The system will:
1. Create a new chat session
2. Send the task to Cursor Agent
3. Monitor responses and ask follow-up questions if needed
4. Continue until the task is marked as complete

IMPORTANT: This tool will wait for the task to complete and stream progress updates in real-time.
You will receive all messages from the conversation as they happen.`,
        input_schema: {
            type: 'object' as const,
            properties: {
                task: {
                    type: 'string',
                    description: 'The coding task description to send to Cursor Agent.',
                },
                title: {
                    type: 'string',
                    description: 'A short, descriptive title for the chat session.',
                },
            },
            required: ['task', 'title'],
        },
    },
    {
        name: 'check_chat_status',
        description: `Check the status of an existing chat session.
Use this to monitor progress of tasks you've dispatched.`,
        input_schema: {
            type: 'object' as const,
            properties: {
                chat_id: {
                    type: 'string',
                    description: 'The ID of the chat session to check.',
                },
            },
            required: ['chat_id'],
        },
    },
    {
        name: 'send_message_to_chat',
        description: `Send a follow-up message to an existing chat session.
Use this to provide additional instructions or ask questions about an ongoing task.`,
        input_schema: {
            type: 'object' as const,
            properties: {
                chat_id: {
                    type: 'string',
                    description: 'The ID of the chat session.',
                },
                message: {
                    type: 'string',
                    description: 'The message to send.',
                },
            },
            required: ['chat_id', 'message'],
        },
    },
    {
        name: 'list_files',
        description: 'List files in a directory to understand project structure.',
        input_schema: {
            type: 'object' as const,
            properties: {
                path: {
                    type: 'string',
                    description: 'Directory path to list.',
                },
            },
            required: ['path'],
        },
    },
    {
        name: 'read_file',
        description: 'Read contents of a file.',
        input_schema: {
            type: 'object' as const,
            properties: {
                path: {
                    type: 'string',
                    description: 'File path to read.',
                },
            },
            required: ['path'],
        },
    },
];

// Legacy tool for backward compatibility
export const LEGACY_TOOLS: Anthropic.Tool[] = [
    {
        name: 'dispatch_task',
        description: `Dispatch a coding task to a new, separate chat session.
Use this tool when you have a specific coding task, refactoring, or implementation work.
This will open a new window for the specialized Cursor Agent to perform the work.
Do NOT wait for the result of the task. Your job is just to dispatch it.`,
        input_schema: {
            type: 'object' as const,
            properties: {
                task: {
                    type: 'string',
                    description: 'The coding task description to send to the sub-agent.',
                },
                title: {
                    type: 'string',
                    description: 'A short, descriptive title for the new chat session.',
                },
            },
            required: ['task', 'title'],
        },
    },
    ...TOOLS.filter(t => t.name !== 'create_chat'),
];

export type ToolName = 'create_chat' | 'check_chat_status' | 'send_message_to_chat' | 'dispatch_task' | 'list_files' | 'read_file';

export interface CreateChatInput {
    task: string;
    title: string;
}

export interface CheckChatStatusInput {
    chat_id: string;
}

export interface SendMessageToChatInput {
    chat_id: string;
    message: string;
}

export interface DispatchTaskInput {
    task: string;
    title: string;
}

export interface ListFilesInput {
    path: string;
}

export interface ReadFileInput {
    path: string;
}
