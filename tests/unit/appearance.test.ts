import { describe, expect, it } from "vitest";
import { lightThemeOf, readAppearanceState, resolveAppearance } from "../../web/src/appearance-model.js";

const storage = (values: Record<string, string>) => ({ getItem: (key: string) => values[key] ?? null });

describe("resolveAppearance", () => {
	it("uses the chosen theme when not following the system", () => {
		expect(resolveAppearance({ theme: "mist", follow: false }, true)).toBe("mist");
		expect(resolveAppearance({ theme: "graphite", follow: false }, false)).toBe("graphite");
	});
	it("follows the system: graphite when dark, the light theme otherwise", () => {
		expect(resolveAppearance({ theme: "sage", follow: true }, true)).toBe("graphite");
		expect(resolveAppearance({ theme: "sage", follow: true }, false)).toBe("sage");
	});
	it("falls back to warm when following a light system from graphite", () => {
		expect(lightThemeOf("graphite")).toBe("warm");
		expect(resolveAppearance({ theme: "graphite", follow: true }, false)).toBe("warm");
	});
});

describe("readAppearanceState", () => {
	it("defaults to warm, not following", () => {
		expect(readAppearanceState(storage({}))).toEqual({ theme: "warm", follow: false });
	});
	it("reads the stored theme and follow flag", () => {
		expect(readAppearanceState(storage({ "pi-harness:theme": "oat", "pi-harness:theme-follow": "1" }))).toEqual({ theme: "oat", follow: true });
	});
	it("migrates the legacy light/dark/system value", () => {
		expect(readAppearanceState(storage({ "pi-harness:appearance": "dark" }))).toEqual({ theme: "graphite", follow: false });
		expect(readAppearanceState(storage({ "pi-harness:appearance": "system" }))).toEqual({ theme: "warm", follow: true });
	});
	it("ignores an unknown stored theme", () => {
		expect(readAppearanceState(storage({ "pi-harness:theme": "neon" })).theme).toBe("warm");
	});
});
