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
	it("requires a separate decision for every write even after a legacy remember request", async () => {
		let pending: CommandApproval[] = [];
		const approvals = new NodeCommandApprovals(value => { pending = value; });
		const signal = new AbortController().signal;
		for (const command of ["rm first", "rm second", "systemctl restart app", "systemctl stop app"]) {
			const task = approvals.request(command, signal);
			expect(pending).toHaveLength(1);
			expect(pending[0].family).toBeUndefined();
			approvals.respond(pending[0].id, true, true);
			await task;
		}
		const denied = approvals.request("rm third", signal);
		approvals.respond(pending[0].id, false);
		await expect(denied).rejects.toThrow("拒绝");
		const cancelled = approvals.request("rm fourth", signal);
		approvals.reset();
		await expect(cancelled).rejects.toThrow("拒绝");
		expect(pending).toEqual([]);
	});
	it("does not create dialogs for common Linux diagnostics", async () => {
		let pending: CommandApproval[] = [];
		const approvals = new NodeCommandApprovals(value => { pending = value; });
		for (const command of reads) await approvals.request(command, new AbortController().signal);
		expect(pending).toEqual([]);
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

const reads = [
	"  pwd\n\nls -la\n", "pwd &&\nls -la",
	"systemctl status nginx", "systemctl --no-pager show nginx -p ActiveState", "systemctl list-units --type=service --failed",
	"journalctl -u nginx -n 100 --no-pager", "journalctl -b", "journalctl -xe", "journalctl --since '1 hour ago'",
	"ss -lntup", "ip -br addr", "ip -4 route show", "ip link show dev eth0", "hostname", "hostname -I", "hostnamectl status", "timedatectl show",
	"find /var/log -type f -name '*.log' -mtime -1 -print", "find /tmp -maxdepth 2 -name '-delete'", "ls /var/log/*.log",
	"du -h /var/log | sort -hr | head -n 10", "cat /etc/hosts | sort | uniq -c", "sed -n '1,120p' /etc/hosts", "sed -n '5,$p' /etc/hosts",
	"sudo -n -u root /usr/bin/cat /etc/hosts", "sudo -- systemctl status nginx", "dmesg --ctime", "date -u", "date '+%F %T'",
	"grep '^root$' /etc/passwd", "grep 'a;b|c' /etc/hosts", "cat '/tmp/my file'", "c'at' /etc/hosts", "pwd\nls -la",
];
const writes = [
	"journalctl -n --rotate", "journalctl --lines --vacuum-time=1d", "dmesg --color --clear", "date --iso-8601 --set now",
	"systemctl restart nginx", "systemctl enable --now nginx", "systemctl daemon-reload", "systemctl status nginx --now",
	"journalctl --rotate", "journalctl --vacuum-time=1d", "journalctl --flush", "journalctl --setup-keys", "journalctl --update-catalog",
	"ss -K dst 1.2.3.4", "ss --kill", "ip link set eth0 down", "ip route del default", "ip link show -batch changes.txt",
	"hostname new-name", "hostname -F name.txt", "hostnamectl set-hostname new-name", "timedatectl set-ntp false", "date 102512002026", "date -s now", "dmesg -c", "dmesg --clear",
	"find /tmp -delete", "find /tmp -fprint out", "find /tmp -exec touch /tmp/x ;", "find /tmp -fprintf out text",
	"sort -o out in", "sort --output=out in", "sort --compress-program=sh in", "sort --out'put'=out in", "uniq in out", "uniq *", "sort *",
	"sed -i '1d' file", "sed '1w out' file", "sed -n '1,20p;w out' file", "awk 'BEGIN {system(\"touch /tmp/x\")}'",
	"sudo rm file", "sudo -s", "sudo -i cat /etc/hosts", "sudo -k cat /etc/hosts", "sudo sh -c pwd", "ls > out", "ls | sh", "cat $(id)", "cat `id`", "cat \"$X\"", "env cat /etc/hosts", "cat''custom file",
];
describe("Linux query and mutation examples", () => {
	it.each(reads)("allows %s", command => expect(commandPolicy(command).readOnly).toBe(true));
	it.each(writes)("confirms %s", command => expect(commandPolicy(command).readOnly).toBe(false));
});
