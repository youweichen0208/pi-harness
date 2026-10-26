import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { parseXshell, parseSshConfig, scanSource } from "../../server/node-sources.js";

describe("node source adapters", () => {
	it("prefers an explicit key file over a key-manager name and strips path quotes", () => {
		const node = parseXshell('[CONNECTION]\nHost=host\nProtocol=SSH\n[CONNECTION:AUTHENTICATION]\nUserName=root\nMethod=1\nUserKey=key-name\nPrivateKey="D:\\keys\\id_ed25519"', "host.xsh");
		expect(node.keyPath).toBe('D:\\keys\\id_ed25519');
	});
	it("imports Xshell metadata without carrying password ciphertext", () => {
		const node = parseXshell("[CONNECTION]\r\nHost=10.0.0.1\r\nPort=2222\r\nProtocol=SSH\r\n[CONNECTION:AUTHENTICATION]\r\nUserName=deploy\r\nMethod=0\r\nPassword=NEVER_IMPORT\r\n", "prod/api.xsh");
		expect(node).toMatchObject({ host: "10.0.0.1", port: 2222, username: "deploy", name: "api", group: "prod", auth: "password", unsupported: [] });
		expect(JSON.stringify(node)).not.toContain("NEVER_IMPORT");
	});
	it("blocks proxies, non-SSH sessions and unknown authentication", () => {
		expect(parseXshell("[CONNECTION]\nHost=host\nProtocol=TELNET\nProxy=jump\n[CONNECTION:AUTHENTICATION]\nMethod=4", "host.xsh").unsupported).toEqual(expect.arrayContaining(["protocol", "proxy", "authentication"]));
	});
	it("merges SSH wildcard defaults in first-value order and blocks executable directives", () => {
		const nodes = parseSshConfig('Host api other\n HostName 10.0.0.2\n User deploy\n Port 2222\n IdentityFile "~/.ssh/id_ed25519"\nHost * !other\n User fallback\n ProxyCommand nc proxy 22\n');
		expect(nodes).toHaveLength(2);
		expect(nodes[0]).toMatchObject({ name: "api", host: "10.0.0.2", username: "deploy", port: 2222, keyPath: "~/.ssh/id_ed25519", unsupported: ["proxycommand"] });
		expect(nodes[1].unsupported).toEqual([]);
	});
	it("does not execute or silently approximate Include and Match", () => {
		expect(parseSshConfig("Include hosts/*\nHost api\n Match exec bad-command\n User root")[0].unsupported).toEqual(["include", "match"]);
	});
});

it("resolves session-relative key files without reading private key material", async () => {
	const root = mkdtempSync(join(tmpdir(), "xshell-path-"));
	try {
		mkdirSync(join(root, "prod"));
		writeFileSync(join(root, "prod", "host.xsh"), '[CONNECTION]\nHost=host\nProtocol=SSH\n[CONNECTION:AUTHENTICATION]\nUserName=root\nMethod=1\nUserKey="../keys/id_ed25519"');
		const [node] = await scanSource({ kind: "xshell", path: root });
		expect(node.keyPath).toBe(join(root, "keys", "id_ed25519"));
		expect(node.unsupported).toEqual([]);
	} finally { rmSync(root, { recursive: true, force: true }); }
});


it("keeps missing usernames importable without exposing credential material", () => {
	const node = parseXshell("[SESSIONINFO]\nVersion=7.0\n[CONNECTION]\nHost=host\nProtocol=SSH\n[CONNECTION:AUTHENTICATION]\nMethod=0\nPassword=SECRET", "node.xsh");
	expect(node).toMatchObject({ username: "", sourceCredential: true, xshellVersion: "7.0", unsupported: [] });
	expect(JSON.stringify(node)).not.toContain("SECRET");
});
