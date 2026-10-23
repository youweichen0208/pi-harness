/**
 * Playground HTTP routes — the status surface and the Run stream.
 *
 * Deliberately HTTP rather than new WebSocket messages: a Run is initiated by a
 * button, not by the agent, so it is request/response plus a stream, and the
 * notes routes already established that a core surface can live on HTTP without
 * touching the wire protocol. Cancellation needs no server-side registry — the
 * client aborts and the connection close kills the process tree.
 *
 * Registered *before* the compression middleware in `index.ts`; gzip would
 * buffer the event stream.
 */

import { readFileSync } from "node:fs";
import { writeFileAtomic } from "./private-file.js";
import { join } from "node:path";
import type { Express } from "express";
import type { IncomingMessage } from "node:http";
import type { PlaygroundConfigPatch, PlaygroundEvent, PlaygroundScratch, PlaygroundStatus, PlaygroundTests, PlaygroundTestConfig } from "./protocol.js";
import { PlaygroundConfigStore, playgroundEnvLock } from "./playground-config.js";
import { createJdkProbe, resolveHostJdk, type JdkProbe } from "./playground-jdk.js";
import { discoverJavaMethods, isCaseList, isTestConfig, validateCases } from "./playground-methods.js";
import { ConcurrencyGate, runJava } from "./playground-run.js";

/** Source larger than this is refused before anything is written to disk. */
const MAX_SOURCE_BYTES = 262_144;

/**
 * The scratch draft of the left-panel Playground page — one doc per install,
 * persisted so "next time it's still there" holds. Deliberately writable even
 * when execution is off: writing code is not running it.
 */
class PlaygroundScratchStore {
	constructor(private readonly file: string) {}
	read(): PlaygroundScratch {
		try {
			const raw = JSON.parse(readFileSync(this.file, "utf8")) as { content?: unknown; tests?: unknown };
			return { ...(isTestConfig(raw.tests) ? { tests: raw.tests } : {}), content: typeof raw.content === "string" ? raw.content : "", updatedAt: typeof (raw as { updatedAt?: unknown }).updatedAt === "number" ? (raw as { updatedAt: number }).updatedAt : 0 };
		} catch {
			// Missing or corrupt file: an empty draft, never a crash. Fail-open only
			// loses scratch text, which is the least valuable thing here.
			return { content: "", updatedAt: 0 };
		}
	}
	write(content: string, tests?: PlaygroundTestConfig): PlaygroundScratch {
		const doc = { content, tests: tests ?? this.read().tests, updatedAt: Date.now() };
		writeFileAtomic(this.file, JSON.stringify(doc));
		return doc;
	}
}

/** Accepted keys of a config write, and the exact type each one must have. */
const FIELD_TYPES = { enabled: "boolean", timeoutMs: "number", maxOutputBytes: "number", maxHeapMb: "number", maxConcurrent: "number" } as const;

export interface PlaygroundRouteOptions {
	/** Data directory; the global switch lives at `<dataDir>/playground.json`. */
	dataDir: string;
	/** Same-authority predicate shared with every other HTTP route. */
	allowed: (req: IncomingMessage) => boolean;
	env?: Readonly<Record<string, string | undefined>>;
	/** Injectable for tests; defaults to a real probe against `env`. */
	probe?: JdkProbe;
}

