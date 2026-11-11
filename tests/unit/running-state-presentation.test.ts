import { describe, expect, it } from "vitest";
import { commandPresentation, commandPreview, gitStatusLine, gitStatusSummary } from "../../web/src/bash-presentation.js";

describe("running state presentation", () => {
	it("moves literal directories to badges without obscuring dynamic shell expressions", () => {
		const cwd = "/Users/alice/projects/app";
		expect(commandPresentation(`cd "${cwd}" && git status --short`, cwd)).toEqual({ command: "git status --short", directory: null });
		expect(commandPresentation("cd ../docs && ls", cwd)).toEqual({ command: "ls", directory: "~/projects/docs" });
		for (const command of ['cd "$TARGET" && ls', 'cd "$(pwd)" && ls', 'cd - && ls', 'cd ~bob && ls', 'cd .; ls', "cd '~/app' && ls", "cd 'price$' && ls", 'cd foo\\ bar && ls']) expect(commandPresentation(command, cwd).command).toBe(command);
	});
	it("aligns index/worktree status and counts only complete short-status output", () => {
		const lines = [" M docs/plan.md", "A  src/new.ts", "?? new folder/file.ts", " D old.ts", "UU conflict.ts"];
		expect(gitStatusLine(lines[0])).toEqual({ status: "M", path: "docs/plan.md", kind: "modified" });
		expect(gitStatusSummary("git add . && git status --short", lines)).toEqual({ files: 5, added: 2, modified: 1, deleted: 1, conflicts: 1 });
		expect(gitStatusSummary("git status --short", [...lines, "fatal: failed"])).toBeNull();
		expect(gitStatusSummary("echo 'git status'", lines)).toBeNull();
	});
});

it("command previews expose the executable while preserving complex shell setup", () => {
	const cwd = "/Users/example/project";
	expect(commandPreview('cd /Users/example/project && export PATH="/opt/bin:$PATH" && export MODE=test && pytest -q --require-postgres', cwd)).toBe("pytest -q --require-postgres");
	expect(commandPreview('MODE=test pytest -q', cwd)).toBe("pytest -q");
	expect(commandPreview('export A="one; two"; grep -rn readiness services', cwd)).toBe("grep -rn readiness services");
	for (const command of ['export A=$(fetch) && pytest', 'cd "$TARGET" && pytest', 'echo "export A=x && pytest"']) expect(commandPreview(command, cwd)).toBe(command);
	expect(commandPreview("export MODE=test", cwd)).toBe("export MODE=test");
});
it("command previews expose the executable while preserving complex shell setup", () => {
	const cwd = "/Users/example/project";
	expect(commandPreview('cd /Users/example/project && export PATH="/opt/bin:$PATH" && export MODE=test && pytest -q --require-postgres', cwd)).toBe("pytest -q --require-postgres");
	expect(commandPreview('MODE=test pytest -q', cwd)).toBe("pytest -q");
	expect(commandPreview('export A="one; two"; grep -rn readiness services', cwd)).toBe("grep -rn readiness services");
	for (const command of ['export A=$(fetch) && pytest', 'cd "$TARGET" && pytest', 'echo "export A=x && pytest"']) expect(commandPreview(command, cwd)).toBe(command);
	expect(commandPreview("export MODE=test", cwd)).toBe("export MODE=test");
});
