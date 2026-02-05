/**
 * SQLite Database for Chat Storage
 * Uses better-sqlite3 for synchronous, high-performance operations
 */
import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { ChatSession, ChatStatus, Message } from '../types';

const DB_PATH = process.env.DB_PATH || '.data/cursor-pilot.db';

// Ensure data directory exists
const dbDir = dirname(DB_PATH);
if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
}

// Use globalThis to persist across hot reloads in development
const globalForDb = globalThis as unknown as {
    db: Database.Database | undefined;
    stmts: {
        insertSession?: Database.Statement;
        updateSession?: Database.Statement;
        getSession?: Database.Statement;
        getAllSessions?: Database.Statement;
        deleteSession?: Database.Statement;
        insertMessage?: Database.Statement;
        getMessages?: Database.Statement;
        getMessageCount?: Database.Statement;
        getLastMessage?: Database.Statement;
    } | undefined;
};

function getDb(): Database.Database {
    if (globalForDb.db) {
        return globalForDb.db;
    }

    const db = new Database(DB_PATH);
    
    // Enable WAL mode for better concurrent performance
    db.pragma('journal_mode = WAL');
    
    // Initialize tables
    db.exec(`
        -- Chat sessions table
        CREATE TABLE IF NOT EXISTS chat_sessions (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'idle',
            cursor_session_id TEXT,
            orchestrate_task_id TEXT,
            is_orchestrator_managed INTEGER DEFAULT 0,
            source TEXT DEFAULT 'web',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        -- Messages table
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            metadata TEXT,
            timestamp INTEGER NOT NULL,
            FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
        );

        -- Create indexes for common queries
        CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_status ON chat_sessions(status);
        CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON chat_sessions(created_at DESC);
    `);
    
    // Migrate: Add new columns if they don't exist
    try {
        db.exec(`ALTER TABLE chat_sessions ADD COLUMN is_orchestrator_managed INTEGER DEFAULT 0`);
    } catch (e) {
        // Column already exists
    }
    try {
        db.exec(`ALTER TABLE chat_sessions ADD COLUMN source TEXT DEFAULT 'web'`);
    } catch (e) {
        // Column already exists
    }
    try {
        db.exec(`ALTER TABLE chat_sessions ADD COLUMN workdir TEXT`);
    } catch (e) {
        // Column already exists
    }
    try {
        db.exec(`ALTER TABLE chat_sessions ADD COLUMN task_md TEXT`);
        // Clear cached statements after schema change
        globalForDb.stmts = undefined;
    } catch (e) {
        // Column already exists
    }

    console.log('[DB] SQLite database initialized');
    
    if (process.env.NODE_ENV !== 'production') {
        globalForDb.db = db;
    }

    return db;
}

function getStatements() {
    const db = getDb();
    
    // Use globalThis for stmts too
    if (!globalForDb.stmts || !globalForDb.stmts.insertSession) {
        globalForDb.stmts = {
            insertSession: db.prepare(`
                INSERT INTO chat_sessions (id, title, status, cursor_session_id, orchestrate_task_id, is_orchestrator_managed, source, workdir, task_md, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `),
            updateSession: db.prepare(`
                UPDATE chat_sessions 
                SET title = ?, status = ?, cursor_session_id = ?, workdir = ?, task_md = ?, updated_at = ?
                WHERE id = ?
            `),
            getSession: db.prepare(`
                SELECT * FROM chat_sessions WHERE id = ?
            `),
            getAllSessions: db.prepare(`
                SELECT * FROM chat_sessions ORDER BY created_at DESC
            `),
            deleteSession: db.prepare(`
                DELETE FROM chat_sessions WHERE id = ?
            `),
            insertMessage: db.prepare(`
                INSERT INTO messages (id, session_id, role, content, metadata, timestamp)
                VALUES (?, ?, ?, ?, ?, ?)
            `),
            getMessages: db.prepare(`
                SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC
            `),
            getMessageCount: db.prepare(`
                SELECT COUNT(*) as count FROM messages WHERE session_id = ?
            `),
            getLastMessage: db.prepare(`
                SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp DESC LIMIT 1
            `),
        };
    }
    
    return globalForDb.stmts!;
}

