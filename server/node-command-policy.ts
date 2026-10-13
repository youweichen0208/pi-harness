import { randomUUID } from "node:crypto";

const READ_ONLY = new Set(["cd", "ls", "cat", "df", "ps", "grep", "pwd", "head", "tail", "wc", "uname", "whoami", "id", "uptime", "free", "stat", "du"]);
const OPERATOR = new Set(["&&", "||", ";", "|"]);

/** Simple invocations and chains (`&&`, `||`, `;`, `|`) of them are classified
 * automatically. Expansion, redirection, subshells, background jobs and unknown
 * programs always require an explicit decision. Only a single invocation names a
 * family that can be remembered; a chain never extends a grant. */
export function commandPolicy(command: string): { readOnly: boolean; family?: string } {
	if (!command.trim() || /[\x00-\x1f\x7f$`\\<>(){}]/.test(command)) return { readOnly: false };
	const tokens = command.match(/"[^"\n]*"|'[^'\n]*'|&&|\|\||[;|]|[^\s"';|&]+/g) ?? [];
	// Every character must belong to a token; anything skipped (a lone `&`) falls back to asking.
	if (tokens.join("").replace(/\s+/g, "") !== command.replace(/\s+/g, "")) return { readOnly: false };
	const parts: string[][] = [[]];
	for (const token of tokens) if (OPERATOR.has(token)) parts.push([]); else parts[parts.length - 1].push(token);
	const families = parts.map(part => part[0]);
	if (families.some(family => !family || !/^[a-z][a-z0-9_-]*$/.test(family))) return { readOnly: false };
	const readOnly = families.every(family => READ_ONLY.has(family));
	return parts.length === 1 ? { readOnly, family: families[0] } : { readOnly };
}

export interface CommandApproval {
	id: string;
	command: string;
	family?: string;
}

/** Decisions and remembered command families belong to one Agent session only. */
export class NodeCommandApprovals {
	private allowed = new Set<string>();
	private pending = new Map<string, { approval: CommandApproval; finish: (allow: boolean, remember?: boolean) => void }>();
	constructor(private readonly changed: (pending: CommandApproval[]) => void) {}
	private emit() { this.changed([...this.pending.values()].map(item => item.approval)); }
	async request(command: string, signal: AbortSignal, write = false): Promise<void> {
		signal.throwIfAborted();
		const policy = write ? { readOnly: false, family: undefined } : commandPolicy(command);
		if (policy.readOnly || policy.family && this.allowed.has(policy.family)) return;
		await new Promise<void>((resolve, reject) => {
			const id = randomUUID();
			const abort = () => finish(false);
			const finish = (allow: boolean, remember = false) => {
				signal.removeEventListener("abort", abort);
				this.pending.delete(id);
				if (allow && remember && policy.family) this.allowed.add(policy.family);
				this.emit();
				if (allow && !signal.aborted) resolve(); else reject(new Error(signal.aborted ? "节点操作已取消" : "用户拒绝执行节点操作"));
			};
			this.pending.set(id, { approval: { id, command, family: policy.family }, finish });
			signal.addEventListener("abort", abort, { once: true });
			this.emit();
		});
	}
	respond(id: string, allow: boolean, remember = false) {
		const pending = this.pending.get(id);
		if (!pending) throw new Error("节点执行确认已过期");
		pending.finish(allow, remember);
	}
	reset() {
		this.allowed.clear();
		for (const pending of [...this.pending.values()]) pending.finish(false);
	}
}
