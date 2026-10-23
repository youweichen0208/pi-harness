import type { ClientMessage } from "../../server/protocol.js";

export interface WikiWindowMemory {
	client: string | null; cwd: string; conversationId: string; sessionId?: string;
	path: string | null; anchor: { cwd: string; conversationId: string } | null;
}
export interface LibraryConfig { cwd: string | null; path: string | null; available: boolean }
export interface WikiWindowObservation {
	ready: boolean; switching: boolean; switchError: boolean; cwd?: string;
	conversationId: string; sessionId?: string; wiki: boolean; opened: boolean;
	model: string | null; models: { id: string; provider: string }[];
	thinking?: string; availableThinking?: string[];
}
interface WindowAdapter {
	params(): { cwd: string | null; doc: string | null; client: string | null; model: string | null; thinking: string | null };
	target(cwd: string, path: string | null): void;
	readMemory(): WikiWindowMemory | null;
	writeMemory(memory: WikiWindowMemory | null): void;
	configure(action: "read" | "configure" | "remember", cwd?: string, path?: string | null): Promise<LibraryConfig>;
	send(message: ClientMessage): boolean;
	enter(path: string | null, reuse: boolean): Promise<boolean>;
	restore(memory: WikiWindowMemory): void;
	changeFolder(path: string): void;
	warn(message: string): void;
}
interface WindowState { ready: boolean; saving: boolean; needsFolder: boolean; error: string | null; unavailable: boolean }

