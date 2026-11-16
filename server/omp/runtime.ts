import { activeOpenAIProxy } from "../openai-proxy.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { mkdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { OmpToolOutput, OmpTaskOutputPath } from "./tool-output.js";
import { isRecord } from "./framing.js";
import { OmpTransport, type OmpEnvelope, type OmpFrame } from "./transport.js";
import { OMP_BRIDGE_VERSION, OMP_VERSION, BUN_VERSION, type OmpBootstrap } from "./bootstrap.js";
import type { DiskProjectSummary } from "../client-state.js";

export interface OmpRuntimeOptions {
	conversationId: string;
	dataDir: string;
	cwd: string;
	kind?: "chat" | "wiki" | "ssh" | "playground" | "auth";
	model?: string;
	thinking?: OmpBootstrap["thinking"];
	sessionFile?: string;
	recoveryTokens?: string[];
	diagnosticsRunId?: string;
	restricted?: OmpBootstrap["restricted"];
	messageUpdates?: "full" | "delta";
	askDialog?: boolean;
	env?: NodeJS.ProcessEnv;
	onTransport?: (transport: OmpTransport) => void;
	onEvent: (event: OmpEnvelope) => void;
	onExit: (error: Error) => void;
}

type LaunchOptions = Pick<OmpRuntimeOptions, "dataDir" | "cwd" | "kind" | "sessionFile" | "recoveryTokens" | "model" | "thinking" | "restricted" | "env" | "diagnosticsRunId"> & { outputTask?: OmpTaskOutputPath };
/** Caller holds host ownership and has closed the target worker. Native storage
 * removes the transcript, artifacts and Windows rewrite backups together. */
export async function deleteOmpHistory(options: Pick<OmpRuntimeOptions, "dataDir" | "cwd" | "kind" | "sessionFile">): Promise<void> {
	const { executable, worker, cwd, env } = await prepareLaunch(options, "delete_history");
	try {
		const { stdout } = await promisify(execFile)(executable, [worker], { cwd, env, timeout: 30_000, maxBuffer: 64 * 1024, windowsHide: true });
		const result: unknown = JSON.parse(stdout);
		if (!isRecord(result) || result.type !== "harness_delete_history" || result.deleted !== true) throw Error("Delete incomplete");
	} catch { throw Error("OMP 历史删除未完整完成，请检查文件权限和占用后刷新历史列表"); }
}
const projectReads = new Map<string, Promise<DiskProjectSummary[]>>();

