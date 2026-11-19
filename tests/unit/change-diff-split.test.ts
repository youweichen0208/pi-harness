import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";


vi.mock("../../web/src/i18n", () => ({ useT: () => (key: string) => key }));

describe("unified diff", () => {
	it("renders each line once without an original pane or word marks", async () => {
		// The pure-test tsconfig excludes JSX; Vite compiles this component fixture.
		const componentPath = "../../web/src/components/ChangeDiff.tsx";
		const { ChangeDiff } = await import(componentPath);
		const html = renderToStaticMarkup(createElement(ChangeDiff, {
			file: { path: "a.ts", added: 2, removed: 1, counted: true, lines: [
				{ marker: " ", oldLine: 8, newLine: 9, text: "unchanged" },
				{ marker: "-", oldLine: 9, text: "old" },
				{ marker: "+", newLine: 10, text: "new" },
				{ marker: "+", newLine: 11, text: "extra" },
			] }, gaps: new Set<string>(), expandGap: () => {},
		}));
		expect(html).not.toContain("diff-pair");
		expect(html).not.toContain("diff-placeholder");
		expect(html).not.toContain("data-diff-side");
		expect(html).toContain('changes-line-number">9<');
		expect(html).toContain('changes-line-number">11<');
		expect(html).toContain("extra");
		expect(html).not.toContain("<mark");
		expect(html).not.toContain("changes-line-sign");
		expect([...html.matchAll(/class="changes-line ([^"]+)"/g)].map(cell => cell[1])).toEqual(["context", "del", "add", "add"]);
	});
});
