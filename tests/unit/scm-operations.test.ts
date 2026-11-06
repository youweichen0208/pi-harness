import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { scmOperation } from "../../server/scm-operation.js";
import { scmWorktrees, parseWorktrees } from "../../server/scm.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "scm-operations-")); roots.push(root);
	const repo = join(root, "main"); mkdirSync(repo);
	git(repo, "init", "-b", "main"); git(repo, "config", "user.email", "fixture@example.test"); git(repo, "config", "user.name", "Fixture");
	writeFileSync(join(repo, "file.txt"), "base\n"); git(repo, "add", "."); git(repo, "commit", "-m", "initial");
	return { root, repo };
}
describe("SCM operations", () => {
	it("switches locally, pushes and pulls using a local bare remote", async () => {
		const { root, repo } = fixture(); const remote = join(root, "remote.git");
		git(root, "init", "--bare", remote); git(repo, "remote", "add", "origin", remote); git(repo, "push", "-u", "origin", "main");
		git(repo, "branch", "feature"); await scmOperation(repo, "switch", "feature"); expect(git(repo, "branch", "--show-current")).toBe("feature");
		await scmOperation(repo, "switch", "main"); await scmOperation(repo, "push", undefined); await scmOperation(repo, "pull", undefined);
		git(repo, "push", "origin", "feature"); git(repo, "branch", "-D", "feature");
		await scmOperation(repo, "switch", "origin/feature"); expect(git(repo, "branch", "--show-current")).toBe("feature");
	});
	it("preserves dirty files on rejected switch and rejects invalid or stale requests", async () => {
		const { repo } = fixture(); git(repo, "checkout", "-b", "feature"); writeFileSync(join(repo, "file.txt"), "feature\n"); git(repo, "commit", "-am", "change"); git(repo, "checkout", "main"); writeFileSync(join(repo, "file.txt"), "dirty\n");
		await expect(scmOperation(repo, "switch", "feature")).rejects.toThrow(); expect(git(repo, "branch", "--show-current")).toBe("main");
		await expect(scmOperation(repo, "switch", "--detach")).rejects.toThrow("Invalid branch");
		await expect(scmOperation(repo, "reset", undefined)).rejects.toThrow("Invalid Git operation");
		await expect(scmOperation(repo, "push", undefined, () => false)).rejects.toThrow("Workspace unavailable");
	});
	it("lists linked trees from a subdirectory without combining their changes", async () => {
		const { root, repo } = fixture(); const linked = join(root, "linked tree"); git(repo, "worktree", "add", "-b", "linked", linked); mkdirSync(join(linked, "sub"));
		const trees = await scmWorktrees(join(linked, "sub")); expect(trees).toHaveLength(2); expect(trees.find(t => t.current)?.branch).toBe("linked");
		git(repo, "worktree", "lock", "--reason", "keep this tree", linked);
		expect((await scmWorktrees(repo)).find(t => t.branch === "linked")?.locked).toBe("keep this tree");
	});
	it("parses NUL paths and detached, bare and prunable records", () => {
		const trees = parseWorktrees("worktree /tmp/a\nb\0detached\0locked\0\0worktree /tmp/b\0bare\0prunable missing path\0\0", "/tmp/a\nb");
		expect(trees[0]).toMatchObject({ path: "/tmp/a\nb", current: true, detached: true, locked: "locked" });
		expect(trees[1]).toMatchObject({ bare: true, prunable: "missing path" });
	});
});
