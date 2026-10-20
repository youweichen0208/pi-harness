/**
 * Playground HTTP routes — the status surface for the Java code-block runner.
 *
 * Deliberately HTTP rather than a new WebSocket message: a Run is initiated by a
 * button, not by the agent, so it is request/response (plus a stream for output)
 * and the notes routes already established that a core surface can live on HTTP
 * without touching the wire protocol.
 *
 * Registered *before* the compression middleware in `index.ts`; gzip would
 * buffer the event stream.
 */

import { join } from "node:path";
import type { Express } from "express";
import type { IncomingMessage } from "node:http";
import type { PlaygroundStatus } from "./protocol.js";
import { PlaygroundConfigStore, playgroundEnvLock } from "./playground-config.js";
import { JdkProbe, createJdkProbe } from "./playground-jdk.js";

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
	const probe = options.probe ?? createJdkProbe(env);

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
}
