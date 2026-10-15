import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isOpenAIOrigin, OpenAIProxySettings, validateOpenAIProxy } from "../../server/openai-proxy.js";

describe("OpenAI proxy", () => {
	it("only routes official TLS endpoints, not callbacks or lookalike hosts", () => {
		for (const origin of ["https://auth.openai.com", "https://api.openai.com:443", "wss://chatgpt.com"]) expect(isOpenAIOrigin(origin)).toBe(true);
		for (const origin of ["https://api.openai.com.evil.test", "https://evil.test/api.openai.com", "http://api.openai.com", "https://api.openai.com:444", "http://127.0.0.1:1455", "https://api.anthropic.com", "https://custom.test", "invalid"]) expect(isOpenAIOrigin(origin)).toBe(false);
	});
	it("accepts user-chosen HTTP(S) ports and rejects credentials and unsupported URLs", () => {
		expect(validateOpenAIProxy({ enabled: true, url: " http://127.0.0.1:12345/ " })).toEqual({ enabled: true, url: "http://127.0.0.1:12345" });
		expect(validateOpenAIProxy({ enabled: true, url: "https://[::1]:6789" }).url).toBe("https://[::1]:6789");
		for (const url of ["", "127.0.0.1:10809", "socks5://localhost:10808", "http://user:secret@localhost:1234", "http://localhost/path", "http://localhost/?key=secret"]) expect(() => validateOpenAIProxy({ enabled: true, url })).toThrow();
	});
	it("persists per installation, requires restart and rejects stale saves", () => {
		const directory = mkdtempSync(join(tmpdir(), "openai-proxy-"));
		try {
			const settings = new OpenAIProxySettings(directory), initial = settings.state();
			expect(initial.enabled).toBe(false);
			const saved = settings.save({ enabled: true, url: "http://localhost:12345" }, initial.version);
			expect(saved.restartRequired).toBe(true);
			expect(() => settings.save({ enabled: false, url: "" }, initial.version)).toThrow(/changed/);
			const restarted = new OpenAIProxySettings(directory);
			expect(restarted.state()).toEqual({ ...saved, restartRequired: false });
			expect(restarted.save({ enabled: false, url: "" }, saved.version).restartRequired).toBe(true);
			expect(new OpenAIProxySettings(directory).state().enabled).toBe(false);
		} finally { rmSync(directory, { recursive: true, force: true }); }
	});
});
