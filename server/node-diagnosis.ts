import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

const stepLimit = 4;
const checkpoint = "SSH diagnosis checkpoint. Stop tool use and answer the user now: give the best-supported conclusion and its scope, the single observation that could overturn it, and the smallest missing input (or say none). Wait for the user's response.";
export const nodeDiagnosisInstructions = `During diagnosis, supply the same diagnosticGoal on all tool calls testing the same hypothesis, including another path, host or tool. Omit it for ordinary independent work. Stop as soon as the evidence supports an answer. At ${stepLimit} steps on one subgoal, or two consecutive tool failures, give a checkpoint: current defensible conclusion, one fact that could overturn it, and what input is missing. Wait for that input before branching.
A successful search with no matches is negative evidence within the searched source and time range. Check at most one other relevant location for the same hypothesis. Distinguish unavailable logs and failed searches from an actual absence of matches. If a redacted request body or request ID from the user is the cheapest discriminating input, ask for it immediately.
When a toolchain is missing or repeatedly fails, state the gap and an existing alternative (for example, inspect the source repository or ask for existing tool output). Do not implement a replacement parser or build a new toolchain to prolong diagnosis.`;

export const nodeDiagnosisGuard: ExtensionFactory = pi => {
	let previousGoal = "";
	let steps = 0;
	let errors = 0;
	const misses = new Map<string, number>();
	let suspended: string[] | undefined;
	function reset() {
		if (suspended) pi.setActiveTools(suspended);
		suspended = undefined;
		previousGoal = "";
		steps = 0;
		errors = 0;
		misses.clear();
	}
	pi.on("message_start", event => { if (event.message.role === "user") reset(); });
	pi.on("agent_settled", reset);
	pi.on("tool_call", () => suspended ? { block: true, reason: checkpoint } : undefined);
	pi.on("tool_result", event => {
		if (suspended) return;
		const goal = typeof event.input.diagnosticGoal === "string" ? event.input.diagnosticGoal.trim() : "";
		if (goal !== previousGoal) steps = 0;
		if (goal) steps++;
		previousGoal = goal;
		// grep exit 1 is a valid negative only for a standalone search; pipelines and wrappers have their own exit semantics.
		const command = event.input.command;
		const searchable = event.toolName === "remote_command" && typeof command === "string" && /^\s*(?:\/(?:usr\/)?bin\/)?grep\s/.test(command) && !/[;&|\n`$<>]/.test(command);
		const miss = searchable && event.isError && event.content.some(part => part.type === "text" && /^SSH command exit: 1(?:\n|$)/.test(part.text));
		const negatives = miss && goal ? (misses.get(goal) ?? 0) + 1 : 0;
		if (negatives) misses.set(goal, negatives);
		errors = event.isError && !miss ? errors + 1 : 0;
		if (steps < stepLimit && errors < 2 && negatives < 2) return;
		suspended = pi.getActiveTools();
		pi.setActiveTools([]);
		return { content: [...event.content, { type: "text", text: checkpoint }] };
	});
};
