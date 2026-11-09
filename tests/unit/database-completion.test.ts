import { describe, expect, it } from "vitest";
import { databaseCompletionRange, databaseCompletions, quoteDatabaseName } from "../../web/src/database-completion.js";

describe("database metadata completion", () => {
	it("preserves case, spaces, and escaped identifier quotes for each dialect", () => {
		expect(quoteDatabaseName('Order "Items', false)).toBe('"Order ""Items"');
		expect(quoteDatabaseName('order`items', true)).toBe('`order``items`');
		const options = databaseCompletions([{ schema: "Sales", name: "Order Items", kind: "BASE TABLE" }, { schema: "Sales", name: "Reports", kind: "VIEW" }], false);
		expect(options.filter(o => o.type === "namespace")).toHaveLength(1);
		expect(options[1].apply).toBe('"Sales"."Order Items"');
		expect(databaseCompletions([], false)).toEqual([]);
	});
	it.each(["SELECT 'public", "SELECT 'it''s", "SELECT -- public", "SELECT /* nested /* x */ public", "SELECT $$public", "SELECT $body$public"])("does not complete strings/comments: %s", sql => {
		expect(databaseCompletionRange(sql)).toBeUndefined();
	});
	it.each(['SELECT * FROM public.or', 'SELECT * FROM "public"."or', 'SELECT * FROM `public`.`or'])('replaces the complete qualified identifier: %s', sql => {
		expect(databaseCompletionRange(sql)).toEqual({ from: 14, prefix: "public.or" });
	});
	it("handles quoted spaces and closed comments before an identifier", () => {
		expect(databaseCompletionRange('SELECT * FROM "Sales Data".')).toEqual({ from: 14, prefix: "Sales Data." });
		expect(databaseCompletionRange("/* comment */ SELECT * FROM ")).toEqual({ from: 28, prefix: "" });
	});
});
