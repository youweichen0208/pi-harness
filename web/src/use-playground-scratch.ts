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

const extraDrafts = new Map<string, PlaygroundScratchStore>();
export function discardExtraDraft(file: string) {
	extraDrafts.delete(file);
	sessionStorage.removeItem("pi-harness:playground:" + file);
}

export function usePlaygroundScratch(file = "main.py") {
	let store = scratch;
	if (file !== "main.py") {
		const key = "pi-harness:playground:" + file;
		store = extraDrafts.get(file) ?? new PlaygroundScratchStore({
			async read() { return JSON.parse(sessionStorage.getItem(key) ?? '{"content":"","updatedAt":1}'); },
			async write(draft) { sessionStorage.setItem(key, JSON.stringify({ ...draft, updatedAt: Date.now() })); },
		});
		extraDrafts.set(file, store);
	}
	const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
	useEffect(store.connect, [store]);
	return { ...state, edit: store.edit, save: store.flush, reload: store.reload };
}
