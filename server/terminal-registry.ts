/**
 * TerminalRegistry — one TerminalManager per project workspace.
 *
 * Terminals are workspace infrastructure, not conversation state. Deleting a
 * chat must never kill a shell the user is still using (a dev server, a test
 * run, a docker compose tail), so the registry — not the Conversation — owns
 * the PTYs and only an explicit close, the service shutting down, or dropping
 * an IDLE slot releases them.
 *
 * The workspace identity is the canonical project directory (`ProjectRootKey`).
 * TerminalManager.safeCwd() already enforces that boundary for every spawn, so
 * the registry key and the PTY boundary are the same fact. It is deliberately
 * NOT a UI workspace-group id: ProjectWorkspaceStore is a UI-only catalog of
 * paths (a path may belong to zero or several groups, and deleting a group has
 * no resource semantics), so it cannot own processes.
 */
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { ServerMessage } from "./protocol.js";
import { TerminalManager } from "./terminals.js";

/** Canonical identity of a project workspace on this machine. */
export type ProjectRootKey = string;

/** Service-wide live-PTY budget (on top of MAX_TERMINALS per workspace).
 *  A protective value, not a permanent contract. */
export const MAX_LIVE_TERMINALS_TOTAL = 48;

/** How many idle (zero live PTY) workspaces keep their exited-terminal
 *  scrollback before the least recently used ones are dropped. */
const MAX_IDLE_WORKSPACES = 8;

/**
 * Normalize a directory into a workspace key.
 *
 * Centralized on purpose: `resolve` handles relative input and `realpathSync
 * .native` resolves symlinks and restores the on-disk casing (Windows), so two
 * spellings of one directory can never grow two sets of PTYs. A missing path or
 * a file has NO key — callers must refuse instead of inventing an identity.
 */
export function projectRootKey(dir: string): ProjectRootKey | null {
	try {
		const abs = resolve(dir);
		if (!statSync(abs).isDirectory()) return null;
		return realpathSync.native(abs);
	} catch {
		return null;
	}
}

interface Slot {
	manager: TerminalManager;
	lastUsedAt: number;
}

export class TerminalRegistry {
	private slots = new Map<ProjectRootKey, Slot>();

	/** `emitFor` binds a manager's output to its workspace so the server can tag
	 *  every terminal message with the workspace it belongs to. */
	constructor(private readonly emitFor: (key: ProjectRootKey) => (msg: ServerMessage) => void) {}

	/** The workspace's manager, created on first use. */
	ensure(key: ProjectRootKey): TerminalManager {
		const existing = this.slots.get(key);
		if (existing) {
			existing.lastUsedAt = Date.now();
			return existing.manager;
		}
		const manager = new TerminalManager(this.emitFor(key), key, {
			live: () => this.liveCount(),
			max: MAX_LIVE_TERMINALS_TOTAL,
		});
		this.slots.set(key, { manager, lastUsedAt: Date.now() });
		return manager;
	}

	/** Existing manager only — read paths must not create one. */
	get(key: ProjectRootKey): TerminalManager | undefined {
		return this.slots.get(key)?.manager;
	}

	has(key: ProjectRootKey): boolean {
		return this.slots.has(key);
	}

	/** Live PTYs across every workspace (service cap + eviction input). */
	liveCount(): number {
		let total = 0;
		for (const slot of this.slots.values()) total += slot.manager.liveCount();
		return total;
	}

	/**
	 * Drop IDLE slots, least recently used first.
	 *
	 * A slot with any live PTY is never reclaimed — otherwise the original bug
	 * ("switching away killed my dev server") would just move from conversations
	 * to projects. An idle slot with exited-terminal scrollback is kept while it
	 * is among the MAX_IDLE_WORKSPACES most recent; after that its history goes.
	 */
	reap(): void {
		const idle = [...this.slots.entries()]
			.filter(([, slot]) => slot.manager.liveCount() === 0)
			.sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
		for (const [key] of idle.slice(0, Math.max(0, idle.length - MAX_IDLE_WORKSPACES))) {
			this.slots.delete(key);
		}
	}

	/** Kill every PTY of every workspace (service shutdown). */
	closeAll(): void {
		for (const slot of this.slots.values()) slot.manager.killAll();
		this.slots.clear();
	}
}