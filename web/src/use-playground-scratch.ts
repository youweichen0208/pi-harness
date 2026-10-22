import { useEffect, useSyncExternalStore } from "react";
import { withToken } from "./auth-token";
import { PlaygroundScratchStore } from "./playground-scratch-store";
import type { PlaygroundScratch } from "./types";

const scratch = new PlaygroundScratchStore({
	async read() {
		const response = await fetch(withToken("/api/playground/scratch"));
		if (!response.ok) throw new Error(String(response.status));
		return await response.json() as PlaygroundScratch;
	},
	async write(draft) {
		const response = await fetch(withToken("/api/playground/scratch"), {
			method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft),
		});
		if (!response.ok) throw new Error(String(response.status));
	},
});

export function usePlaygroundScratch() {
	const state = useSyncExternalStore(scratch.subscribe, scratch.getSnapshot);
	useEffect(scratch.connect, []);
	return { ...state, edit: scratch.edit };
}
