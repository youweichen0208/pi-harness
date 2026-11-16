/** Bun-only entrypoint. Node must launch this file, never import it. */
import { OMP_BRIDGE_VERSION, OMP_VERSION, BUN_VERSION, type OmpBootstrap } from "./bootstrap.js";

// Extensions use console too; stdout is reserved for OMP's native RPC writer.
console.log = console.info = console.debug = (...values: unknown[]) => console.error(...values);
let shutdown: (() => Promise<void>) | undefined;
let stage = "bootstrap";
let closeProxy: (() => Promise<void>) | undefined;
try {
	const serialized = process.env.PI_WEB_OMP_BOOTSTRAP;
	delete process.env.PI_WEB_OMP_BOOTSTRAP;
	if (!serialized) throw Error("Missing bootstrap");
	const bootstrap: OmpBootstrap = JSON.parse(serialized);
	if (bootstrap.version !== OMP_BRIDGE_VERSION || !bootstrap.cwd || !bootstrap.agentDir || !bootstrap.sessionDir) throw Error("Invalid bootstrap");
	if (process.versions.bun !== BUN_VERSION) throw Error("Bun version mismatch");
	if (!bootstrap.operation && bootstrap.openAIProxy?.enabled) {
		stage = "proxy";
		const { installOmpProxy } = await import("./openai-proxy.js");
		closeProxy = await installOmpProxy(bootstrap.openAIProxy);
	}
	stage = "sdk-import";
	const { hostControlInput } = await import("./worker-control.js");
	const { rpcSessionWithAttachments } = await import("./rpc-session.js");
	const { OmpSessionStorage } = await import("./session-storage.js");
	const { OmpPersistenceJournal } = await import("./persistence-journal.js");
	const { dirname } = await import("node:path");
	const { createAgentSession, SessionManager, Settings, VERSION } = await import("@oh-my-pi/pi-coding-agent");
	const { runRpcMode } = await import("@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode");
	const { parseConfiguredThinkingLevel } = await import("@oh-my-pi/pi-tui/thinking");
	const { claimRpcInput } = await import("@oh-my-pi/pi-coding-agent/modes/rpc/rpc-input");
	if (VERSION !== OMP_VERSION) throw Error("OMP version mismatch");
	if (bootstrap.operation === "delete_history") {
		if (!bootstrap.sessionFile) throw Error("Missing history path");
		const { FileSessionStorage } = await import("@oh-my-pi/pi-coding-agent/session/session-storage");
		await new FileSessionStorage().deleteSessionWithArtifacts(bootstrap.sessionFile);
		process.stdout.write(JSON.stringify({ type: "harness_delete_history", deleted: true }) + "\n");
		process.exit(0);
	}
	if (bootstrap.operation === "projects") {
		const { readdir } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const directory = dirname(bootstrap.sessionDir);
		const projects = new Map<string, { path: string; firstAdded: number; lastUsed: number; conversationCount: number }>();
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (!entry.isDirectory() || !/^[a-f0-9]{24}$/.test(entry.name)) continue;
			for (const session of await SessionManager.list(bootstrap.cwd, join(directory, entry.name))) {
				const old = projects.get(session.cwd);
				projects.set(session.cwd, { path: session.cwd, firstAdded: Math.min(old?.firstAdded ?? Infinity, session.created.getTime()), lastUsed: Math.max(old?.lastUsed ?? 0, session.modified.getTime()), conversationCount: (old?.conversationCount ?? 0) + 1 });
			}
		}
		process.stdout.write(JSON.stringify({ type: "harness_projects", projects: [...projects.values()] }) + "\n");
		process.exit(0);
	}
	if (bootstrap.operation === "latest_history") {
		const sessions = await SessionManager.list(bootstrap.cwd, bootstrap.sessionDir);
		sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime() || b.created.getTime() - a.created.getTime() || a.path.localeCompare(b.path));
		process.stdout.write(JSON.stringify({ type: "harness_latest_history", sessionFile: sessions[0]?.path ?? null }) + "\n");
		process.exit(0);
	}
	if (bootstrap.operation === "tool_output") {
		try {
			if (!bootstrap.sessionFile || !bootstrap.toolCallId) throw Object.assign(Error("Invalid output request"), { code: "EACCES" });
			const { nativeToolOutput, taskOutputFile } = await import("./tool-output-native.js");
			const file = bootstrap.outputTask ? await taskOutputFile(bootstrap.sessionFile, bootstrap.outputTask) : bootstrap.sessionFile;
			const data = await nativeToolOutput(file, bootstrap.toolCallId, bootstrap.sessionFile);
			process.stdout.write(JSON.stringify({ type: "harness_tool_output", data }) + "\n");
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			process.stdout.write(JSON.stringify({ type: "harness_tool_output", errorCode: code === "EACCES" || code === "ENOENT" ? code : "EIO" }) + "\n");
		}
		process.exit(0);
	}
	if (bootstrap.operation === "tree_read") {
		if (!bootstrap.treeQuery || !bootstrap.treeQuery.memory && !bootstrap.sessionFile) throw Error("Missing tree history request");
		const { ensureTheme } = await import("@oh-my-pi/pi-tui/theme"); await ensureTheme();
		const { savedNativeTree, memoryNativeTree } = await import("./tree-native.js");
		const data = bootstrap.treeQuery.memory ? await memoryNativeTree(JSON.parse(await Bun.stdin.text()), bootstrap.treeQuery) : await savedNativeTree(bootstrap.sessionFile!, bootstrap.treeQuery);
		await new Promise<void>(resolve => process.stdout.write(JSON.stringify({ type: "harness_tree", data }) + "\n", () => resolve()));
		process.exit(0);
	}
	// Native non-TUI tools also use theme symbols (e.g. ask's Done row).
	// Match the CLI's public initialization without starting a theme watcher.
	stage = "theme-init";
	const { ensureTheme } = await import("@oh-my-pi/pi-tui/theme");
	await ensureTheme();
	const input = claimRpcInput();
	stage = "session-create";
	if (bootstrap.sessionFile) new OmpPersistenceJournal(dirname(bootstrap.agentDir)).assertAllowed(bootstrap.sessionFile, bootstrap.recoveryTokens);
	const storage = new OmpSessionStorage();
	const sessionManager = bootstrap.sessionFile
		? await SessionManager.open(bootstrap.sessionFile, bootstrap.sessionDir, storage, { throwIfMissing: true, initialCwd: bootstrap.cwd })
		: SessionManager.create(bootstrap.cwd, bootstrap.sessionDir, storage);
	const restricted = bootstrap.restricted;
	// Business-session preferences belong to the host's own state, not the
	// shared agent config. OMP's public overlay keeps RPC setting writes local.
	const settings = restricted ? (await Settings.init({ cwd: bootstrap.cwd, agentDir: bootstrap.agentDir })).overlay() : undefined;
	const diagnosticOptions = async () => {
		if (!process.env.HARNESS_OMP_REQUEST_DIAGNOSTICS_DIR) return {};
		const { fileURLToPath } = await import("node:url");
		const path = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./request-diagnostics-extension.ts" : "./request-diagnostics-extension.js", import.meta.url));
		return restricted
			? { preloadedPreparedExtensions: [{ path, resolvedPath: path, error: null, factory: (await import("./request-diagnostics-extension.js")).default }] }
			: { additionalExtensionPaths: [path] };
	};
	const created = await createAgentSession({
		cwd: bootstrap.cwd, agentDir: bootstrap.agentDir, sessionManager, settings,
		...await diagnosticOptions(),
		modelPattern: bootstrap.model ? [bootstrap.model] : undefined,
		thinkingLevel: parseConfiguredThinkingLevel(bootstrap.thinking),
		hasUI: true,
		...(restricted ? {
			systemPrompt: restricted.systemPrompt,
			toolNames: restricted.toolNames, restrictToolNames: true, allowRestrictedCustomTools: true,
			disableExtensionDiscovery: true, preloadedCustomToolPaths: [],
			noContextFiles: true, contextFiles: [], skills: [], rules: [], promptTemplates: [], slashCommands: [],
			enableMCP: false, enableLsp: false, enableIrc: false, skipPythonPreflight: true,
			cacheWarming: false, disableModelFallback: true, disableServerSideFallback: true,
		} : {}),
	});
	shutdown = async () => { try { await created.session.dispose(); } finally { await closeProxy?.(); } };
	// The host persists this session path before the first prompt. OMP normally
	// creates the file lazily; materialize its native header so an empty chat can
	// survive Stop, a process restart, and a later explicit resume.
	await created.session.sessionManager.ensureOnDisk();
	process.once("SIGTERM", () => { void shutdown!().finally(() => process.exit(0)); });
	process.stdout.write(JSON.stringify({ type: "harness_ready", version: OMP_BRIDGE_VERSION, ompVersion: VERSION, bunVersion: process.versions.bun }) + "\n");
	stage = "rpc";
	await runRpcMode(rpcSessionWithAttachments(created.session), {
		input: await hostControlInput(input, created.session, bootstrap, created.mcpManager, storage), setToolUIContext: created.setToolUIContext,
		subagentEventBus: created.subagentEventBus, mcpManager: created.mcpManager,
	});
} catch {
	// Never expose upstream exception text: it can include credentials or raw request bodies.
	process.stdout.write(JSON.stringify({ type: "harness_error", stage }) + "\n");
	await shutdown?.().catch(() => {});
	await closeProxy?.();
	process.exit(1);
} finally {
	await closeProxy?.();
}
