import { useCallback, useEffect, useRef, useState } from "react";
import type { PlaygroundStatus } from "./types";
import { withToken } from "./auth-token";

async function fetchStatus(redetect: boolean): Promise<PlaygroundStatus> {
	const response = await fetch(withToken(`/api/playground/status${redetect ? "?refresh=1" : ""}`));
	if (!response.ok) throw response.status;
	return response.json() as Promise<PlaygroundStatus>;
}

/**
 * App-level Playground status: whether execution is allowed, whether the
 * environment has locked it, and whether a JDK is present.
 *
 * Refreshed on load, on window focus/online and whenever the socket reconnects,
 * matching the notes pattern — the switch lives on the server, so another tab or
 * the settings page can change it underneath us.
 */
export function usePlayground(connected: boolean) {
	const [status, setStatus] = useState<PlaygroundStatus | null>(null);
	const requestId = useRef(0);

	const refresh = useCallback(async (redetect = false) => {
		const token = ++requestId.current;
		try {
			const next = await fetchStatus(redetect);
			if (token === requestId.current) setStatus(next);
		} catch {
			// Null means "could not ask", never "off": the UI must not claim the
			// feature is disabled when the request simply failed.
			if (token === requestId.current) setStatus(null);
		}
	}, []);

	useEffect(() => { void refresh(); }, [connected, refresh]);
	useEffect(() => {
		const focus = () => { void refresh(); };
		window.addEventListener("focus", focus);
		window.addEventListener("online", focus);
		return () => {
			window.removeEventListener("focus", focus);
			window.removeEventListener("online", focus);
		};
	}, [refresh]);

	const redetect = useCallback(() => refresh(true), [refresh]);
	return { status, refresh, redetect };
}
