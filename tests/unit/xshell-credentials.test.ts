import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decryptXshell7, XshellCredentials } from "../../server/xshell-credentials.js";
import { scanSource } from "../../server/node-sources.js";
import type { NodeProfile, NodeSource } from "../../server/protocol.js";

const fixture: { identity: { username: string; sid: string }; vectors: { plaintext: string; masterPassword?: string; ciphertext: string }[] } = JSON.parse(readFileSync(new URL("../fixtures/xshell7-credentials.json", import.meta.url), "utf8"));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function setup(master = false) {
	const root = mkdtempSync(join(tmpdir(), "xshell-credentials-")); roots.push(root);
	const path = join(root, "Xshell", "Sessions"); mkdirSync(path, { recursive: true });
	const source: NodeSource = { id: "source", kind: "xshell", path, enabled: true, count: 1, groups: 1 };
	const file = join(path, "node.xsh");
	const text = `[SESSIONINFO]\nVersion=7.0\n[CONNECTION]\nHost=example.invalid\nProtocol=SSH\n[CONNECTION:AUTHENTICATION]\nUserName=tester\nMethod=0\nPassword=${fixture.vectors[master ? 2 : 0].ciphertext}`;
	writeFileSync(file, text);
	if (master) { mkdirSync(join(root, "Common")); writeFileSync(join(root, "Common", "MasterPassword.mpw"), "[MasterPassword]\nEnblMasterPasswd=1"); }
	const node: NodeProfile = { ...(await scanSource(source))[0], id: "node", sourceId: source.id };
	return { root, source, file, text, node };
}

describe("Xshell 7 credential decoding", () => {
	it("matches independent OpenSSL vectors, including whitespace, Unicode and empty passwords", () => {
		for (const vector of fixture.vectors) expect(decryptXshell7(vector.ciphertext, fixture.identity, vector.masterPassword)).toBe(vector.plaintext);
	});
	it("matches the published master-password reference vector", () => {
		expect(decryptXshell7("Rrm3P3AL0iDV7nBbS2bHvh7ZAvuN1NSJl8ZFL11+UJ+82+KAixa89O3OTAfRTg==", fixture.identity, "123123")).toBe("This is a test");
	});
	it("rejects wrong identity, master password, truncated data and checksum corruption", () => {
		const encoded = fixture.vectors[0].ciphertext;
		expect(decryptXshell7(encoded, { ...fixture.identity, username: "other" })).toBeUndefined();
		expect(decryptXshell7(encoded, fixture.identity, "wrong")).toBeUndefined();
		for (const bad of ["", "!!!!", "AAAA", encoded.slice(1), "A".repeat(20004)]) expect(decryptXshell7(bad, fixture.identity)).toBeUndefined();
		const bytes = Buffer.from(encoded, "base64"); bytes[bytes.length - 1] ^= 1;
		expect(decryptXshell7(bytes.toString("base64"), fixture.identity)).toBeUndefined();
	});
	it("reads fresh credentials without putting ciphertext in node metadata", async () => {
		const { source, node, file, text } = await setup();
		const reader = new XshellCredentials(async () => fixture.identity);
		expect(await reader.read("a", source, node)).toBe("secret123");
		writeFileSync(file, text.replace(fixture.vectors[0].ciphertext, fixture.vectors[1].ciphertext));
		expect(await reader.read("a", source, node)).toBe(fixture.vectors[1].plaintext);
		expect(JSON.stringify(node)).not.toContain(fixture.vectors[0].ciphertext);
		writeFileSync(file, text.replace("Host=example.invalid", "Host=changed.invalid"));
		await expect(reader.read("a", source, node)).rejects.toThrow("来源配置已变化");
	});
	it("rejects a newly added proxy before sending credentials to the old direct endpoint", async () => {
		const { source, node, file, text } = await setup();
		writeFileSync(file, text.replace("Protocol=SSH", "Protocol=SSH\nProxy=jump"));
		await expect(new XshellCredentials(async () => fixture.identity).read("a", source, node)).rejects.toThrow("来源配置已变化");
	});
	it("does not finish a credential read after the owning service has been disposed", async () => {
		const { source, node } = await setup();
		let release!: (identity: typeof fixture.identity) => void;
		let started!: () => void;
		const waiting = new Promise<void>(resolve => { started = resolve; });
		const reader = new XshellCredentials(() => { started(); return new Promise(resolve => { release = resolve; }); });
		const pending = reader.read("a", source, node);
		await waiting;
		reader.clear(); release(fixture.identity);
		await expect(pending).rejects.toThrow("认证请求已取消");
	});
	it("isolates master unlocks by client and source, rejects wrong unlock and clears on shutdown", async () => {
		const { source, node } = await setup(true);
		const reader = new XshellCredentials(async () => { throw new Error("master unlock must not require OS identity"); });
		await expect(reader.read("a", source, node)).rejects.toMatchObject({ reason: "locked" });
		await expect(reader.read("a", source, node, "wrong")).rejects.toMatchObject({ reason: "locked" });
		expect(await reader.read("a", source, node, "master-fixture")).toBe("secret123");
		expect(await reader.read("a", source, node)).toBe("secret123");
		await expect(reader.read("b", source, node)).rejects.toMatchObject({ reason: "locked" });
		await expect(reader.read("a", { ...source, id: "other" }, node)).rejects.toMatchObject({ reason: "locked" });
		reader.clear();
		await expect(reader.read("a", source, node)).rejects.toMatchObject({ reason: "locked" });
	});
	it("supports saved private-key passphrases and rejects unsupported session versions", async () => {
		const { source, file, text } = await setup(true);
		writeFileSync(file, text.replace("Method=0", "Method=1\nPrivateKey=/test/key").replace("Password=", "Passphrase=").replace(fixture.vectors[2].ciphertext, fixture.vectors[3].ciphertext));
		const node = { ...(await scanSource(source))[0], id: "node" };
		const reader = new XshellCredentials(async () => fixture.identity);
		expect(await reader.read("a", source, node, "master-fixture")).toBe("key-passphrase");
		writeFileSync(file, text.replace("Version=7.0", "Version=8.0"));
		await expect(reader.read("a", source, { ...node, auth: "password", keyPath: undefined })).rejects.toMatchObject({ reason: "unavailable" });
	});
	it("uses the Windows identity again after the user disables the Xshell master password", async () => {
		const { root, source, node, file, text } = await setup(true);
		const reader = new XshellCredentials(async () => fixture.identity);
		await reader.read("a", source, node, "master-fixture");
		writeFileSync(join(root, "Common", "MasterPassword.mpw"), "[MasterPassword]\nEnblMasterPasswd=0");
		writeFileSync(file, text.replace(fixture.vectors[2].ciphertext, fixture.vectors[0].ciphertext));
		expect(await reader.read("a", source, node)).toBe("secret123");
	});
	it("rejects traversal and symlink escapes from the registered source", async () => {
		const { root, source, node, text } = await setup();
		writeFileSync(join(root, "outside.xsh"), text);
		const reader = new XshellCredentials(async () => fixture.identity);
		await expect(reader.read("a", source, { ...node, sourceKey: "../../outside.xsh" })).rejects.toMatchObject({ reason: "unavailable" });
		if (process.platform !== "win32") {
			symlinkSync(join(root, "outside.xsh"), join(source.path, "link.xsh"));
			await expect(reader.read("a", source, { ...node, sourceKey: "link.xsh" })).rejects.toMatchObject({ reason: "unavailable" });
		}
	});
});
