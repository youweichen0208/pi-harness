import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NodeWorkbench } from "../../server/node-workbench.js";
const dirs: string[] = [], services: NodeWorkbench[] = [];
afterEach(() => { services.splice(0).forEach(s => s.dispose()); vi.useRealTimers(); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "pi-node-discovery-")); dirs.push(dir);
	const path = join(dir, "config"), xshell = join(dir, "Sessions"); mkdirSync(xshell);
	writeFileSync(path, "Host alpha\n HostName localhost\n User tester\n");
	writeFileSync(join(xshell, "beta.xsh"), "[CONNECTION]\nHost=localhost\nProtocol=SSH\n[CONNECTION:AUTHENTICATION]\nUserName=tester\nMethod=0\n");
	const detect = vi.fn(async () => [{ kind: "ssh" as const, path, count: 1, groups: 1 }, { kind: "xshell" as const, path: xshell, count: 1, groups: 1 }]);
	const create = () => { const service = new NodeWorkbench(dir, undefined, detect); services.push(service); return service; };
	const state = () => JSON.parse(readFileSync(join(dir, "nodes.json"), "utf8"));
	return { dir, path, detect, create, state };
}
const discover = (s: NodeWorkbench) => s.handle("test", { type: "node_request", requestId: "discover", action: "source_detect" });
it("automatically enrolls SSH and Xshell once, syncs new hosts, and preserves pause across restart", async () => {
	const f = fixture(), service = f.create();
	await Promise.all([discover(service), discover(service)]); expect(f.detect).toHaveBeenCalledTimes(1);
	let saved = f.state(); expect(saved.sources).toHaveLength(2); expect(saved.nodes).toHaveLength(2); expect(saved.sources.every((s: any) => s.enabled)).toBe(true);
	const ssh = saved.sources.find((s: any) => s.kind === "ssh"), ids = saved.nodes.map((n: any) => n.id);
	await discover(service); expect(f.state().nodes.map((n: any) => n.id)).toEqual(ids);
	writeFileSync(f.path, "Host alpha beta\n HostName localhost\n User tester\n");
	await service.handle("test", { type: "node_request", requestId: "sync", action: "source_sync", payload: { id: ssh.id } });
	expect(f.state().nodes).toHaveLength(3);
	await service.handle("test", { type: "node_request", requestId: "pause", action: "source_toggle", payload: { id: ssh.id, enabled: false } });
	service.dispose(); const restored = f.create(); await discover(restored);
	saved = f.state(); expect(saved.sources.find((s: any) => s.id === ssh.id).enabled).toBe(false); expect(saved.nodes).toHaveLength(3);
});
it("does not broaden an existing selected SSH source or enroll after disposal", async () => {
	const f = fixture(), service = f.create();
	await service.handle("test", { type: "node_request", requestId: "add", action: "source_add", payload: { kind: "ssh", path: f.path, selectedKeys: ["alpha"], enabled: false } });
	await discover(service); expect(f.state().sources.find((s: any) => s.kind === "ssh")).toMatchObject({ enabled: false, selectedKeys: ["alpha"] });
	const before = readFileSync(join(f.dir, "nodes.json"), "utf8"); service.dispose(); await discover(service);
	expect(readFileSync(join(f.dir, "nodes.json"), "utf8")).toBe(before);
});
