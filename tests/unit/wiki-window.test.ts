import { describe, expect, it } from "vitest";
import { buildWikiWindowUrl, parseWikiWindowParams } from "../../web/src/wiki-window.js";

describe("wiki window url", () => {
	it("round-trips cwd, doc and the window client id", () => {
		const url = buildWikiWindowUrl("/Users/me/project", "docs/guide.md", "c-1");
		const parsed = parseWikiWindowParams(url.slice(url.indexOf("?")));
		expect(parsed).toEqual({ wikiWindow: true, cwd: "/Users/me/project", doc: "docs/guide.md", client: "c-1", model: null, thinking: null });
	});

	it("omits doc when null", () => {
		const parsed = parseWikiWindowParams(buildWikiWindowUrl("/tmp/ws", null, "c-2").slice(1));
		expect(parsed).toEqual({ wikiWindow: true, cwd: "/tmp/ws", doc: null, client: "c-2", model: null, thinking: null });
	});

	it("round-trips the opener model and thinking level", () => {
		const url = buildWikiWindowUrl("/tmp/ws", "note.md", "c-4", { model: "glm", thinking: "high" });
		const parsed = parseWikiWindowParams(url.slice(url.indexOf("?")));
		expect(parsed).toEqual({ wikiWindow: true, cwd: "/tmp/ws", doc: "note.md", client: "c-4", model: "glm", thinking: "high" });
	});

	it("client stays optional for manually opened URLs", () => {
		const parsed = parseWikiWindowParams("?wiki-window=1&cwd=/tmp/ws");
		expect(parsed.client).toBeNull();
	});

	it("encodes spaces, hashes and unicode", () => {
		const parsed = parseWikiWindowParams(buildWikiWindowUrl("/tmp/my project", "笔记/设计 #1.md", "c-3").slice(1));
		expect(parsed.cwd).toBe("/tmp/my project");
		expect(parsed.doc).toBe("笔记/设计 #1.md");
	});

	it("rejects non-wiki urls and garbage", () => {
		expect(parseWikiWindowParams("").wikiWindow).toBe(false);
		expect(parseWikiWindowParams("?cwd=/tmp/ws").wikiWindow).toBe(false);
		expect(parseWikiWindowParams("?wiki-window=0&cwd=/tmp").wikiWindow).toBe(false);
	});
});
