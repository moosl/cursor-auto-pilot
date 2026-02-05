/**
 * Lightweight ID generator shared by client/server code.
 * Not cryptographically secure; intended for UI/session identifiers.
 */
export function generateId(): string {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

