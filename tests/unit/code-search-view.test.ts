import { expect, test } from "vitest";
import { groupMatches, highlightPattern, previewWindow, splitByRanges } from "../../web/src/code-search-view.js";

const hit = (path: string, line: number) => ({ path, line, column: 1, text: "x", ranges: [] as [number, number][] });

test("groups keep file arrival order and sort lines inside a file", () => {
	const groups = groupMatches([hit("src/order/OrderService.ts", 20), hit("src/gateway/ExchangeGateway.ts", 13), hit("src/order/OrderService.ts", 14)]);
	expect(groups.map(group => [group.name, group.dir, group.matches.map(match => match.line)])).toEqual([["OrderService.ts", "src/order", [14, 20]], ["ExchangeGateway.ts", "src/gateway", [13]]]);
});

test("highlight pattern follows the toggles and reports invalid regexes", () => {
	expect(highlightPattern("a.b", { caseSensitive: false, wholeWord: false, regex: false })!.test("A.B")).toBe(true);
	expect([..."placeOrder replaceOrder".matchAll(highlightPattern("placeOrder", { caseSensitive: true, wholeWord: true, regex: false })!)].length).toBe(1);
	expect(highlightPattern("(unclosed", { caseSensitive: false, wholeWord: false, regex: true })).toBeNull();
	expect(highlightPattern("", { caseSensitive: false, wholeWord: false, regex: false })).toBeNull();
});

test("preview spans 8 lines above and 12 below, clamped to the file", () => {
	expect(previewWindow(100, 14)).toEqual({ start: 6, end: 26 });
	expect(previewWindow(10, 3)).toEqual({ start: 1, end: 10 });
});

test("ranges split text into plain and highlighted parts, merging overlaps", () => {
	expect(splitByRanges("async placeOrder(req)", [[6, 16]])).toEqual([{ text: "async ", hit: false }, { text: "placeOrder", hit: true }, { text: "(req)", hit: false }]);
	expect(splitByRanges("aaaa", [[0, 3], [1, 4], [9, 12]])).toEqual([{ text: "aaaa", hit: true }]);
	expect(splitByRanges("", [])).toEqual([{ text: "", hit: false }]);
});
