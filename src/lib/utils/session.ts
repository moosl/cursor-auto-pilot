import type { ChatSession } from '@/lib/types';

export type SessionType = 'manual' | 'orchestrator_subtask' | 'orchestrator_main';

export function getSessionType(
    session: Pick<ChatSession, 'isOrchestratorManaged' | 'orchestrateTaskId'> | null | undefined
): SessionType {
    if (!session) return 'manual';
    if (session.isOrchestratorManaged) return 'orchestrator_main';
    if (session.orchestrateTaskId) return 'orchestrator_subtask';
    return 'manual';
}

export function isOrchestratorMain(
    session: Pick<ChatSession, 'isOrchestratorManaged'> | null | undefined
): boolean {
    return Boolean(session?.isOrchestratorManaged);
}

export function isOrchestratorSubtask(
    session: Pick<ChatSession, 'isOrchestratorManaged' | 'orchestrateTaskId'> | null | undefined
): boolean {
    return Boolean(session?.orchestrateTaskId && !session?.isOrchestratorManaged);
}

export function isManualChat(
    session: Pick<ChatSession, 'isOrchestratorManaged' | 'orchestrateTaskId'> | null | undefined
): boolean {
    return !isOrchestratorMain(session) && !isOrchestratorSubtask(session);
}

