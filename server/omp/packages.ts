import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { killPidTree } from "../process-utils.js";
import { isRecord } from "./framing.js";
import type { UiOmpPackageJob, UiOmpPackagePlan, UiOmpPackages, UiOmpPackageSettings } from "../protocol.js";

type Owner = { clientId: string; conversationId: string; cwd: string };
type RecordJob = { owner: Owner; hostPid: number; job: UiOmpPackageJob };
type Result = { ok: true; data?: unknown } | { ok: false; error: NonNullable<UiOmpPackageJob["error"]> };
export type OmpPackageRunner = (cwd: string, request: Record<string, unknown>, signal: AbortSignal) => Promise<Result>;
const operations = ["install", "link", "update", "remove", "enable", "disable", "features", "marketplace-add", "marketplace-refresh", "marketplace-remove", "plugin-install", "plugin-update", "plugin-remove", "plugin-enable", "plugin-disable", "plugin-features"];
function parsePlan(value: unknown): UiOmpPackagePlan {
	if (!isRecord(value) || !operations.includes(String(value.operation)) || typeof value.target !== "string" || !value.target.trim() || value.target.length > 2048 || /[\x00-\x1f]|:\/\/[^/]*@|:\/\/.*\?/.test(value.target) || typeof value.root !== "string" || value.root.length > 4096 || typeof value.version !== "string" || !/^[a-f0-9]{64}$/.test(value.version)) throw Error("Invalid package plan");
	if (String(value.operation).startsWith("plugin-") ? value.scope !== "user" && value.scope !== "project" : value.scope !== undefined) throw Error("Invalid package scope");
	const plan: UiOmpPackagePlan = { operation: value.operation as UiOmpPackagePlan["operation"], target: value.target, root: value.root, version: value.version };
	if (value.scope) plan.scope = value.scope as UiOmpPackagePlan["scope"];
	for (const field of ["sharedRoot", "source", "fromVersion", "toVersion"] as const) {
		if (value[field] === undefined) continue;
		if (typeof value[field] !== "string" || value[field].length > 4096 || /[\x00-\x1f]|:\/\/[^/]*@|:\/\/.*\?/.test(value[field])) throw Error("Invalid package preview metadata");
		plan[field] = value[field];
	}
	if (value.operation === "features" || value.operation === "plugin-features") {
		const features = value.selectedFeatures;
		if (features !== null && (!Array.isArray(features) || features.length > 256 || features.some(item => typeof item !== "string" || !item || item.length > 256))) throw Error("Invalid package features");
		plan.selectedFeatures = features as string[] | null;
	} else if (value.selectedFeatures !== undefined) throw Error("Unexpected package features");
	return plan;
}

/** Standalone native package worker; install does not share the chat RPC deadline. */
export function createOmpPackageRunner(dataDir: string, options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): OmpPackageRunner {
	const require = createRequire(import.meta.url);
	const executable = join(dirname(require.resolve("bun/package.json")), "bin", "bun.exe");
	const worker = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./package-worker.ts" : "./package-worker.js", import.meta.url));
	const env = { ...process.env };
	for (const key of Object.keys(env)) if (key.startsWith("PI_") || key.startsWith("OMP_") || key === "ELECTRON_RUN_AS_NODE") delete env[key];
	env.PI_CODING_AGENT_DIR = join(dataDir, "omp", "agent");
	env.PI_NOTIFICATIONS = "off";
	return async (cwd, request, signal) => {
		const parent = join(dataDir, "omp", "package-workers"); mkdirSync(parent, { recursive: true, mode: 0o700 });
		const dir = mkdtempSync(join(parent, "worker-")), resultFile = join(dir, "result.json");
		try {
			if (signal.aborted) throw Error("Package worker interrupted");
			return await new Promise<Result>((resolve, reject) => {
				// Factory logs are deliberately not captured: packages may print secrets.
				const child = spawn(executable, [worker, resultFile], { cwd, env: options.env ?? env, stdio: ["pipe", "ignore", "ignore"], detached: process.platform !== "win32", windowsHide: true });
				let interrupted = false;
				let fallback: ReturnType<typeof setTimeout> | undefined;
				const stop = () => {
					if (interrupted) return;
					interrupted = true; if (child.pid) killPidTree(child.pid);
					// Let Windows taskkill enumerate descendants before killing its
					// parent directly if tree termination is unavailable.
					fallback = setTimeout(() => child.kill("SIGKILL"), 3000);
				};
				const timer = setTimeout(stop, options.timeoutMs ?? (request.action === "execute" ? 20 * 60_000 : 30_000));
				signal.addEventListener("abort", stop, { once: true });
				child.stdin?.on("error", () => {});
				child.stdin?.end(JSON.stringify(request));
				child.once("error", reject);
				child.once("close", code => {
					clearTimeout(timer); clearTimeout(fallback); signal.removeEventListener("abort", stop);
					if (child.pid && process.platform !== "win32") killPidTree(child.pid);
					try {
						if (interrupted || code !== 0 || statSync(resultFile).size > 1024 * 1024) throw Error("Package worker interrupted");
						const result: unknown = JSON.parse(readFileSync(resultFile, "utf8"));
						if (!isRecord(result) || typeof result.ok !== "boolean") throw Error("Invalid package result");
						resolve(result as Result);
					} catch { reject(Error("Package worker interrupted; inspect installed packages before retrying")); }
				});
				if (signal.aborted) stop();
			});
		} finally { rmSync(dir, { recursive: true, force: true }); }
	};
}

