import type { ClientMessage, ServerMessage } from "../../server/protocol.js";
import type { CurrentFileContext, ReadCurrentFile, SaveCurrentFile } from "./current-file.js";
import { randomUuid } from "./uuid.js";

type FileContent = Extract<ServerMessage, { type: "file_content" }>;
type Result = Extract<ServerMessage, { type: "file_result" }>;
export interface FileDocumentState {
	loaded: FileContent | null;
	draft: string;
	loading: boolean;
	status: "saved" | "saving" | "failed";
	error: { kind: "offline" | "failed"; message?: string } | null;
	conflict: boolean;
	remoteText: string | null;
	leave: boolean;
	savedAt: Date;
	readRevision: number;
}
type Identity = { cwd: string; path: string; name: string };

/** Owns one open file, including the disk baseline used by send and navigation. */
export class FileDocument {
	readonly id = randomUuid();
	private state: FileDocumentState = { loaded: null, draft: "", loading: false, status: "saved", error: null, conflict: false, remoteText: null, leave: false, savedAt: new Date(), readRevision: 0 };
	private listeners = new Set<() => void>();
	private readId = "";
	private compareId = "";
	private compareAfterSave = false;
	private pending: { id: string; text: string; next?: () => void } | null = null;
	private leaveAction: (() => void) | null = null;
	private readTimer?: ReturnType<typeof setTimeout>;
	private saveTimer?: ReturnType<typeof setTimeout>;
	private idleTimer?: ReturnType<typeof setTimeout>;
	private active = false;
	private connected = true;
	private disabled = false;

