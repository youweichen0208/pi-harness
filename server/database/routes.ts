import type { Express, Request } from "express";
import type { AgentService } from "../agent-service.js";
import type { DatabaseRequest } from "../protocol.js";
import { databaseAction, databaseScope } from "./service.js";
export function installDatabaseRoutes(app: Express, service: () => AgentService, originAllowed: (req: Request) => boolean) {
	app.post("/api/database", async (req, res) => {
		res.setHeader("Cache-Control", "no-store");
		if (!originAllowed(req) || !req.is("application/json")) { res.sendStatus(403); return; }
		const body = req.body as DatabaseRequest;
		const cs = typeof body?.clientId === "string" ? service().get(body.clientId) : undefined;
		const valid = () => cs && cs.cwd === body.cwd && cs.conversationId === body.conversationId && !cs.switchingWorkspace && !service().quiesceInfo().quiesced;
		if (!valid() || !cs || typeof body.requestId !== "string" || body.requestId.length > 100) { res.status(409).json({ error: "Conversation unavailable" }); return; }
		const controller = new AbortController();
		res.on("close", () => { if (!res.writableEnded) controller.abort(); });
		try {
			const scope = databaseScope(body.clientId, body.cwd, cs.session.sessionManager);
			const result = await databaseAction(scope, body.cwd, body.requestId, body, controller.signal);
			if (!valid() || scope !== databaseScope(body.clientId, body.cwd, cs.session.sessionManager)) throw Error("Conversation changed");
			res.json(result);
		} catch (error) { if (!controller.signal.aborted) res.status(400).json({ requestId: body.requestId, error: (error as Error).message }); }
	});
}