export function installPlaygroundRoutes(app: Express, options: PlaygroundRouteOptions): void {
	const { dataDir, allowed } = options;
	const env = options.env ?? process.env;
	const store = new PlaygroundConfigStore(join(dataDir, "playground.json"));
	const scratchStore = new PlaygroundScratchStore(join(dataDir, "playground-scratch.json"));
	const probe = options.probe ?? createJdkProbe(env);
	const gate = new ConcurrencyGate();

	async function currentStatus(force: boolean): Promise<PlaygroundStatus> {
		const config = store.read();
		const locked = playgroundEnvLock(env);
		return {
			// The environment switch wins over the file, and the UI reports it as
			// locked so the setting reads as read-only rather than mysteriously off.
			enabled: locked ? false : config.enabled,
			locked,
			jdk: await probe.get(force),
			limits: { timeoutMs: config.timeoutMs, maxOutputBytes: config.maxOutputBytes, maxHeapMb: config.maxHeapMb },
		};
	}

	app.all("/api/playground/status", async (req, res) => {
		res.setHeader("Cache-Control", "no-store");
		if (!allowed(req)) {
			res.status(403).json({ error: "Forbidden" });
			return;
		}
		if (req.method !== "GET" && req.method !== "HEAD") {
			res.sendStatus(405);
			return;
		}
		try {
			// `?refresh=1` is the "re-detect" action: users install a JDK while the
			// server is already running and must not have to restart it.
			res.json(await currentStatus(req.query.refresh !== undefined));
		} catch {
			res.status(500).json({ error: "Playground status failed" });
		}
	});

	app.all("/api/playground/config", async (req, res) => {
		res.setHeader("Cache-Control", "no-store");
		if (!allowed(req)) {
			res.status(403).json({ error: "Forbidden" });
			return;
		}
		if (req.method !== "POST") {
			res.sendStatus(405);
			return;
		}
		if (!req.is("application/json")) {
			res.status(403).json({ error: "Forbidden" });
			return;
		}
		// Locked is read-only, not merely off: the write path refuses as well, so a
		// deployment that sets PI_WEB_PLAYGROUND cannot be un-set from the page.
		if (playgroundEnvLock(env)) {
			res.status(403).json({ error: "Playground is locked by PI_WEB_PLAYGROUND" });
			return;
		}
		const body = req.body as Record<string, unknown> | undefined;
		if (!body || typeof body !== "object" || Array.isArray(body)) {
			res.status(400).json({ error: "Invalid config" });
			return;
		}
		const fields = Object.keys(body);
		// Strict, including an empty write: a partial write that silently reset an
		// unrelated field, or an empty one treated as a no-op, would both hide a bug
		// in whatever sent it. Types are checked here so `normalize` never has to
		// guess between "absent" and "nonsense".
		if (!fields.length || fields.some(field => !(field in FIELD_TYPES) || typeof body[field] !== FIELD_TYPES[field as keyof typeof FIELD_TYPES])) {
			res.status(400).json({ error: "Invalid config" });
			return;
		}
		try {
			store.write({ ...store.read(), ...(body as PlaygroundConfigPatch) });
			res.json(await currentStatus(false));
		} catch {
			res.status(500).json({ error: "Playground config failed" });
		}
	});

	app.all("/api/playground/scratch", (req, res) => {
		res.setHeader("Cache-Control", "no-store");
		if (!allowed(req)) {
			res.status(403).json({ error: "Forbidden" });
			return;
		}
		if (req.method === "GET" || req.method === "HEAD") {
			res.json(scratchStore.read());
			return;
		}
		if (req.method !== "PUT" || !req.is("application/json")) {
			res.sendStatus(405);
			return;
		}
		// Content is required; tests are an optional bounded configuration.
		// Legacy content-only writes preserve tests. Empty content is a valid clear.
		const body = req.body as Record<string, unknown> | undefined;
		if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => key !== "content" && key !== "tests") || (body.tests !== undefined && !isTestConfig(body.tests)) || typeof body.content !== "string" || Buffer.byteLength(body.content, "utf8") > MAX_SOURCE_BYTES) {
			res.status(400).json({ error: "Invalid scratch" });
			return;
		}
		try {
			res.json(scratchStore.write(body.content, body.tests as PlaygroundTestConfig | undefined));
		} catch {
			res.status(500).json({ error: "Playground scratch failed" });
		}
	});

	// Formatting is editing, so it remains available with execution disabled.
	app.post("/api/playground/format", async (req, res) => {
		res.setHeader("Cache-Control", "no-store");
		if (!allowed(req) || !req.is("application/json")) { res.sendStatus(403); return; }
		const body = req.body;
		if (!body || typeof body.code !== "string" || Object.keys(body).some(key => key !== "code") || Buffer.byteLength(body.code, "utf8") > MAX_SOURCE_BYTES) {
			res.status(400).json({ error: "Invalid code" }); return;
		}
		try {
			const [{ format }, { default: java }] = await Promise.all([import("prettier"), import("prettier-plugin-java")]);
			const code = await format(body.code, { parser: "java", plugins: [java], useTabs: true, tabWidth: 4 });
			res.json({ code });
		} catch {
			res.status(422).json({ error: "Java formatting failed" });
		}
	});

	app.post("/api/playground/run", async (req, res) => {
		if (!allowed(req) || !req.is("application/json")) {
			res.status(403).json({ error: "Forbidden" });
			return;
		}
		// The gate is the file plus the environment lock, never a client preference.
		const config = store.read();
		if (playgroundEnvLock(env) || !config.enabled) {
			res.status(403).json({ error: "Playground is disabled" });
			return;
		}
		const code = (req.body as { code?: unknown } | undefined)?.code;
		// Validate the request before reporting a capability problem: a malformed
		// body is a 400 regardless of whether this machine has a JDK.
		if (typeof code !== "string" || !code.trim() || Buffer.byteLength(code, "utf8") > MAX_SOURCE_BYTES) {
			res.status(400).json({ error: "Invalid code" });
			return;
		}
		const tests = (req.body as { tests?: PlaygroundTests }).tests;
		if (tests !== undefined) {
			try {
				if (!tests || typeof tests !== "object" || typeof tests.methodId !== "string" || !isCaseList(tests.cases) || Buffer.byteLength(JSON.stringify(tests)) > MAX_SOURCE_BYTES) throw new Error("Invalid test cases");
				const method = discoverJavaMethods(code).methods.find(m => m.id === tests.methodId);
				if (!method) throw new Error("The selected method no longer exists");
				validateCases(method, tests.cases);
			} catch (error) {
				res.status(400).json({ error: error instanceof Error ? error.message : "Invalid test cases" });
				return;
			}
		}
		const jdk = await probe.get();
		if (!jdk.available) {
			res.status(503).json({ error: jdk.reason ?? "No JDK found" });
			return;
		}
		const commands = resolveHostJdk(env);
		if (!commands) {
			res.status(503).json({ error: jdk.reason ?? "No JDK found" });
			return;
		}
		// Best-effort per-client key: it only shapes fairness, so a client that
		// omits or spoofs it simply falls back to the global limit.
		const release = gate.acquire(req.get("x-pi-client") || undefined, config.maxConcurrent, 1);
		if (!release) {
			res.status(429).json({ error: "A run is already in progress" });
			return;
		}

		res.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			// `no-transform` plus X-Accel-Buffering keeps proxies from buffering.
			"Cache-Control": "no-store, no-transform",
			"X-Accel-Buffering": "no",
			Connection: "keep-alive",
		});
		res.flushHeaders();

		const controller = new AbortController();
		// The response, not the request: `express.json()` has already consumed the
		// request stream by now, so its `close` fires before this handler runs. A
		// premature response close is the actual "client went away" signal.
		res.on("close", () => { if (!res.writableEnded) controller.abort(); });
		const send = (event: PlaygroundEvent) => {
			if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
		};

		try {
			const summary = await runJava({
				code,
				tests,
				limits: { timeoutMs: config.timeoutMs, maxOutputBytes: config.maxOutputBytes, maxHeapMb: config.maxHeapMb },
				jdk: commands,
				onEvent: send,
				signal: controller.signal,
			});
			// Never the code itself: a Run's source is the user's, not a log line.
			console.log(`[playground] run ${summary.runId} exit=${summary.exitCode} ${summary.durationMs}ms compileError=${summary.compileError} timedOut=${summary.timedOut} truncated=${summary.truncated} aborted=${summary.aborted}`);
		} catch (error) {
			send({ type: "error", message: error instanceof Error ? error.message : "Run failed" });
		} finally {
			release();
			if (!res.writableEnded) res.end();
		}
	});
}
