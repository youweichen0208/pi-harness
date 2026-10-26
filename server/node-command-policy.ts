import { randomUUID } from "node:crypto";

const READ_ONLY = new Set(["cd", "ls", "cat", "df", "ps", "grep", "pwd", "head", "tail", "wc", "uname", "whoami", "id", "uptime", "free", "stat", "du", "readlink", "realpath", "basename", "dirname", "lsblk", "lscpu", "lsusb", "lspci", "nproc", "getent", "cut", "tr"]);
type Word = { value: string; glob: boolean };

/** A deliberately bounded shell grammar: quotes and read-only chains, no execution
 * expansion, redirection, assignments, background jobs or shell interpreters. */
function parse(command: string): Word[][] | undefined {
	if (!command.trim() || /[\x00-\x08\x0b-\x1f\x7f]/.test(command)) return;
	command = command.trim();
	const parts: Word[][] = [[]];
	let value = "", started = false, glob = false, quote = "";
	const word = () => { if (started) parts.at(-1)!.push({ value, glob }); value = ""; started = false; glob = false; };
	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		if (quote) {
			if (c === quote) quote = "";
			else { if (quote === '"' && /[$`\\]/.test(c)) return; value += c; }
		} else if (c === "'" || c === '"') { quote = c; started = true; }
		else if (c === " " || c === "\t") word();
		else if (c === "\n" || c === ";" || c === "|" || c === "&") {
			word();
			if (c === "\n" && !parts.at(-1)!.length) continue;
			if (c === "&" && command[i + 1] !== "&") return;
			if ((c === "&" || c === "|") && command[i + 1] === c) i++;
			parts.push([]);
		} else {
			if (/[$`\\<>(){}~]/.test(c)) return;
			started = true; value += c; glob ||= /[*?\[]/.test(c);
		}
	}
	if (quote) return;
	word();
	return parts.every(part => part.length) ? parts : undefined;
}

/** Exact option names only; ':' means one argument. Unknown options ask first. */
function operands(args: string[], specification: string): string[] | undefined {
	const specs = new Map(specification.split(" ").filter(Boolean).map(s => [s.replace(/:$/, ""), s.endsWith(":")]));
	const result: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") return [...result, ...args.slice(i + 1)];
		if (arg === "-" || !arg.startsWith("-")) { result.push(arg); continue; }
		if (arg.startsWith("--")) {
			const at = arg.indexOf("="), name = at < 0 ? arg : arg.slice(0, at);
			if (!specs.has(name) || at >= 0 && !specs.get(name)) return;
			if (specs.get(name) && at < 0 && (++i >= args.length || args[i].startsWith("-"))) return;
		} else {
			for (let j = 1; j < arg.length; j++) {
				const name = `-${arg[j]}`;
				if (!specs.has(name)) return;
				if (specs.get(name)) { if (j === arg.length - 1 && (++i >= args.length || args[i].startsWith("-"))) return; break; }
			}
		}
	}
	return result;
}