/** Jobs survive page navigation. No automatic retry after host or worker failure. */
export class OmpPackages {
	private readonly directory: string;
	private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();
	private readonly reads = new Map<AbortController, Promise<Result>>();
	private closed = false;
	constructor(dataDir: string, private runner: OmpPackageRunner = createOmpPackageRunner(dataDir)) { this.directory = join(dataDir, "omp", "package-jobs"); }
	private file(id: string) { if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("Invalid package job ID"); return join(this.directory, `${id}.json`); }
	private save(record: RecordJob) {
		const file = this.file(record.job.id), temporary = `${file}.${randomUUID()}.tmp`;
		writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 }); renameSync(temporary, file);
	}
	private owned(owner: Owner, id: string): RecordJob {
		const record = JSON.parse(readFileSync(this.file(id), "utf8")) as RecordJob;
		if (record.owner.clientId !== owner.clientId || record.owner.conversationId !== owner.conversationId || record.owner.cwd !== owner.cwd) throw Error("Package job unavailable");
		if (record.job.phase === "running" && !this.active.has(id)) {
			let live = true;
			try { process.kill(record.hostPid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") live = false; }
			if (!live) { record.job.phase = "unknown"; record.job.error = "interrupted"; record.job.finishedAt = Date.now(); this.save(record); }
		}
		return record;
	}
	get(owner: Owner, id: string) { return this.owned(owner, id).job; }
	activeCount() { return this.active.size; }
	jobs(owner: Owner) {
		if (!statExists(this.directory)) return [];
		return readdirSync(this.directory).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).flatMap(name => {
			try { return [this.get(owner, name.slice(0, -5))]; } catch { return []; }
		}).sort((a, b) => b.startedAt - a.startedAt).slice(0, 50);
	}
	private async read(cwd: string, request: Record<string, unknown>) {
		if (this.closed) throw Error("Package manager closed");
		const controller = new AbortController();
		const pending = Promise.resolve().then(() => this.runner(cwd, request, controller.signal));
		this.reads.set(controller, pending);
		try {
			const result = await pending;
			if (!result.ok) throw Error(`OMP package operation failed (${result.error})`);
			return result.data;
		} finally { this.reads.delete(controller); }
	}
	async list(cwd: string) { return await this.read(cwd, { action: "list" }) as UiOmpPackages; }
	async settings(cwd: string, target: unknown, scope: unknown, settingsScope: unknown, patch?: unknown, expectedVersion?: unknown) {
		if (patch !== undefined && this.active.size) throw Error("Another package operation is running");
		return await this.read(cwd, { action: patch === undefined ? "settings-read" : "settings-save", target, scope, settingsScope, patch, expectedVersion }) as UiOmpPackageSettings;
	}
	async preview(cwd: string, operation: unknown, target: unknown, scope?: unknown, selectedFeatures?: unknown, expectedVersion?: unknown) { return await this.read(cwd, { action: "preview", operation, target, scope, selectedFeatures, expectedVersion }) as UiOmpPackagePlan; }
	start(owner: Owner, id: string, input: unknown) {
		if (this.closed) throw Error("Package manager closed");
		const plan = parsePlan(input), file = this.file(id);
		if (statExists(file)) {
			const existing = this.owned(owner, id);
			if (JSON.stringify(existing.job.plan) !== JSON.stringify(plan)) throw Error("Package request ID already used");
			return existing.job;
		}
		if (this.active.size) throw Error("Another package operation is running");
		mkdirSync(this.directory, { recursive: true, mode: 0o700 });
		const record: RecordJob = { owner, hostPid: process.pid, job: { id, plan, phase: "running", startedAt: Date.now() } };
		writeFileSync(file, JSON.stringify(record), { flag: "wx", mode: 0o600 });
		const controller = new AbortController();
		const done = Promise.resolve().then(async () => {
			try {
				const result = await this.runner(owner.cwd, { action: "execute", plan }, controller.signal);
				record.job.phase = result.ok ? "success" : "failed";
				if (!result.ok) record.job.error = result.error;
			} catch { record.job.phase = "unknown"; record.job.error = "interrupted"; }
			finally { record.job.finishedAt = Date.now(); this.save(record); this.active.delete(id); }
		});
		// Keep rejection handled even if persistence fails (e.g. full disk).
		void done.catch(() => { this.active.delete(id); });
		this.active.set(id, { controller, done });
		return record.job;
	}
	async cancel(owner: Owner, id: string) {
		this.owned(owner, id);
		const running = this.active.get(id);
		if (!running && this.get(owner, id).phase === "running") throw Error("Package operation belongs to another running host");
		running?.controller.abort(); await running?.done;
		return this.get(owner, id);
	}
	async close() {
		this.closed = true;
		for (const read of this.reads.keys()) read.abort();
		for (const job of this.active.values()) job.controller.abort();
		await Promise.allSettled([...this.reads.values(), ...[...this.active.values()].map(job => job.done)]);
	}
}
function statExists(path: string) { try { statSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
