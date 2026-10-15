import type { Express, Request } from "express";
import type { OpenAIProxySettings } from "./openai-proxy.js";

export function installOpenAIProxyRoutes(app: Express, settings: OpenAIProxySettings, originAllowed: (request: Request) => boolean): void {
	app.post("/api/openai-proxy", (req, res) => {
		res.setHeader("Cache-Control", "no-store");
		if (!originAllowed(req) || !req.is("application/json")) { res.status(403).json({ error: "Forbidden" }); return; }
		try {
			if (req.body?.action === "get") res.json(settings.state());
			else if (req.body?.action === "save") res.json(settings.save(req.body.config, req.body.version));
			else res.status(400).json({ error: "Invalid proxy action" });
		} catch (error) { res.status(400).json({ error: (error as Error).message }); }
	});
}
