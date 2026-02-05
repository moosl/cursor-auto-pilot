/**
 * Abort Controller Registry
 * Manages abort controllers for active chat sessions
 */

// Store active abort controllers by chatId
const abortControllers = new Map<string, AbortController>();

/**
 * Register an abort controller for a chat session
 */
export function registerAbortController(chatId: string, controller: AbortController): void {
    abortControllers.set(chatId, controller);
}

/**
 * Unregister an abort controller when chat completes
 */
export function unregisterAbortController(chatId: string): void {
    abortControllers.delete(chatId);
}

/**
 * Get abort signal for a chat session
 */
export function getAbortSignal(chatId: string): AbortSignal | undefined {
    return abortControllers.get(chatId)?.signal;
}

/**
 * Abort a chat session
 * @returns true if there was an active controller that was aborted
 */
export function abortChat(chatId: string): boolean {
    const controller = abortControllers.get(chatId);
    if (controller) {
        controller.abort();
        abortControllers.delete(chatId);
        return true;
    }
    return false;
}

/**
 * Check if a chat has an active abort controller
 */
export function hasActiveController(chatId: string): boolean {
    return abortControllers.has(chatId);
}
