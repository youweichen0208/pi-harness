import { useEffect, useSyncExternalStore } from "react";
import { withToken } from "./auth-token";
import { PlaygroundScratchStore } from "./playground-scratch-store";
import type { PlaygroundScratch } from "./types";

let version = 0;
const scratch = new PlaygroundScratchStore({
	async read() {
		const response = await fetch(withToken("/api/playground/scratch"));
		if (!response.ok) throw new Error(String(response.status));
		const stored = await response.json() as PlaygroundScratch;
		version = stored.updatedAt;
		return stored;
	},
	async write(draft) {
		const response = await fetch(withToken("/api/playground/scratch"), {
			method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...draft, expectedVersion: version }),
		});
		if (!response.ok) throw new Error(String(response.status));
		version = (await response.json() as PlaygroundScratch).updatedAt;
	},
});

export function usePlaygroundScratch() {
	const state = useSyncExternalStore(scratch.subscribe, scratch.getSnapshot);
	useEffect(scratch.connect, []);
	return { ...state, edit: scratch.edit, save: scratch.flush, reload: scratch.reload };
}