// ============ Chat Session Operations ============

export function createSession(session: ChatSession): void {
    const s = getStatements();
    const now = Date.now();
    
    s.insertSession!.run(
        session.id,
        session.title,
        session.status,
        session.cursorSessionId || null,
        session.orchestrateTaskId || null,
        session.isOrchestratorManaged ? 1 : 0,
        session.source || 'web',
        session.workdir || null,
        session.taskMd || null,
        session.createdAt.getTime(),
        now
    );
    
    // Insert initial messages if any
    for (const msg of session.messages) {
        s.insertMessage!.run(
            msg.id,
            session.id,
            msg.role,
            msg.content,
            msg.metadata ? JSON.stringify(msg.metadata) : null,
            msg.timestamp.getTime()
        );
    }
}

export function updateSession(session: Partial<ChatSession> & { id: string }): void {
    const existing = getSessionMeta(session.id);
    if (!existing) return;
    
    const s = getStatements();
    s.updateSession!.run(
        session.title ?? existing.title,
        session.status ?? existing.status,
        session.cursorSessionId ?? existing.cursorSessionId ?? null,
        session.workdir ?? existing.workdir ?? null,
        session.taskMd ?? existing.taskMd ?? null,
        Date.now(),
        session.id
    );
}

export function getSession(id: string): ChatSession | null {
    console.log(`[db.getSession] id=${id}`);
    const s = getStatements();
    const row = s.getSession!.get(id) as {
        id: string;
        title: string;
        status: ChatStatus;
        cursor_session_id: string | null;
        orchestrate_task_id: string | null;
        is_orchestrator_managed: number;
        source: string | null;
        workdir: string | null;
        task_md: string | null;
        created_at: number;
        updated_at: number;
    } | undefined;
    
    if (!row) {
        console.log(`[db.getSession] Session ${id} not found in database`);
        return null;
    }
    
    console.log(`[db.getSession] Found session: ${row.title}`);
    const messages = getMessages(id);
    
    return {
        id: row.id,
        title: row.title,
        status: row.status,
        cursorSessionId: row.cursor_session_id || undefined,
        orchestrateTaskId: row.orchestrate_task_id || undefined,
        isOrchestratorManaged: row.is_orchestrator_managed === 1,
        source: (row.source as 'web' | 'telegram') || 'web',
        workdir: row.workdir || undefined,
        taskMd: row.task_md || undefined,
        createdAt: new Date(row.created_at),
        messages,
    };
}

/**
 * Get a chat session without loading messages (metadata only).
 * Use this for request paths that only need title/status/workdir/session IDs.
 */
export function getSessionMeta(id: string): ChatSession | null {
    const s = getStatements();
    const row = s.getSession!.get(id) as {
        id: string;
        title: string;
        status: ChatStatus;
        cursor_session_id: string | null;
        orchestrate_task_id: string | null;
        is_orchestrator_managed: number;
        source: string | null;
        workdir: string | null;
        task_md: string | null;
        created_at: number;
        updated_at: number;
    } | undefined;
    
    if (!row) return null;
    
    return {
        id: row.id,
        title: row.title,
        status: row.status,
        cursorSessionId: row.cursor_session_id || undefined,
        orchestrateTaskId: row.orchestrate_task_id || undefined,
        isOrchestratorManaged: row.is_orchestrator_managed === 1,
        source: (row.source as 'web' | 'telegram') || 'web',
        workdir: row.workdir || undefined,
        taskMd: row.task_md || undefined,
        createdAt: new Date(row.created_at),
        messages: [],
    };
}

