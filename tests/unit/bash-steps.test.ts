import { expect, test } from "vitest";
import { bashTaskCommand, parseBashDiagnostics, parseLabeledBashSteps, splitCommandChain } from "../../web/src/bash-steps.js";

test("bash_task calls present as command lines", () => {
	expect(bashTaskCommand('{"action":"list"}')).toBe("bash_task list");
	expect(bashTaskCommand('{"action":"read","id":"toolu_abc","cursor":12}')).toBe("bash_task read toolu_abc --cursor 12");
	expect(bashTaskCommand('{"action":"stop","id":"toolu_abc"}')).toBe("bash_task stop toolu_abc");
	expect(bashTaskCommand('{"action":"li')).toBe("bash_task");
	expect(bashTaskCommand(undefined)).toBe("bash_task");
});

test("splits only top-level && and maps emitted labels to actual steps", () => {
	expect(splitCommandChain('echo "a && b" && grep "x && y" file && echo done')).toEqual(['echo "a && b"', 'grep "x && y" file', 'echo done']);
	const args = JSON.stringify({ command: 'cd /tmp/work && echo "=== PORTS ===" && rg 899 tests && echo "=== GIT ===" && git status' });
	const run = parseLabeledBashSteps(args, '=== PORTS ===\ntests/a:8992\n=== GIT ===\nfatal: not a git repository\nCommand exited with code 128', true, true, 128);
	expect(run?.status).toBe("partial");
	expect(run?.steps.map(({ label, state }) => [label, state])).toEqual([["PORTS", "done"], ["GIT", "failed"]]);
	expect(run?.completed).toBe(1);
	expect(run?.exitCode).toBe(128);
});

test("unmatched markers and unlabeled chains stay raw; grep no-match is neutral", () => {
	const args = JSON.stringify({ command: 'echo "=== A ===" && rg absent docs && echo "=== B ===" && echo hello' });
	expect(parseLabeledBashSteps(args, 'plain output', true, true, 1)).toBeNull();
	expect(parseLabeledBashSteps(args, '=== B ===\nwrong order', true, false)).toBeNull();
	const run = parseLabeledBashSteps(args, '=== A ===\nCommand exited with code 1', true, true, 1);
	expect(run?.steps.map(({ state }) => state)).toEqual(["no-match", "skipped"]);
	expect(run?.failed).toBe(0);
	expect(run?.status).toBe("no-match");
});

test("recognizes labelled steps separated by semicolons while preserving quoted delimiters", () => {
	expect(splitCommandChain('echo "a; b"; pwd; echo "=== NEXT ==="; ls missing')).toEqual(['echo "a; b"', 'pwd', 'echo "=== NEXT ==="', 'ls missing']);
	const args = JSON.stringify({ command: 'echo "=== FIRST ==="; pwd; echo "=== SECOND ==="; ls missing' });
	const run = parseLabeledBashSteps(args, '=== FIRST ===\n/tmp\n=== SECOND ===\nls: missing: No such file or directory\nCommand exited with code 1', true, true, 1);
	expect(run?.status).toBe("partial");
	expect(run?.steps.map((step) => step.state)).toEqual(["done", "failed"]);
});

test("extracts real file locations from TypeScript failures", () => {
	expect(parseBashDiagnostics('web/src/App.tsx(23,5): error TS2322: wrong type\nserver/index.ts:17:2: error: failed')).toEqual([
		{ path: "web/src/App.tsx", line: 23, column: 5, message: "wrong type" },
		{ path: "server/index.ts", line: 17, column: 2, message: "failed" },
	]);
});