/** Restores one window, with authoritative observations driving all boot ordering. */
export class WikiWindowSession {
	private state: WindowState;
	private listeners = new Set<() => void>();
	private generation = 0;
	private active = false;
	private boot = true;
	private sent = new Set<string>();
	private carryExpired = false;
	private carryTimer?: ReturnType<typeof setTimeout>;
	private current: WikiWindowObservation | null = null;
	private remembered = "";
	private memoryQueue: Promise<unknown> = Promise.resolve();
	constructor(private readonly library: boolean, private readonly detached: boolean, private readonly adapter: WindowAdapter) {
		this.state = { ready: !library, saving: false, needsFolder: false, error: null, unavailable: false };
	}
	getSnapshot = () => this.state;
	subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
	private publish(patch: Partial<WindowState>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
	connect = () => {
		this.active = true;
		const generation = ++this.generation;
		if (this.library && !this.adapter.params().cwd) {
			void this.adapter.configure("read").then(config => {
				if (!this.valid(generation)) return;
				if (!config.cwd || !config.available) { this.publish({ ready: false, needsFolder: true, unavailable: !!config.cwd }); return; }
				this.adapter.target(config.cwd, config.path);
				this.publish({ ready: true }); this.advance();
			}).catch(error => { if (this.valid(generation)) this.publish({ needsFolder: true, error: String(error.message ?? error) }); });
		} else { this.publish({ ready: true }); this.advance(); }
		return () => { this.active = false; ++this.generation; clearTimeout(this.carryTimer); this.carryTimer = undefined; };
	};
	private valid(generation: number) { return this.active && generation === this.generation; }
	observe(observation: WikiWindowObservation) {
		this.current = observation;
		this.advance();
	}
	private advance() {
		const current = this.current;
		if (!this.active || !this.boot || !this.state.ready || !current?.ready || current.switching || !current.cwd) return;
		if (current.opened) { this.boot = false; return; }
		if (this.library && current.switchError) {
			this.publish({ ready: false, needsFolder: true, unavailable: true }); return;
		}
		const target = this.adapter.params();
		if (this.detached) {
			if (target.cwd && target.cwd !== current.cwd) {
				if (!this.sent.has("cwd:" + target.cwd)) {
					this.sent.add("cwd:" + target.cwd);
					if (!this.adapter.send({ type: "set_cwd", path: target.cwd, source: "ui" })) this.boot = false;
				}
				return;
			}
			if (!this.carryTimer && !this.carryExpired) {
				this.carryTimer = setTimeout(() => { this.carryExpired = true; this.advance(); }, 5000);
			}
			const candidates = target.model ? current.models.filter(model => model.id === target.model || model.id.slice(model.provider.length + 1) === target.model) : [];
			const model = target.model?.includes("/") ? target.model : candidates.length === 1 ? candidates[0].id : null;
			if (!this.carryExpired) {
				if (model && current.model !== model && (!current.models.length || current.models.some(entry => entry.id === model))) {
					if (!this.sent.has("model")) { this.sent.add("model"); this.adapter.send({ type: "set_model", modelId: model }); }
					return;
				}
				if (target.thinking && current.thinking !== target.thinking && current.availableThinking?.includes(target.thinking)) {
					if (!this.sent.has("thinking")) { this.sent.add("thinking"); this.adapter.send({ type: "set_thinking", level: target.thinking }); }
					return;
				}
			}
		}
		this.boot = false; clearTimeout(this.carryTimer);
		const memory = this.adapter.readMemory();
		if (memory && memory.sessionId === current.sessionId && memory.conversationId === current.conversationId && memory.cwd === current.cwd &&
			(!this.detached || (memory.client === target.client && (target.doc === null || target.doc === memory.path)))) {
			this.adapter.restore(memory); return;
		}
		this.persist(null);
		if (this.detached) void this.adapter.enter(target.doc, current.wiki);
	}
	chooseFolder = async (path: string) => {
		if (!this.active || this.state.saving) return;
		if (this.state.ready) { this.adapter.changeFolder(path); return; }
		const generation = ++this.generation; // A late initial read cannot override an explicit choice.
		this.publish({ saving: true, error: null, unavailable: false });
		try {
			const config = await this.adapter.configure("configure", path);
			if (!this.valid(generation)) return;
			if (!config.cwd) throw new Error("Missing library folder");
			this.adapter.target(config.cwd, config.path);
			this.boot = true; this.sent.delete("cwd:" + config.cwd);
			// The next observation clears a previous failed switch.
			if (this.current) this.current = { ...this.current, switchError: false };
			this.publish({ ready: true, needsFolder: false });
			this.advance();
		} catch (error) { if (this.valid(generation)) this.publish({ needsFolder: true, error: (error as Error).message }); }
		finally { if (this.valid(generation)) this.publish({ saving: false }); }
	};
	/** Called only after the existing Wiki coordinator confirms the folder switch. */
	folderOpened = async (cwd: string): Promise<boolean> => {
		if (!this.library) return true;
		const generation = ++this.generation;
		this.publish({ saving: true, error: null, unavailable: false });
		try {
			await this.adapter.configure("configure", cwd);
			if (!this.valid(generation)) return false;
			this.remembered = "";
			this.publish({ ready: true, needsFolder: false }); return true;
		} catch (error) { if (this.valid(generation)) this.publish({ needsFolder: true, error: (error as Error).message }); return false; }
		finally { if (this.valid(generation)) this.publish({ saving: false }); }
	};
	dismissFolder = () => { if (this.state.ready && !this.state.saving) this.publish({ needsFolder: false, error: null, unavailable: false }); };
	persist = (memory: WikiWindowMemory | null) => { this.adapter.writeMemory(memory); };
	documentOpened = (memory: WikiWindowMemory) => {
		this.persist(memory);
		if (!this.library || !this.active) return;
		const key = memory.cwd + "\n" + memory.path;
		if (key === this.remembered) return;
		this.remembered = key;
		const generation = this.generation;
		this.memoryQueue = this.memoryQueue.catch(() => {}).then(async () => {
			if (!this.valid(generation)) return;
			await this.adapter.configure("remember", memory.cwd, memory.path);
		}).catch(error => { if (this.valid(generation)) this.adapter.warn(error.message); });
	};
}
