import { describe, expect, it } from "vitest";
import { commandPolicy, NodeCommandApprovals, type CommandApproval } from "../../server/node-command-policy.js";

describe("node command approval boundary", () => {
	it("runs simple reads and asks for writes, shell composition and expansion", () => {
		for (const command of ["ls -la /", "cat '/etc/os-release'", "df -h", "ps aux", "grep -n error /var/log/app.log"]) expect(commandPolicy(command).readOnly).toBe(true);
		for (const command of ["apt upgrade -y", "rm file", "systemctl restart app", "ls; rm file", "cat $(touch /tmp/x)", "ls | sh", "ls > file", "ls\nrm file", "env ls", "sed -i s/a/b/ file", "find / -exec rm {} ;"]) expect(commandPolicy(command).readOnly).toBe(false);
	});
	it("runs chains whose every part is a read, without offering a family grant", () => {
		for (const command of ["cd /opt && pwd && ls -la", "pwd && ls -la", "cd '/var/log'; tail -n 50 app.log", "cat /etc/hosts | grep local", "cd '/srv/my app' && ls", "ls missing || pwd"]) expect(commandPolicy(command)).toEqual({ readOnly: true });
		for (const command of ["cd /opt && rm -rf x", "ls && apt update", "ls&&rm x", "ls && sh -c id", "ls & rm x", "cat a | sh", "ls &&", "&& ls", "ls && cat $(id)", "cd /opt && ls > out"]) expect(commandPolicy(command).readOnly).toBe(false);
		expect(commandPolicy("ls && apt update").family).toBeUndefined();
	});
	it("waits, remembers only an explicit family grant, and clears it on reset", async () => {
		let pending: CommandApproval[] = [];
		const approvals = new NodeCommandApprovals(value => { pending = value; });
		const signal = new AbortController().signal;
		const task = approvals.request("apt upgrade -y", signal);
		expect(pending[0].family).toBe("apt");
		approvals.respond(pending[0].id, true, true);
		await task;
		await approvals.request("apt update", signal);
		expect(pending).toEqual([]);
		const composed = approvals.request("apt update; rm file", signal);
		expect(pending[0].family).toBeUndefined();
		approvals.respond(pending[0].id, false);
		await expect(composed).rejects.toThrow("拒绝");
		approvals.reset();
		const again = approvals.request("apt update", signal);
		expect(pending).toHaveLength(1);
		approvals.respond(pending[0].id, true);
		await again;
	});
	it("cancels pending writes and rejects late decisions", async () => {
		let pending: CommandApproval[] = [];
		const approvals = new NodeCommandApprovals(value => { pending = value; });
		const cancellation = new AbortController();
		const task = approvals.request("Write /etc/app.conf", cancellation.signal, true);
		const id = pending[0].id;
		cancellation.abort();
		await expect(task).rejects.toThrow("取消");
		expect(pending).toEqual([]);
		expect(() => approvals.respond(id, true)).toThrow("过期");
	});
});