/** Discover only this application's ordinary OMP history, without opening an agent. */
export function listOmpProjects(options: Pick<OmpRuntimeOptions, "dataDir" | "cwd" | "env">): Promise<DiskProjectSummary[]> {
	const key = resolve(options.dataDir);
	const pending = projectReads.get(key); if (pending) return pending;
	const read = (async () => {
		const { executable, worker, cwd, env } = await prepareLaunch({ ...options, kind: "chat" }, "projects");
		try {
			const { stdout } = await promisify(execFile)(executable, [worker], { cwd, env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
			const result: unknown = JSON.parse(stdout);
			if (!isRecord(result) || result.type !== "harness_projects" || !Array.isArray(result.projects)) throw Error("Invalid project catalog");
			return result.projects.map(project => {
				if (!isRecord(project) || typeof project.path !== "string" || !isAbsolute(project.path) || typeof project.lastUsed !== "number" || !Number.isFinite(project.lastUsed)
					|| typeof project.firstAdded !== "number" || !Number.isFinite(project.firstAdded) || typeof project.conversationCount !== "number" || !Number.isSafeInteger(project.conversationCount) || project.conversationCount < 0) throw Error("Invalid project metadata");
				return { path: project.path, lastUsed: project.lastUsed, firstAdded: project.firstAdded, conversationCount: project.conversationCount };
			});
		} catch { throw Error("OMP project history catalog unavailable"); }
	})().finally(() => { projectReads.delete(key); });
	projectReads.set(key, read); return read;
}
async function prepareLaunch(options: LaunchOptions, operation?: OmpBootstrap["operation"], toolCallId?: string, treeQuery?: OmpBootstrap["treeQuery"]) {
	const requestedRoot = resolve(options.dataDir, "omp");
	await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
	const root = await realpath(requestedRoot);
	const cwd = await realpath(options.cwd);
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "sessions", options.kind ?? "chat", createHash("sha256").update(cwd).digest("hex").slice(0, 24));
	await mkdir(agentDir, { recursive: true, mode: 0o700 });
	await mkdir(sessionDir, { recursive: true, mode: 0o700 });
	let sessionFile: string | undefined;
	if (options.sessionFile) {
		sessionFile = await realpath(options.sessionFile);
		const rel = relative(await realpath(sessionDir), sessionFile);
		if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) throw Error("OMP session is outside its workspace session directory");
	}
	const bootstrap: OmpBootstrap = { version: OMP_BRIDGE_VERSION, openAIProxy: operation ? undefined : activeOpenAIProxy(options.dataDir), operation, toolCallId, outputTask: options.outputTask, treeQuery, cwd, agentDir, sessionDir, sessionFile, recoveryTokens: options.recoveryTokens, model: options.model, thinking: options.thinking, restricted: options.restricted };
	const env = { ...(options.env ?? process.env) };
	const diagnosticDirectory = env.PI_WEB_MODEL_DIAGNOSTICS_DIR;
	delete env.HARNESS_OMP_REQUEST_DIAGNOSTICS_DIR;
	delete env.HARNESS_OMP_DIAGNOSTICS_RUN;
	if (!operation && diagnosticDirectory) {
		env.HARNESS_OMP_REQUEST_DIAGNOSTICS_DIR = resolve(diagnosticDirectory);
		env.HARNESS_OMP_DIAGNOSTICS_RUN = options.diagnosticsRunId;
	}
	// Pi's inherited session/profile selectors must never reopen or migrate legacy files.
	for (const key of Object.keys(env)) if (key.startsWith("PI_") || key.startsWith("OMP_") || key === "ELECTRON_RUN_AS_NODE") delete env[key];
	env.PI_CODING_AGENT_DIR = agentDir;
	env.PI_WEB_OMP_BOOTSTRAP = JSON.stringify(bootstrap);
	env.PI_NOTIFICATIONS = "off";
	env.PI_RPC_EMIT_TITLE = "1";
	const require = createRequire(import.meta.url);
	const executable = join(dirname(require.resolve("bun/package.json")), "bin", "bun.exe");
	const worker = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js", import.meta.url));
	return { executable, worker, cwd, env };
}

/** Read the native catalog before opening a project; failed reads never create a blank replacement. */
export async function latestOmpHistory(options: Pick<OmpRuntimeOptions, "dataDir" | "cwd" | "kind" | "env">): Promise<string | undefined> {
	const { executable, worker, cwd, env } = await prepareLaunch(options, "latest_history");
	try {
		const { stdout } = await promisify(execFile)(executable, [worker], { cwd, env, timeout: 30_000, maxBuffer: 64 * 1024, windowsHide: true });
		const result = JSON.parse(stdout);
		if (result.type !== "harness_latest_history" || result.sessionFile !== null && typeof result.sessionFile !== "string") throw Error("Invalid history catalog");
		return result.sessionFile ?? undefined;
	} catch { throw Error("OMP history catalog unavailable"); }
}