	constructor(readonly file: Identity, private send: (message: ClientMessage) => boolean, private autoSave = false) {}
	getSnapshot = () => this.state;
	subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
	private publish(patch: Partial<FileDocumentState>) {
		this.state = { ...this.state, ...patch };
		for (const listener of this.listeners) listener();
		this.schedule();
	}
	get dirty() { return this.state.loaded !== null && this.state.draft !== this.state.loaded.text; }
	get canEdit() { const c = this.state.loaded; return !!c && c.kind === "text" && !c.binary && !c.truncated; }
	get eligible() { return this.active && this.canEdit && !this.state.loading && !this.disabled; }
	get context(): CurrentFileContext | null { return this.eligible ? { ...this.file, id: this.id, dirty: this.dirty } : null; }
	connect = () => {
		this.active = true;
		this.reload();
		return () => {
			this.active = false;
			clearTimeout(this.readTimer); clearTimeout(this.saveTimer); clearTimeout(this.idleTimer);
			this.readId = ""; this.compareId = ""; this.pending = null; this.leaveAction = null;
		};
	};
	observe(connected: boolean, disabled: boolean) {
		const changed = connected !== this.connected || disabled !== this.disabled;
		this.connected = connected; this.disabled = disabled;
		if (!connected) {
			if (this.state.loading) this.failRead();
			if (this.pending) this.failSave();
		}
		if (changed) this.publish({}); else this.schedule();
	}
	edit = (draft: string) => { if (this.active) this.publish({ draft }); };
	private schedule() {
		clearTimeout(this.idleTimer);
		if (this.active && this.autoSave && this.dirty && this.eligible && this.connected && this.state.status === "saved") {
			this.idleTimer = setTimeout(() => this.save(), 800);
		}
	}
	reload = () => {
		if (!this.active || this.disabled || this.pending) return;
		clearTimeout(this.readTimer);
		this.compareId = "";
		this.readId = randomUuid();
		this.publish({ loading: true, error: null });
		this.readTimer = setTimeout(() => this.failRead(), 15000);
		if (!this.connected || !this.send({ type: "read_file", ...this.file, requestId: this.readId })) this.failRead();
	};
	externalChanged = () => {
		if (!this.active || !this.state.loaded || this.disabled || !this.connected) return;
		if (this.pending) { this.compareAfterSave = true; return; }
		this.compareAfterSave = false;
		this.compareId = randomUuid();
		this.send({ type: "read_file", ...this.file, requestId: this.compareId });
	};
	receiveContent(content: FileContent | null) {
		if (!this.active || !content || content.cwd !== this.file.cwd || content.path !== this.file.path) return;
		if (content.requestId && content.requestId === this.readId) {
			this.readId = ""; clearTimeout(this.readTimer);
			this.publish({ loaded: content, draft: content.text, loading: false, conflict: false, status: "saved", error: null, remoteText: null, savedAt: new Date(), readRevision: this.state.readRevision + 1 });
		} else if (content.requestId && content.requestId === this.compareId) {
			this.compareId = "";
			if (content.version === this.state.loaded?.version) return;
			if (this.dirty) this.publish({ remoteText: content.text });
			else this.publish({ loaded: content, draft: content.text, remoteText: null });
		}
	}
	receiveResult(result: Result | null) {
		if (!this.active || !result || result.cwd !== this.file.cwd || result.path !== this.file.path) return;
		if (result.operation === "read" && result.requestId === this.readId) {
			this.readId = ""; clearTimeout(this.readTimer);
			this.publish({ loading: false, error: { kind: "failed", message: result.error } });
		}
		if (result.operation !== "write" || !this.pending || result.requestId !== this.pending.id) return;
		const saved = this.pending;
		this.pending = null; clearTimeout(this.saveTimer);
		if (!result.ok) { this.publish({ status: "failed", conflict: !!result.conflict, error: { kind: "failed", message: result.error } }); return; }
		const loaded = this.state.loaded;
		if (!loaded) return;
		// Publish the confirmed baseline synchronously before any send continuation.
		this.publish({ loaded: { ...loaded, text: saved.text, version: result.version, size: new TextEncoder().encode(saved.text).length, lines: saved.text ? saved.text.split("\n").length - (saved.text.endsWith("\n") ? 1 : 0) : 0 }, status: "saved", conflict: false, error: null, savedAt: new Date(), remoteText: null });
		if (this.compareAfterSave) this.externalChanged();
		saved.next?.();
	}
	private failRead() {
		clearTimeout(this.readTimer); this.readId = "";
		this.publish({ loading: false, error: { kind: "offline" } });
	}
	private failSave() {
		clearTimeout(this.saveTimer); this.pending = null;
		this.publish({ status: "failed", error: { kind: "offline" } });
	}
	save = (force = false, next?: () => void): boolean => {
		if (!this.active || !this.eligible || this.pending) return false;
		if (!this.connected) { this.failSave(); return false; }
		const loaded = this.state.loaded!;
		const requestId = randomUuid();
		this.pending = { id: requestId, text: this.state.draft, next };
		this.publish({ status: "saving", error: null });
		this.saveTimer = setTimeout(() => this.failSave(), 15000);
		if (!this.send({ type: "write_file", path: this.file.path, cwd: this.file.cwd, text: this.state.draft, requestId, expectedVersion: loaded.version, force })) { this.failSave(); return false; }
		return true;
	};
	guard = (action: () => void) => {
		if (!this.active) return;
		if (this.pending) { if (this.autoSave && !this.pending.next) this.pending.next = action; return; }
		if (!this.dirty) { action(); return; }
		if (this.autoSave && this.state.status !== "failed" && this.connected && !this.disabled) { this.save(false, action); return; }
		this.leaveAction = action; this.publish({ leave: true });
	};
	resolveLeave = (choice: "save" | "discard" | "cancel") => {
		const next = this.leaveAction; this.leaveAction = null; this.publish({ leave: false });
		if (!next) return;
		if (choice === "save") this.save(false, next);
		else if (choice === "discard") next();
	};
	readContext: ReadCurrentFile = id => this.eligible && id === this.id ? { path: this.file.path, mode: "inline", editorSnapshot: { cwd: this.file.cwd, text: this.state.draft, dirty: this.dirty, version: this.state.loaded?.version } } : null;
	saveContext: SaveCurrentFile = (id, next) => {
		if (!this.active || !this.eligible || id !== this.id) return false;
		if (!this.dirty) { next(); return true; }
		// Preserve existing send policy: a second send never joins an in-flight save.
		return this.save(false, next);
	};
}
