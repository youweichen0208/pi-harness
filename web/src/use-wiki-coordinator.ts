import { useEffect, useState, useSyncExternalStore } from "react";
import { WikiCoordinator } from "./wiki-coordinator";

export function useWikiCoordinator(conversationId: string, streaming: boolean, ready: boolean, sessionId?: string) {
	const [coordinator] = useState(() => new WikiCoordinator());
	const busy = useSyncExternalStore(coordinator.subscribe, coordinator.busy);
	useEffect(() => { coordinator.observe(conversationId, streaming, ready, sessionId); }, [coordinator, conversationId, streaming, ready, sessionId]);
	return { coordinator, busy };
}
