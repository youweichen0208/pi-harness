/** Present labelled `&&` command runs without guessing at shell execution.
 * A step view is available only when command labels and emitted labels match. */
export interface BashStep {
	label: string;
	command: string;
	output: string;
	state: "done" | "failed" | "no-match" | "running" | "skipped";
	lineCount: number;
}

export interface BashStepRun {
	command: string;
	steps: BashStep[];
	completed: number;
	failed: number;
	noMatch: number;
	exitCode?: number;
	status: "running" | "done" | "partial" | "failed" | "no-match";
}

export interface BashDiagnostic { path: string; line: number; column?: number; message: string }

export function bashCommand(argumentsText?: string): string | null {
	try {
		const args: unknown = JSON.parse(argumentsText ?? "");
		return args && typeof args === "object" && "command" in args && typeof args.command === "string" ? args.command : null;
	} catch { return null; }
}

/** `bash_task` controls background commands; present the call as a command line
 * (`bash_task list` / `bash_task read <id>`) so it reads as one row of the command list. */
export function bashTaskCommand(argumentsText?: string): string {
	try {
		const args: unknown = JSON.parse(argumentsText ?? "");
		if (!args || typeof args !== "object") return "bash_task";
		const { action, id, cursor } = args as { action?: unknown; id?: unknown; cursor?: unknown };
		const parts = ["bash_task"];
		if (typeof action === "string" && action) parts.push(action);
		if (typeof id === "string" && id) parts.push(id);
		if (typeof cursor === "number") parts.push(`--cursor ${cursor}`);
		return parts.join(" ");
	} catch { return "bash_task"; }
}

/** Split top-level `&&` and `;` while preserving the original separators. */
function commandParts(command: string): { text: string; separator: "" | "&&" | ";" }[] {
	const parts: { text: string; separator: "" | "&&" | ";" }[] = [];
	let start = 0;
	let separator: "" | "&&" | ";" = "";
	let quote: "'" | '"' | null = null;
	let escaped = false;
	let depth = 0;
	for (let i = 0; i < command.length; i++) {
		const char = command[i];
		if (escaped) { escaped = false; continue; }
		if (char === "\\" && quote !== "'") { escaped = true; continue; }
		if (quote) { if (char === quote) quote = null; continue; }
		if (char === "'" || char === '"') { quote = char; continue; }
		if (char === "(" || char === "{") { depth++; continue; }
		if (char === ")" || char === "}") { depth = Math.max(0, depth - 1); continue; }
		if (depth === 0 && (char === ";" || char === "&" && command[i + 1] === "&")) {
			parts.push({ text: command.slice(start, i).trim(), separator });
			separator = char === ";" ? ";" : "&&";
			start = i + separator.length;
			i = start - 1;
		}
	}
	parts.push({ text: command.slice(start).trim(), separator });
	return parts.filter((part) => part.text);
}

export function splitCommandChain(command: string): string[] {
	return commandParts(command).map((part) => part.text);
}

function echoLabel(part: string): string | null {
	const match = /^echo\s+(["']?)===\s*(.+?)\s*===\1\s*$/.exec(part);
	return match?.[2]?.trim() ?? null;
}

function cleanOutput(output: string): string {
	return output.replace(/\x1b\[[0-9;]*m/g, "").replace(/\r\n/g, "\n");
}

function nonemptyLines(output: string): number {
	return output.split("\n").filter((line) => line.trim().length > 0).length;
}

export function parseLabeledBashSteps(argumentsText: string | undefined, output: string, finished: boolean, isError: boolean, exitCode?: number): BashStepRun | null {
	const command = bashCommand(argumentsText);
	if (!command) return null;
	const chain = commandParts(command);
	const plans: { label: string; command: string }[] = [];
	let current: { label: string; commands: typeof chain } | null = null;
	for (const part of chain) {
		const label = echoLabel(part.text);
		if (label) {
			if (current) plans.push({ label: current.label, command: current.commands.map((item, index) => `${index ? ` ${item.separator} ` : ""}${item.text}`).join("") });
			current = { label, commands: [] };
		} else if (current) current.commands.push(part);
	}
	if (current) plans.push({ label: current.label, command: current.commands.map((item, index) => `${index ? ` ${item.separator} ` : ""}${item.text}`).join("") });
	if (plans.length < 2 || plans.some((plan) => !plan.command) || new Set(plans.map((plan) => plan.label)).size !== plans.length) return null;

	const chunks = new Map<string, string[]>();
	let active: string | null = null;
	for (const line of cleanOutput(output).split("\n")) {
		const marker = /^===\s*(.+?)\s*===\s*$/.exec(line)?.[1]?.trim();
		if (marker && plans.some((plan) => plan.label === marker)) {
			// A marker emitted out of order means the output cannot safely be mapped.
			if (chunks.has(marker)) return null;
			const expected = plans[chunks.size]?.label;
			if (marker !== expected) return null;
			active = marker;
			chunks.set(marker, []);
		} else if (active) chunks.get(active)?.push(line);
		else if (line.trim()) return null;
	}
	if (chunks.size === 0) return null;
	const lastObserved = chunks.size - 1;
	const effectiveExit = exitCode ?? Number(/(?:exited with code\s*|exit(?:ed)?\s+)(\d+)/i.exec(output)?.[1] ?? NaN);
	const steps: BashStep[] = plans.map((plan, index) => {
		const content = (chunks.get(plan.label) ?? []).join("\n").trimEnd();
		let state: BashStep["state"] = "skipped";
		if (index < lastObserved) state = "done";
		else if (index === lastObserved) {
			if (!finished) state = "running";
			else if (!isError) state = "done";
			else if (/^(?:grep|rg)\b/.test(plan.command) && effectiveExit === 1 && (!content.replace(/(?:^|\n)Command exited with code 1\s*$/i, "").trim() || /^0\s*(?:\n|$)/.test(content))) state = "no-match";
			else state = "failed";
		}
		return { label: plan.label, command: plan.command, output: content, state, lineCount: nonemptyLines(content) };
	});
	const completed = steps.filter((step) => step.state === "done").length;
	const failed = steps.filter((step) => step.state === "failed").length;
	const noMatch = steps.filter((step) => step.state === "no-match").length;
	return { command, steps, completed, failed, noMatch, exitCode: Number.isFinite(effectiveExit) ? effectiveExit : undefined, status: !finished ? "running" : failed ? completed || noMatch ? "partial" : "failed" : noMatch ? "no-match" : isError ? "failed" : "done" };
}

export function parseBashDiagnostics(output: string): BashDiagnostic[] {
	const diagnostics: BashDiagnostic[] = [];
	for (const raw of cleanOutput(output).split("\n")) {
		const line = raw.trim();
		const match = /^(.+?\.(?:tsx?|jsx?|mjs|cjs|json|css|html|py|go|rs))(?::(\d+)(?::(\d+))?|\((\d+),(\d+)\)):\s*(?:error\s*(?:TS\d+)?\s*:?\s*)?(.+)$/i.exec(line);
		if (!match) continue;
		const number = Number(match[2] ?? match[4]);
		if (!Number.isInteger(number) || number < 1) continue;
		diagnostics.push({ path: match[1], line: number, column: match[3] || match[5] ? Number(match[3] ?? match[5]) : undefined, message: match[6] });
	}
	return diagnostics.slice(0, 20);
}
