import { useSyncExternalStore } from "react";
import { withToken } from "./auth-token";
import { getClientId } from "./use-chat";
import type { PlaygroundEvent } from "./types";

/**
 * Run state for the Playground, kept outside React.
 *
 * It has to live here rather than in component state: an assistant message is
 * re-mounted when it moves from the in-flight slot into the settled list, and a
 * component-local Run would be aborted and forgotten by that remount — a Run
 * started while a turn is settling would silently vanish. Keyed by conversation
 * and source, so re-mounting (or two identical blocks) shows the same Run.
 *
 * Still ephemeral: nothing here survives a page reload.
 */

export interface PlaygroundRunState {
	phase: "running" | "done";
	stdout: string;
	stderr: string;
	exitCode: number | null;
	durationMs: number;
	compileError: boolean;
	timedOut: boolean;
	truncated: boolean;
	stopped: boolean;
	error?: string;
}

const IDLE: PlaygroundRunState = Object.freeze({ phase: "done", stdout: "", stderr: "", exitCode: null, durationMs: 0, compileError: false, timedOut: false, truncated: false, stopped: false });

interface Entry {
	state: PlaygroundRunState;
	controller: AbortController | null;
	listeners: Set<() => void>;
}

/** Bound so a long session cannot accumulate Run state for every block ever run. */
const MAX_ENTRIES = 64;
const runs = new Map<string, Entry>();

function ensure(key: string): Entry {
	let entry = runs.get(key);
	if (!entry) {
		entry = { state: IDLE, controller: null, listeners: new Set() };
		runs.set(key, entry);
		// Map preserves insertion order, so the oldest entry is the first key.
		while (runs.size > MAX_ENTRIES) runs.delete(runs.keys().next().value!);
	}
	return entry;
}

function emit(entry: Entry): void {
	for (const listener of entry.listeners) listener();
}

function subscribe(key: string, listener: () => void): () => void {
	const entry = ensure(key);
	entry.listeners.add(listener);
	return () => {
		entry.listeners.delete(listener);
	};
}

export function runKey(conversationId: string, code: string): string {
	return `${conversationId}\u0000${code}`;
}

export function usePlaygroundRun(key: string): PlaygroundRunState {
	return useSyncExternalStore(
		listener => subscribe(key, listener),
		() => runs.get(key)?.state ?? IDLE,
		() => IDLE,
	);
}

export function stopRun(key: string): void {
	const entry = runs.get(key);
	if (!entry?.controller) return;
	entry.controller.abort();
	entry.controller = null;
	entry.state = { ...entry.state, phase: "done", stopped: true };
	emit(entry);
}

export async function startRun(key: string, code: string): Promise<void> {
	const entry = ensure(key);
	entry.controller?.abort();
	const controller = new AbortController();
	entry.controller = controller;
	entry.state = { ...IDLE, phase: "running" };
	emit(entry);

	const patch = (change: Partial<PlaygroundRunState>) => {
		entry.state = { ...entry.state, ...change };
		emit(entry);
	};
	try {
		const response = await fetch(withToken("/api/playground/run"), {
			method: "POST",
			headers: { "Content-Type": "application/json", "x-pi-client": getClientId() },
			body: JSON.stringify({ code }),
			signal: controller.signal,
		});
		if (!response.ok || !response.body) {
			const body = (await response.json().catch(() => ({}))) as { error?: string };
			patch({ phase: "done", error: body.error ?? `HTTP ${response.status}` });
			return;
		}
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			for (let index = buffer.indexOf("\n\n"); index !== -1; index = buffer.indexOf("\n\n")) {
				const frame = buffer.slice(0, index);
				buffer = buffer.slice(index + 2);
				const line = frame.split("\n").find(part => part.startsWith("data: "));
				if (!line) continue;
				let event: PlaygroundEvent;
				try {
					event = JSON.parse(line.slice(6)) as PlaygroundEvent;
				} catch {
					continue;
				}
				if (event.type === "out") patch(event.stream === "stdout" ? { stdout: entry.state.stdout + event.text } : { stderr: entry.state.stderr + event.text });
				else if (event.type === "end") patch({ phase: "done", exitCode: event.exitCode, durationMs: event.durationMs, compileError: event.compileError, timedOut: event.timedOut, truncated: event.truncated });
				else if (event.type === "error") patch({ phase: "done", error: event.message });
			}
		}
		// A stream that closes without an `end` (server restart, dropped socket)
		// still has to leave the control usable.
		if (entry.state.phase === "running") patch({ phase: "done" });
	} catch (error) {
		if (controller.signal.aborted) return; // Stop already recorded the state.
		patch({ phase: "done", error: error instanceof Error ? error.message : "Run failed" });
	} finally {
		if (entry.controller === controller) entry.controller = null;
	}
}