export function getAllSessions(): ChatSession[] {
    const s = getStatements();
    const rows = s.getAllSessions!.all() as Array<{
        id: string;
        title: string;
        status: ChatStatus;
        cursor_session_id: string | null;
        orchestrate_task_id: string | null;
        is_orchestrator_managed: number;
        source: string | null;
        workdir: string | null;
        task_md: string | null;
        created_at: number;
        updated_at: number;
    }>;
    
    return rows.map(row => ({
        id: row.id,
        title: row.title,
        status: row.status,
        cursorSessionId: row.cursor_session_id || undefined,
        orchestrateTaskId: row.orchestrate_task_id || undefined,
        isOrchestratorManaged: row.is_orchestrator_managed === 1,
        source: (row.source as 'web' | 'telegram') || 'web',
        workdir: row.workdir || undefined,
        taskMd: row.task_md || undefined,
        createdAt: new Date(row.created_at),
        messages: [], // Don't load messages for list view
    }));
}

export function getSessionWithMessages(id: string): ChatSession | null {
    const session = getSession(id);
    if (!session) return null;
    
    session.messages = getMessages(id);
    return session;
}

export function deleteSession(id: string): void {
    const db = getDb();
    const s = getStatements();
    
    // Delete messages first (or use CASCADE)
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
    s.deleteSession!.run(id);
}

// ============ Message Operations ============

export function addMessage(sessionId: string, message: Message): void {
    console.log(`[db.addMessage] sessionId=${sessionId}, role=${message.role}, content=${message.content.substring(0, 50)}...`);
    
    // Verify session exists
    const session = getSessionMeta(sessionId);
    if (!session) {
        console.error(`[db.addMessage] ERROR: Session ${sessionId} does not exist! Message will not be saved.`);
        return;
    }
    
    const s = getStatements();
    try {
        s.insertMessage!.run(
            message.id,
            sessionId,
            message.role,
            message.content,
            message.metadata ? JSON.stringify(message.metadata) : null,
            message.timestamp.getTime()
        );
        console.log(`[db.addMessage] Successfully saved message ${message.id} to session ${sessionId}`);
    } catch (err) {
        console.error(`[db.addMessage] Error saving message:`, err);
    }
}

export function getMessages(sessionId: string): Message[] {
    console.log(`[db.getMessages] sessionId=${sessionId}`);
    const s = getStatements();
    const rows = s.getMessages!.all(sessionId) as Array<{
        id: string;
        session_id: string;
        role: 'user' | 'assistant' | 'system';
        content: string;
        metadata: string | null;
        timestamp: number;
    }>;
    
    console.log(`[db.getMessages] Found ${rows.length} messages for session ${sessionId}`);
    
    return rows.map(row => ({
        id: row.id,
        role: row.role,
        content: row.content,
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        timestamp: new Date(row.timestamp),
    }));
}

export function getMessageCount(sessionId: string): number {
    const s = getStatements();
    const row = s.getMessageCount!.get(sessionId) as { count: number };
    return row.count;
}

export function getLastMessage(sessionId: string): Message | null {
    const s = getStatements();
    const row = s.getLastMessage!.get(sessionId) as {
        id: string;
        session_id: string;
        role: 'user' | 'assistant' | 'system';
        content: string;
        metadata: string | null;
        timestamp: number;
    } | undefined;
    
    if (!row) return null;
    
    return {
        id: row.id,
        role: row.role,
        content: row.content,
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        timestamp: new Date(row.timestamp),
    };
}

// ============ Utility Functions ============

export function sessionExists(id: string): boolean {
    const s = getStatements();
    const row = s.getSession!.get(id);
    return !!row;
}

export function getSessionsByStatus(status: ChatStatus): ChatSession[] {
    const db = getDb();
    const rows = db.prepare(`
        SELECT * FROM chat_sessions WHERE status = ? ORDER BY created_at DESC
    `).all(status) as Array<{
        id: string;
        title: string;
        status: ChatStatus;
        cursor_session_id: string | null;
        orchestrate_task_id: string | null;
        created_at: number;
    }>;
    
    return rows.map(row => ({
        id: row.id,
        title: row.title,
        status: row.status,
        cursorSessionId: row.cursor_session_id || undefined,
        orchestrateTaskId: row.orchestrate_task_id || undefined,
        createdAt: new Date(row.created_at),
        messages: [],
    }));
}

// Export database instance for advanced operations
export { getDb };
