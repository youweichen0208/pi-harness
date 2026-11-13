import { expect, it } from "vitest";
import { boundedPlaygroundOutput } from "../../web/src/playground-chat-context.js";
it("bounds UTF-8 output without splitting emoji or silently hiding truncation", () => {
	const result = boundedPlaygroundOutput("a🐍b", 4);
	expect(result).toEqual({ text: "a", truncated: true });
	expect(boundedPlaygroundOutput("a🐍b", 6)).toEqual({ text: "a🐍b", truncated: false });
	expect(new TextEncoder().encode(boundedPlaygroundOutput("中".repeat(30000)).text).length).toBeLessThanOrEqual(65536);
});
