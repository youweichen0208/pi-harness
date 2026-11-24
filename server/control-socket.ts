/**
 * Local control socket for the pi-harness server.
 *
 * Lets the CLI (and humans) query status and quiesce/unquiesce the server
 * WITHOUT opening a network port or exposing an unauthenticated HTTP
 * endpoint. Only the local OS user can reach it:
 *   - POSIX: a mode-0600 Unix domain socket at <dataDir>/pi-harness.sock
 *   - Windows: a named pipe  \\.\pipe\pi-harness-<port>
 *
 * Protocol: one JSON object per line.
 *   → {"cmd":"status"}        ← {"ok":true, ...serviceStatus}
 *   → {"cmd":"quiesce"}       ← {"ok":true}
 *   → {"cmd":"unquiesce"}     ← {"ok":true}
 *   → anything else           ← {"ok":false,"error":"..."}
 *
 * Idle connections are closed after a short timeout so a stuck CLI never
 * holds the socket.
 */
import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AgentService } from "./agent-service.js";

/** How long a control connection may sit idle before the server closes it. */
const CONTROL_IDLE_TIMEOUT_MS = 5_000;

/** Socket path (POSIX) or pipe name (Windows). */
function controlPath(dataDir: string, port: number): string {
	return process.platform === "win32"
		? `\\\\.\\pipe\\pi-harness-${port}`
		: join(dataDir, "pi-harness.sock");
}

export interface ControlCommand {
	cmd: "status" | "quiesce" | "unquiesce";
}

export interface ControlStatus {
	ok: boolean;
	error?: string;
	/** serviceStatus fields, present on "status". */
	pid?: number;
	version?: string;
	cwd?: string;
	quiesced?: boolean;
	quiescedSince?: number;
	connectedClients?: number;
	/** Client sessions kept alive in memory (sockets attached or not). */
	clientSessions?: number;
	activeConversations?: number;
	pendingMessages?: number;
}

/** Start the control socket; returns a stop function. */
export function startControlServer(opts: {
	service: AgentService;
	additionalActiveConversations?: () => number;
	dataDir: string;
	port: number;
}): () => void {
	const { service, dataDir, port } = opts;
	const path = controlPath(dataDir, port);
	let server: Server;

	if (process.platform === "win32") {
		server = createServer(handleConnection);
	} else {
		// Remove a stale socket left by a previous crash (only if it's ours —
		// an existing socket file that refuses connections is stale).
		if (existsSync(path)) {
			try {
				rmSync(path);
			} catch {
				/* best-effort */
			}
		}
		server = createServer(handleConnection);
	}
	// A second instance on the same data dir / port would fail to bind — don't
	// crash the server over it, just log and run without a control socket.
	server.on("error", (err: NodeJS.ErrnoException) => {
		if (err.code === "EADDRINUSE") {
			console.warn(
				`[control] socket ${path} already in use — control socket disabled`,
			);
		} else {
			console.warn(`[control] socket error: ${err.message}`);
		}
	});

	function handleConnection(sock: Socket): void {
		let buf = "";
		const timer = setTimeout(() => {
			sock.destroy();
		}, CONTROL_IDLE_TIMEOUT_MS);
		sock.on("data", (chunk) => {
			buf += chunk.toString("utf8");
			let nl: number;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (!line) continue;
				timer.refresh();
				let req: ControlCommand;
				try {
					req = JSON.parse(line) as ControlCommand;
				} catch {
					sock.write(JSON.stringify({ ok: false, error: "bad json" }) + "\n");
					continue;
				}
				let resp: ControlStatus;
				switch (req.cmd) {
					case "status":
						resp = { ok: true, ...service.serviceStatus() };
						resp.activeConversations = (resp.activeConversations ?? 0) + (opts.additionalActiveConversations?.() ?? 0);
						break;
					case "quiesce":
						service.quiesce();
						resp = { ok: true };
						break;
					case "unquiesce":
						service.unquiesce();
						resp = { ok: true };
						break;
					default:
						resp = { ok: false, error: `unknown cmd: ${String((req as { cmd?: unknown }).cmd)}` };
						break;
				}
				sock.write(JSON.stringify(resp) + "\n");
			}
		});
		sock.on("error", () => {
			/* client vanished */
		});
		sock.on("close", () => clearTimeout(timer));
	}

	if (process.platform === "win32") {
		// net.Server on a named pipe: listen on the pipe name directly.
		server.listen(path, () => {
			console.log(`  control    : ${path}`);
		});
	} else {
		server.listen(path, () => {
			try {
				chmodSync(path, 0o600);
			} catch {
				/* best-effort */
			}
			console.log(`  control    : ${path}`);
		});
	}

	return () => {
		server.close();
		try {
			if (process.platform !== "win32" && existsSync(path)) rmSync(path);
		} catch {
			/* best-effort */
		}
	};
}