/** Metadata-only subprocess; in particular, downloads never revive a stopped agent. */
export async function readOmpToolOutput(options: Pick<OmpRuntimeOptions, "dataDir" | "cwd" | "kind" | "env"> & { sessionFile: string; outputTask?: OmpTaskOutputPath }, toolCallId: string): Promise<OmpToolOutput> {
	const { executable, worker, cwd, env } = await prepareLaunch(options, "tool_output", toolCallId);
	try {
		const { stdout } = await promisify(execFile)(executable, [worker], { cwd, env, timeout: 30_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
		const result: unknown = JSON.parse(stdout);
		if (!isRecord(result) || result.type !== "harness_tool_output") throw Error("Invalid output response");
		if (["EACCES", "ENOENT"].includes(String(result.errorCode))) throw Object.assign(Error("Output unavailable"), { code: result.errorCode });
		const data = result.data;
		if (!isRecord(data) || typeof data.text !== "string" || !Array.isArray(data.artifacts) || !data.artifacts.every(item => isRecord(item) && typeof item.id === "string" && typeof item.name === "string" && typeof item.default === "boolean" && typeof item.partial === "boolean" && (typeof item.path === "string" || item.path === null))) throw Error("Invalid output response");
		return data as unknown as OmpToolOutput;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		throw Object.assign(Error("OMP output unavailable"), { code: code === "EACCES" || code === "ENOENT" ? code : "EIO" });
	}
}

/** A stopped session's tree is read without constructing an AgentSession. */
export async function readOmpTree(options: Pick<OmpRuntimeOptions, "dataDir" | "cwd" | "kind" | "env"> & { sessionFile?: string }, treeQuery: NonNullable<OmpBootstrap["treeQuery"]>, snapshot?: Record<string, unknown>): Promise<OmpFrame> {
	const { executable, worker, cwd, env } = await prepareLaunch(snapshot ? { ...options, sessionFile: undefined } : options, "tree_read", undefined, { ...treeQuery, memory: snapshot !== undefined });
	try {
		const execution = promisify(execFile)(executable, [worker], { cwd, env, timeout: 30_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
		execution.child.stdin?.on("error", () => {});
		execution.child.stdin?.end(snapshot ? JSON.stringify(snapshot) : "");
		const { stdout } = await execution;
		const result: unknown = JSON.parse(stdout);
		if (!isRecord(result) || result.type !== "harness_tree" || !isRecord(result.data)) throw Error("Invalid tree response");
		return { type: "harness_tree", data: result.data };
	} catch { throw Error("OMP 已保存的会话树暂不可读取，请检查历史文件后重试"); }
}

/** Creates one SDK process; no credentials in argv and no shared ~/.pi or ~/.omp writes. */
export async function createOmpRuntime(options: OmpRuntimeOptions): Promise<OmpTransport> {
	const { executable, worker, cwd, env } = await prepareLaunch(options);
	let readyResolve!: () => void, readyReject!: (error: Error) => void;
	const ready = new Promise<void>((resolveReady, rejectReady) => { readyResolve = resolveReady; readyReject = rejectReady; });
	let matched = false;
	const transport = new OmpTransport({
		conversationId: options.conversationId, executable, args: [worker], cwd, env,
		onEvent(event) {
			const frame = event.frame;
			if (frame.type === "harness_ready") {
				matched = frame.version === OMP_BRIDGE_VERSION && frame.ompVersion === OMP_VERSION && frame.bunVersion === BUN_VERSION;
				if (!matched) readyReject(Error("OMP worker version mismatch"));
				return;
			}
			if (frame.type === "harness_error") { readyReject(Error(`OMP worker startup failed (${String(frame.stage)})`)); return; }
			if (frame.type === "ready") {
				if (matched && Array.isArray(frame.supportedProtocolVersions) && frame.supportedProtocolVersions.includes(2)) readyResolve();
				else readyReject(Error("OMP worker does not support the required protocol"));
				return;
			}
			options.onEvent(event);
		},
		onExit(error) { readyReject(error); options.onExit(error); },
	});
	options.onTransport?.(transport);
	const timer = setTimeout(() => readyReject(Error("OMP worker startup timed out")), 30_000);
	try {
		await ready;
		await transport.request("negotiate_protocol", { protocolVersion: 2 });
		await transport.request("set_event_filter", { events: null, messageUpdates: options.messageUpdates ?? "delta" });
		await transport.request("set_subagent_subscription", { level: "events" });
		if (options.askDialog) await transport.request("set_ask_dialog", { enabled: true });
		return transport;
	} catch (error) {
		await transport.close();
		throw error;
	} finally { clearTimeout(timer); }
}

/** A product Stop ends the whole runtime, including native background jobs.
 * Retain its sessionFile before calling; a later explicit user submission may
 * reopen that file in a new generation. This function never resubmits a prompt. */
export async function stopOmpRuntime(runtime: OmpTransport, hostTools?: { close(): void }, afterAbort?: () => Promise<void>): Promise<void> {
	hostTools?.close();
	let deadline: ReturnType<typeof setTimeout> | undefined;
	try {
		// Native compact/navigate_tree occupy the RPC serial queue. Cancel their
		// side requests first so the normal host-abort command can be processed.
		const abort = (async () => {
			await runtime.request("harness_prepare_stop");
			await runtime.request("abort_and_restore_queue");
			// Best-effort final view; metadata failure must not prevent Stop.
			await afterAbort?.().catch(() => {});
		})();
		// An extension's session transition hook may never resolve and has no
		// public cancellation hook. Stop still closes only this owned process;
		// an absent RPC reply is never fabricated as an acknowledged cancellation.
		await Promise.race([abort, new Promise<void>(resolve => { deadline = setTimeout(resolve, 5000); })]);
	}
	finally { clearTimeout(deadline); await runtime.close(); }
}