function invocation(words: Word[], wrapped = false): boolean {
	const executable = words[0].value.replace(/^\/(?:usr\/)?s?bin\//, "");
	if (words[0].glob || !/^[a-z][a-z0-9_-]*$/.test(executable)) return false;
	const args = words.slice(1).map(word => word.value);
	if (READ_ONLY.has(executable)) return true;
	// Multipurpose tools need literal arguments: a glob could introduce write flags.
	if (words.some(word => word.glob)) return false;
	if (executable === "sudo" && !wrapped) {
		let i = 1;
		while (i < words.length && words[i].value.startsWith("-")) {
			const option = words[i++].value;
			if (option === "--") break;
			if (option === "-n") continue;
			if ((option === "-u" || option === "-g") && i < words.length) { i++; continue; }
			return false;
		}
		return i < words.length && invocation(words.slice(i), true);
	}
	if (executable === "systemctl") {
		const rest = operands(args, "--no-pager --no-legend --plain --all -a --full -l --failed --user --system --quiet -q --type: -t: --state: --property: -p: --value --lines: -n:");
		return !!rest?.length && new Set(["status", "show", "cat", "list-units", "list-unit-files", "list-timers", "list-sockets", "list-dependencies", "is-active", "is-enabled", "is-failed", "is-system-running"]).has(rest[0]);
	}
	if (executable === "journalctl") return operands(args.map((arg, i) => (arg === "-b" || arg === "--boot") && (!args[i + 1] || args[i + 1].startsWith("-")) ? "--boot=0" : arg), "--pager-end -e --no-pager --no-hostname --quiet -q --all -a --full -l --follow -f --reverse -r --kernel -k --user --system --disk-usage --list-boots --utc --catalog -x --unit: -u: --user-unit: --lines: -n: --since: -S: --until: -U: --priority: -p: --output: -o: --identifier: -t: --grep: -g: --file: --directory: -D: --boot: -b:") !== undefined;
	if (executable === "ss") return operands(args, "-a -l -n -p -t -u -x -w -s -e -i -m -o -r -4 -6 -H -O --all --listening --numeric --processes --tcp --udp --unix --summary --extended --info --memory --oneline --no-header") !== undefined;
	if (executable === "ip") {
		const rest = operands(args.map(arg => arg === "-br" ? "--brief" : arg), "-4 -6 -s -d -j -p -o --brief --json --pretty --oneline");
		return !!rest && ["address", "addr", "a", "link", "route", "r", "neigh", "neighbor", "rule"].includes(rest[0]) && (rest.length === 1 || ["show", "list", "lst"].includes(rest[1]));
	}
	if (executable === "dmesg") return operands(args, "-H -L -r -T -w -x --human --raw --ctime --follow --decode --color: --level: --facility: --since: --until: --time-format:") !== undefined;
	if (executable === "date") { const rest = operands(args, "-u -R --utc --universal --rfc-email -d: --date: -r: --reference: --iso-8601:"); return !!rest && (rest.length === 0 || rest.length === 1 && rest[0].startsWith("+")); }
	if (executable === "hostnamectl" || executable === "timedatectl") {
		const rest = operands(args, "--no-pager --all -a --property: -p: --value");
		return !!rest && (rest.length === 0 || rest.length === 1 && ["status", "show"].includes(rest[0]));
	}
	if (executable === "hostname") return args.length === 0 || args.every(arg => ["-s", "-f", "-d", "-i", "-I", "--short", "--fqdn", "--domain", "--ip-address", "--all-ip-addresses"].includes(arg));
	if (executable === "find") {
		const unary = new Set(["-name", "-iname", "-path", "-ipath", "-type", "-size", "-mtime", "-mmin", "-atime", "-ctime", "-user", "-group", "-uid", "-gid", "-perm", "-maxdepth", "-mindepth", "-newer", "-printf"]);
		const flags = new Set(["-H", "-L", "-P", "-print", "-print0", "-ls", "-empty", "-readable", "-writable", "-executable", "-true", "-false", "-a", "-and", "-o", "-or", "!", "-not", "(", ")", "-prune", "-quit", "-xdev", "-mount", "-depth", "-ignore_readdir_race"]);
		let expression = false;
		for (let i = 0; i < args.length; i++) {
			const arg = args[i];
			if (flags.has(arg)) { if (!["-H", "-L", "-P"].includes(arg)) expression = true; continue; }
			if (unary.has(arg)) { expression = true; if (++i >= args.length) return false; continue; }
			if (expression || arg.startsWith("-")) return false;
		}
		return true;
	}
	if (executable === "sort") return operands(args, "-b -d -f -g -h -i -M -n -r -s -u -V -z -c -C -k: -t: --key: --field-separator: --ignore-leading-blanks --dictionary-order --ignore-case --general-numeric-sort --human-numeric-sort --ignore-nonprinting --month-sort --numeric-sort --reverse --stable --unique --version-sort --zero-terminated --check") !== undefined;
	if (executable === "uniq") { const rest = operands(args, "-c -d -D -i -u -z -f: -s: -w: --count --repeated --ignore-case --unique --zero-terminated --skip-fields: --skip-chars: --check-chars:"); return !!rest && rest.length <= 1; }
	if (executable === "sed") {
		const rest = operands(args, "-n --quiet --silent");
		return !!rest?.length && /^(?:[0-9]+|\$)?(?:,(?:[0-9]+|\$))?[pd]$/.test(rest[0]);
	}
	return false;
}

export function commandPolicy(command: string): { readOnly: boolean; family?: string } {
	const parts = parse(command);
	return { readOnly: !!parts && parts.every(part => invocation(part)) };
}

export interface CommandApproval {
	id: string;
	command: string;
	family?: string;
}

/** Each state-changing or unclassified operation needs its own decision. */
export class NodeCommandApprovals {
	private pending = new Map<string, { approval: CommandApproval; finish: (allow: boolean) => void }>();
	constructor(private readonly changed: (pending: CommandApproval[]) => void) {}
	private emit() { this.changed([...this.pending.values()].map(item => item.approval)); }
	async request(command: string, signal: AbortSignal, write = false): Promise<void> {
		signal.throwIfAborted();
		const policy = write ? { readOnly: false, family: undefined } : commandPolicy(command);
		if (policy.readOnly) return;
		await new Promise<void>((resolve, reject) => {
			const id = randomUUID();
			const abort = () => finish(false);
			const finish = (allow: boolean) => {
				signal.removeEventListener("abort", abort);
				this.pending.delete(id);
				// Legacy remember requests never authorize subsequent operations.
				this.emit();
				if (allow && !signal.aborted) resolve(); else reject(new Error(signal.aborted ? "节点操作已取消" : "用户拒绝执行节点操作"));
			};
			this.pending.set(id, { approval: { id, command }, finish });
			signal.addEventListener("abort", abort, { once: true });
			this.emit();
		});
	}
	respond(id: string, allow: boolean, _remember = false) {
		const pending = this.pending.get(id);
		if (!pending) throw new Error("节点执行确认已过期");
		pending.finish(allow);
	}
	reset() {
		for (const pending of [...this.pending.values()]) pending.finish(false);
	}
}
