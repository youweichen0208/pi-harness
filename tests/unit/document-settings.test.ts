import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDocumentSettings, getDocumentSettingsState, updateDocumentSettings } from "../../server/document-extension-settings.js";

const folders: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
function settingsFile() {
	const folder = mkdtempSync(join(tmpdir(), "document-settings-"));
	folders.push(folder); vi.stubEnv("PI_WEB_DATA_DIR", folder);
	return join(folder, "document-extensions.json");
}
describe("document extension settings", () => {
	it("rejects stale browser versions including whitespace-only and missing-file changes", () => {
		const file = settingsFile();
		const missing = getDocumentSettingsState();
		expect(missing.settings).toEqual({ databaseEnabled: true });
		writeFileSync(file, JSON.stringify({ databaseEnabled: true, future: { secret: "keep-private" } }));
		expect(() => updateDocumentSettings({ databaseEnabled: false }, missing.version)).toThrow(/changed/);
		const loaded = getDocumentSettingsState();
		expect(JSON.stringify(loaded)).not.toContain("keep-private");
		updateDocumentSettings({ databaseEnabled: false }, loaded.version);
		expect(() => updateDocumentSettings({ databaseEnabled: true }, loaded.version)).toThrow(/changed/);
		const disabled = getDocumentSettingsState();
		expect(disabled.settings.databaseEnabled).toBe(false);
		const raw = readFileSync(file, "utf8"); writeFileSync(file, `${raw}\n`);
		expect(() => updateDocumentSettings({ databaseEnabled: true }, disabled.version)).toThrow(/changed/);
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ databaseEnabled: false, future: { secret: "keep-private" } });
	});
	it("defaults to lazy enabled and observes external disables while retaining other settings", () => {
		const file = settingsFile();
		expect(getDocumentSettings()).toEqual({ databaseEnabled: true });
		writeFileSync(file, JSON.stringify({ pdfEnabled: false, okfEnabled: true, futureOption: "keep" }));
		expect(getDocumentSettings().databaseEnabled).toBe(true);
		updateDocumentSettings({ databaseEnabled: false });
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ databaseEnabled: false, futureOption: "keep" });
	});
	it("does not enable features or replace configuration when a saved file is invalid", () => {
		const file = settingsFile();
		writeFileSync(file, "broken");
		expect(() => getDocumentSettings()).toThrow(/document-extensions/);
		expect(() => updateDocumentSettings({ databaseEnabled: true })).toThrow();
		expect(readFileSync(file, "utf8")).toBe("broken");
		writeFileSync(file, JSON.stringify({ databaseEnabled: "invalid" }));
		expect(() => getDocumentSettings()).toThrow(/boolean/);
	});
});
