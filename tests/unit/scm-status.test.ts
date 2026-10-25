import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
const { spawn, killPidTree } = vi.hoisted(() => ({ spawn: vi.fn(), killPidTree: vi.fn() }));
vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(), spawn }));
vi.mock("../../server/process-utils.js", () => ({ killPidTree }));
import { scmStatus } from "../../server/scm.js";

const child = () => Object.assign(new EventEmitter(), { pid: 12345, stdout: new PassThrough(), stderr: new PassThrough() });
describe("SCM concurrent refreshes", () => {
	beforeEach(() => {
		spawn.mockReset(); killPidTree.mockReset();
		spawn.mockImplementation((_bin, args) => {
			const process = child();
			setTimeout(() => { process.stdout.emit("data", Buffer.from(args.includes("status") ? "## main\n?? new.txt\n" : "")); process.emit("close", 0); }, 10);
			return process;
		});
	});
	afterEach(() => { vi.useRealTimers(); });
	it("shares one status scan across callers, then refreshes", async () => {
		const results = await Promise.all(Array.from({ length: 8 }, () => scmStatus(process.cwd())));
		expect(spawn.mock.calls.filter(call => call[1].includes("status"))).toHaveLength(1);
		expect(results.every(result => result.files[0].path === "new.txt")).toBe(true);
		await scmStatus(process.cwd());
		expect(spawn.mock.calls.filter(call => call[1].includes("status"))).toHaveLength(2);
	});
	it("kills the entire tree on timeout and allows a later retry", async () => {
		vi.useFakeTimers();
		const children: ReturnType<typeof child>[] = [];
		spawn.mockImplementation(() => { const process = child(); children.push(process); return process; });
		const request = scmStatus(process.cwd());
		const rejected = expect(request).rejects.toThrow("超时");
		await vi.advanceTimersByTimeAsync(15000);
		expect(killPidTree).toHaveBeenCalledTimes(4);
		expect(killPidTree).toHaveBeenCalledWith(12345);
		// Do not start another scan while timed-out children are still closing.
		expect(scmStatus(process.cwd())).toBe(request);
		children.forEach(process => process.emit("close", null));
		await rejected;
		const retry = scmStatus(process.cwd());
		expect(retry).not.toBe(request);
		const retryRejected = expect(retry).rejects.toThrow();
		children.slice(4).forEach(process => process.emit("close", 1));
		await retryRejected;
	});
});
