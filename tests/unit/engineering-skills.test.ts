import { createBashTool, DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { engineeringAppendBase, engineeringResources, engineeringRouteMode, engineeringRoutingRule, engineeringSkillNames, engineeringSkillPath } from "../../server/engineering-skills.js";

const names = ["architect", "ask", "blast-radius", "codebase-design", "domain-modeling", "engineering", "grilling", "knowledge-sync", "learn", "reflect", "tdd"] as const;
const roots: string[] = [];

function temporary() {
	const root = mkdtempSync(join(tmpdir(), "engineering-skills-"));
	roots.push(root);
	return root;
}

function bundledFixture() {
	const root = temporary();
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@youweichen/pi-harness" }));
	for (const name of names) {
		const directory = join(root, "assets/skills", name);
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: Bundled ${name} fixture\n---\nUse ${name}.\n`);
	}
	return root;
}

function localReferences(skillsRoot: string): string[] {
	const pending = engineeringSkillNames.map(name => join(skillsRoot, name, "SKILL.md")), seen = new Set<string>(), references: string[] = [];
	while (pending.length) {
		const file = pending.pop()!;
		if (seen.has(file)) continue;
		seen.add(file);
		const content = readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
		for (const match of content.matchAll(/\[([^\]]*)\]\(([^)]+)\)/g)) {
			const reference = match[2].split("#")[0];
			if (!reference || /^[a-z]+:/i.test(reference)) continue;
			const target = resolve(file, "..", reference);
			if (!readFileSync(target)) throw Error("unreachable");
			references.push(target.slice(skillsRoot.length + 1).replaceAll("\\", "/"));
			if (target.endsWith(".md")) pending.push(target);
		}
	}
	return references;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("bundled Engineering Skills", () => {
	it("loads the thirteen bundled skills into a normal session", async () => {
		const cwd = temporary(), packageRoot = bundledFixture();
		const loader = new DefaultResourceLoader({
			cwd, agentDir: cwd, settingsManager: SettingsManager.inMemory(),
			noSkills: true, noExtensions: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			...engineeringResources("normal", packageRoot),
		});
		await loader.reload();
		expect(loader.getSkills().skills.map(skill => skill.name).sort()).toEqual(names);
		expect(loader.getSkills().diagnostics).toEqual([]);
	});

	it.each(["wiki", "node", "playground"] as const)("does not inject bundled skills into %s", async kind => {
		const cwd = temporary(), packageRoot = bundledFixture();
		const loader = new DefaultResourceLoader({
			cwd, agentDir: cwd, settingsManager: SettingsManager.inMemory(), noSkills: true,
			noExtensions: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			...engineeringResources(kind, packageRoot),
		});
		await loader.reload();
		expect(loader.getSkills().skills).toEqual([]);
	});

	it.each(["engineering"])("keeps a %s user override and reports its actual path", async name => {
		const cwd = temporary(), packageRoot = bundledFixture();
		const userSkill = join(cwd, `user-${name}.md`);
		writeFileSync(userSkill, `---\nname: ${name}\ndescription: User-owned workflow\n---\nUser instructions.\n`);
		const loader = new DefaultResourceLoader({
			cwd, agentDir: cwd, settingsManager: SettingsManager.inMemory(), noSkills: true,
			additionalSkillPaths: [userSkill], noExtensions: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			...engineeringResources("normal", packageRoot),
		});
		await loader.reload();
		const skills = loader.getSkills().skills;
		expect(skills).toHaveLength(11);
		expect(skills.filter(skill => skill.name === name)).toHaveLength(1);
		expect(skills.find(skill => skill.name === name)?.filePath).toBe(userSkill);
		writeFileSync(userSkill, `---\nname: ${name}\ndescription: Updated user workflow\n---\nUpdated instructions.\n`);
		await loader.reload();
		expect(loader.getSkills().skills.find(skill => skill.name === name)?.description).toBe("Updated user workflow");
	});

	it("keeps existing skills and emits a diagnostic when bundled resources are unavailable", async () => {
		const cwd = temporary();
		const userSkill = join(cwd, "user-tdd.md");
		writeFileSync(userSkill, "---\nname: tdd\ndescription: User TDD\n---\nUser instructions.\n");
		const loader = new DefaultResourceLoader({
			cwd, agentDir: cwd, settingsManager: SettingsManager.inMemory(), noSkills: true,
			additionalSkillPaths: [userSkill], noExtensions: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			...engineeringResources("normal", join(cwd, "missing-package")),
		});
		await loader.reload();
		expect(loader.getSkills().skills.map(skill => skill.name)).toEqual(["tdd"]);
		expect(loader.getSkills().diagnostics.some(diagnostic => diagnostic.message.includes("Engineering Skills unavailable"))).toBe(true);
	});

	it("resolves codebase-design by name across both override directions", async () => {
		const cwd = temporary(), packageRoot = bundledFixture(), tddCopy = join(cwd, "project-tdd");
		mkdirSync(tddCopy);
		cpSync(engineeringSkillPath("tdd", resolve(".")), join(tddCopy, "SKILL.md"));
		const loader = new DefaultResourceLoader({
			cwd, agentDir: cwd, settingsManager: SettingsManager.inMemory(), noSkills: true,
			additionalSkillPaths: [tddCopy], noExtensions: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			...engineeringResources("normal", packageRoot),
		});
		await loader.reload();
		expect(loader.getSkills().skills.find(skill => skill.name === "tdd")?.filePath).toBe(join(tddCopy, "SKILL.md"));
		expect(loader.getSkills().skills.find(skill => skill.name === "codebase-design")?.filePath).toBe(engineeringSkillPath("codebase-design", packageRoot));
		const tdd = readFileSync(engineeringSkillPath("tdd", resolve(".")), "utf8");
		expect(tdd).toContain("<available_skills>");
		expect(tdd).not.toContain("../codebase-design");

		const codebaseOverride = join(cwd, "codebase-override.md");
		writeFileSync(codebaseOverride, "---\nname: codebase-design\ndescription: Project interface vocabulary\n---\nProject instructions.\n");
		const reverse = new DefaultResourceLoader({
			cwd, agentDir: cwd, settingsManager: SettingsManager.inMemory(), noSkills: true,
			additionalSkillPaths: [codebaseOverride], noExtensions: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			...engineeringResources("normal", packageRoot),
		});
		await reverse.reload();
		expect(reverse.getSkills().skills.find(skill => skill.name === "codebase-design")?.filePath).toBe(codebaseOverride);
		expect(reverse.getSkills().skills.find(skill => skill.name === "tdd")?.filePath).toBe(engineeringSkillPath("tdd", packageRoot));
	});

	it("checks real local references and reports a deleted target with the same checker", () => {
		const skillsRoot = resolve("assets/skills");
		const references = localReferences(skillsRoot);
		expect(references).toEqual(expect.arrayContaining([
			"engineering/templates/change.md", "engineering/references/resume.md", "engineering/scripts/approval-fingerprint.mjs",
			"domain-modeling/GLOSSARY-FORMAT.md", "domain-modeling/ADR-FORMAT.md",
			"codebase-design/DEEPENING.md", "tdd/tests.md", "tdd/mocking.md",
		]));
		const copy = join(temporary(), "skills");
		cpSync(skillsRoot, copy, { recursive: true });
		rmSync(join(copy, "engineering/templates/change.md"));
		expect(() => localReferences(copy)).toThrow(/engineering[\\/]templates[\\/]change\.md/);
	});

	it("bounds grilling with an explicit question budget and stop condition", () => {
		const root = resolve(".");
		const grilling = readFileSync(engineeringSkillPath("grilling", root), "utf8");
		expect(grilling).toContain("## Question Budget");
		expect(grilling).toMatch(/ask no questions/i);
		expect(grilling).toContain("default maximum of 5");
		expect(grilling).toMatch(/low-risk, reversible decisions autonomously/i);
		expect(grilling).toMatch(/sound, implementable design/i);
		expect(grilling).toMatch(/exhaustive design-tree/i);
		expect(grilling).not.toContain("Ask the whole frontier in one round");
		const engineering = readFileSync(engineeringSkillPath("engineering", root), "utf8");
		expect(engineering).toMatch(/already clear/i);
	});

	it("pins learn and ask knowledge-quality contracts without coupling to exact wording", () => {
		const root = resolve(".");
		const learn = readFileSync(engineeringSkillPath("learn", root), "utf8");
		expect(learn).toContain("## Knowledge Quality");
		for (const status of ["verified", "inferred", "unverified"]) expect(learn).toContain(`\`${status}\``);
		expect(learn).toMatch(/weakest material claim/i);
		expect(learn).toMatch(/explicit user-confirmed decisions/i);
		expect(learn).toMatch(/confirmed decision does not establish implementation correctness/i);
		expect(learn).toMatch(/never promote/i);
		expect(learn).toMatch(/preserve existing valid knowledge/i);
		expect(learn).toMatch(/version conflict/i);
		expect(learn).toContain("knowledge_write");
		const ask = readFileSync(engineeringSkillPath("ask", root), "utf8");
		expect(ask).toContain("source_read");
		expect(ask).toMatch(/without reading key evidence yourself/i);
	});

	it("preserves upstream seam vocabulary and explicit resume and standalone-copy contracts", () => {
		const root = resolve(".");
		const codebase = readFileSync(engineeringSkillPath("codebase-design", root), "utf8");
		expect(codebase).toContain("internal seams");
		expect(codebase).toContain("external seam");
		const resume = readFileSync(join(root, "assets/skills/engineering/references/resume.md"), "utf8");
		expect(resume).toContain("Approved revision");
		expect(resume).toContain("Approved revision matches, but Acceptance Criteria or contracts have changed");
		expect(resume).toContain("A matching `Approved revision` field alone is never enough");
		expect(resume).toMatch(/request one confirmation before Build/i);
		const reflect = readFileSync(engineeringSkillPath("reflect", root), "utf8");
		expect(reflect).toMatch(/standalone/i);
		expect(reflect).toMatch(/parent directory|父目录/i);
		expect(reflect).toContain("THIRD_PARTY.md");
		expect(reflect).toContain("LICENSE");
		expect(reflect).toMatch(/copyright/i);
		expect(reflect).toContain("same-name override");
		expect(reflect).toMatch(/actual loaded source is inside the bundled/i);
		expect(readFileSync(join(root, "Dockerfile"), "utf8")).toContain("COPY --from=build /app/assets/skills ./assets/skills");
	});

	it("verifies the approved content fingerprint and rejects same-revision acceptance changes", () => {
		const root = temporary(), document = join(root, "change.md"), script = resolve("assets/skills/engineering/scripts/approval-fingerprint.mjs");
		writeFileSync(document, "# Square\n\n## Goal\nAdd square.\n\n## Design\nDesign revision: 1\nAdd a public export.\n\nExample:\n\n```markdown\n## Summary\nThis heading is only an example.\n```\n\nReal contract: alpha\n\n## Approval\nStatus: pending\nApproved revision: none\nApproved content SHA-256: none\nEvidence: no user confirmation recorded\n\n## Acceptance Criteria\n- [ ] square(4) returns 16\n- [ ] Emit literal `- [ ]`\n\nExpected output:\n\n    - [ ] waiting\n\n## Implementation\n- [ ] Add square\n\n## Delivery\nNot started.\n");
		const fingerprint = execFileSync(process.execPath, [script, "fingerprint", document], { encoding: "utf8" }).trim();
		expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
		writeFileSync(document, readFileSync(document, "utf8").replace("Status: pending\nApproved revision: none\nApproved content SHA-256: none\nEvidence: no user confirmation recorded", `Status: approved\nApproved revision: 1\nApproved content SHA-256: ${fingerprint}\nEvidence: User confirmed revision 1`));
		const approved = spawnSync(process.execPath, [script, "verify", document], { encoding: "utf8" });
		expect(approved.status).toBe(0);
		expect(approved.stdout).toContain("APPROVED");
		writeFileSync(document, readFileSync(document, "utf8").replace("- [ ] square(4)", "- [x] square(4)"));
		expect(spawnSync(process.execPath, [script, "verify", document], { encoding: "utf8" }).status).toBe(0);

		writeFileSync(document, readFileSync(document, "utf8").replace("Real contract: alpha", "Real contract: beta"));
		expect(spawnSync(process.execPath, [script, "verify", document], { encoding: "utf8" }).status).toBe(3);
		writeFileSync(document, readFileSync(document, "utf8").replace("Real contract: beta", "Real contract: alpha"));

		writeFileSync(document, readFileSync(document, "utf8").replace("square(4) returns 16", "square(4) returns 17"));
		const stale = spawnSync(process.execPath, [script, "verify", document], { encoding: "utf8" });
		expect(stale.status).toBe(3);
		expect(stale.stdout).toContain("STALE");
		expect(readFileSync(document, "utf8")).toContain("Design revision: 1");
		expect(readFileSync(document, "utf8")).toContain("Approved revision: 1");
		writeFileSync(document, readFileSync(document, "utf8").replace("square(4) returns 17", "square(4) returns 16"));

		writeFileSync(document, readFileSync(document, "utf8").replace("Emit literal `- [ ]`", "Emit literal `- [x]`"));
		expect(spawnSync(process.execPath, [script, "verify", document], { encoding: "utf8" }).status).toBe(3);
		writeFileSync(document, readFileSync(document, "utf8").replace("Emit literal `- [x]`", "Emit literal `- [ ]`"));

		writeFileSync(document, readFileSync(document, "utf8").replace("    - [ ] waiting", "    - [x] waiting"));
		const indentedExample = spawnSync(process.execPath, [script, "verify", document], { encoding: "utf8" });
		expect(indentedExample.status).toBe(3);
		expect(indentedExample.stdout).toContain("STALE");
		writeFileSync(document, readFileSync(document, "utf8").replace("    - [x] waiting", "    - [ ] waiting"));

		writeFileSync(document, `${readFileSync(document, "utf8")}\n## Acceptance Criteria\n- [ ] Reject negative numbers\n`);
		const duplicateSection = spawnSync(process.execPath, [script, "verify", document], { encoding: "utf8" });
		expect(duplicateSection.status).toBe(2);
		expect(duplicateSection.stdout).toContain("NEEDS_CONFIRMATION");
		writeFileSync(document, readFileSync(document, "utf8").replace("\n## Acceptance Criteria\n- [ ] Reject negative numbers\n", ""));

		writeFileSync(document, `${readFileSync(document, "utf8")}\n## Acceptance Criteria ##\n- [ ] Reject negative numbers\n`);
		const closingHeading = spawnSync(process.execPath, [script, "verify", document], { encoding: "utf8" });
		expect(closingHeading.status).toBe(2);
		expect(closingHeading.stdout).toContain("NEEDS_CONFIRMATION");
		writeFileSync(document, readFileSync(document, "utf8").replace("\n## Acceptance Criteria ##\n- [ ] Reject negative numbers\n", ""));

		const historicalApproval = readFileSync(document, "utf8").replace("## Approval\nStatus: approved", `## Approval\n\`\`\`markdown\nStatus: approved\nApproved revision: 1\nApproved content SHA-256: ${fingerprint}\nEvidence: Historical user confirmation\n\`\`\`\nStatus: pending`).replace(/Approved revision: 1\nApproved content SHA-256: [a-f0-9]{64}\nEvidence: User confirmed revision 1/, "Approved revision: none\nApproved content SHA-256: none\nEvidence:");
		const pendingDocument = join(root, "pending.md");
		writeFileSync(pendingDocument, historicalApproval);
		const pending = spawnSync(process.execPath, [script, "verify", pendingDocument], { encoding: "utf8" });
		expect(pending.status).toBe(2);
		expect(pending.stdout).toContain("NEEDS_CONFIRMATION");

		writeFileSync(document, readFileSync(document, "utf8").replace("Status: approved", "Status: approved\nStatus: pending"));
		const conflicting = spawnSync(process.execPath, [script, "verify", document], { encoding: "utf8" });
		expect(conflicting.status).toBe(2);
		expect(conflicting.stdout).toContain("NEEDS_CONFIRMATION");
		writeFileSync(document, readFileSync(document, "utf8").replace("Status: approved\nStatus: pending", "Status: approved"));

		writeFileSync(document, readFileSync(document, "utf8").replace("Evidence: User confirmed revision 1", "Evidence:"));
		const emptyEvidence = spawnSync(process.execPath, [script, "verify", document], { encoding: "utf8" });
		expect(emptyEvidence.status).toBe(2);
		expect(emptyEvidence.stdout).toContain("NEEDS_CONFIRMATION");
		writeFileSync(document, readFileSync(document, "utf8").replace("Evidence:\n", "Evidence: User confirmed revision 1\n"));

		writeFileSync(document, readFileSync(document, "utf8").replace(/Approved content SHA-256: [a-f0-9]{64}/, "Approved content SHA-256: none"));
		const missing = spawnSync(process.execPath, [script, "verify", document], { encoding: "utf8" });
		expect(missing.status).toBe(2);
		expect(missing.stdout).toContain("NEEDS_CONFIRMATION");
	});

	it("preserves exact acceptance whitespace in indented and fenced examples", () => {
		const root = temporary(), document = join(root, "change.md"), script = resolve("assets/skills/engineering/scripts/approval-fingerprint.mjs"), output = "meaningful output  ";
		writeFileSync(document, "# Exact output\n\n## Goal\nPreserve exact output.\n\n## Design\nDesign revision: 1\nKeep output exact.\n\n## Approval\nStatus: pending\nApproved revision: none\nApproved content SHA-256: none\nEvidence: no user confirmation recorded\n\n## Acceptance Criteria\n    - [ ] waiting\n\n```text\n" + output + "\n```\n");
		const fingerprint = execFileSync(process.execPath, [script, "fingerprint", document], { encoding: "utf8" }).trim();
		writeFileSync(document, readFileSync(document, "utf8").replace("Status: pending\nApproved revision: none\nApproved content SHA-256: none\nEvidence: no user confirmation recorded", `Status: approved\nApproved revision: 1\nApproved content SHA-256: ${fingerprint}\nEvidence: User confirmed revision 1`));

		writeFileSync(document, readFileSync(document, "utf8").replace("    - [ ] waiting", "    - [x] waiting"));
		const indented = spawnSync(process.execPath, [script, "verify", document], { encoding: "utf8" });
		expect(indented.status).toBe(3);
		expect(indented.stdout).toContain("STALE");
		writeFileSync(document, readFileSync(document, "utf8").replace("    - [x] waiting", "    - [ ] waiting"));

		writeFileSync(document, readFileSync(document, "utf8").replace(`${output}\n`, "meaningful output\n"));
		const trailingSpaces = spawnSync(process.execPath, [script, "verify", document], { encoding: "utf8" });
		expect(trailingSpaces.status).toBe(3);
		expect(trailingSpaces.stdout).toContain("STALE");
	});

	it("uses document-level Markdown headings without truncating nested design contracts", () => {
		const root = temporary(), document = join(root, "change.md"), script = resolve("assets/skills/engineering/scripts/approval-fingerprint.mjs");
		writeFileSync(document, "# Contract\n\n## Goal\nDetect contract changes.\n\n## Design\nDesign revision: 1\n\n- Request:\n  ## Request body\n  Data retention: 7 days.\n\n## Approval\nStatus: pending\nApproved revision: none\nApproved content SHA-256: none\nEvidence: no user confirmation recorded\n\n## Acceptance Criteria\n- [ ] Existing behavior remains unchanged\n");
		const fingerprint = execFileSync(process.execPath, [script, "fingerprint", document], { encoding: "utf8" }).trim();
		writeFileSync(document, readFileSync(document, "utf8").replace("Status: pending\nApproved revision: none\nApproved content SHA-256: none\nEvidence: no user confirmation recorded", `Status: approved\nApproved revision: 1\nApproved content SHA-256: ${fingerprint}\nEvidence: User confirmed revision 1`));

		writeFileSync(document, readFileSync(document, "utf8").replace("Data retention: 7 days.", "Data retention: 30 days."));
		const changedContract = spawnSync(process.execPath, [script, "verify", document], { encoding: "utf8" });
		expect(changedContract.status).toBe(3);
		expect(changedContract.stdout).toContain("STALE");
		writeFileSync(document, readFileSync(document, "utf8").replace("Data retention: 30 days.", "Data retention: 7 days."));

		writeFileSync(document, `${readFileSync(document, "utf8")}\nAcceptance Criteria\n-------------------\n- [ ] Reject negative numbers\n`);
		const setextDuplicate = spawnSync(process.execPath, [script, "verify", document], { encoding: "utf8" });
		expect(setextDuplicate.status).toBe(2);
		expect(setextDuplicate.stdout).toContain("NEEDS_CONFIRMATION");
	});

	it("verifies the reference links actually used by the approved contract", () => {
		const document = join(temporary(), "change.md");
		const script = resolve("assets/skills/engineering/scripts/approval-fingerprint.mjs");
		const draft = [
			"## Goal", "Deliver [format][].",
			"", "## Design", "Design revision: 1", "", "> Choose [primary] or [fallback].",
			"", "## Acceptance Criteria", "- [ ] Follow the [approved schema][SCHEMA].",
			"", "| Diagram |", "| --- |", "| ![expected diagram][diagram] |",
			"", "```text", "[sample]", "```", "",
			"## Approval", "Status: approved", "Approved revision: 1", "Approved content SHA-256: pending", "Evidence: User confirmed revision 1",
			"", "## Delivery", "Publish [release].", "",
			"[format]: ./format.md", "[primary]: ./choice.md", '[schema]: ./v1.json "Approved schema"',
			"[diagram]: ./v1.png", "[sample]: ./sample.md", "[release]: ./release.md", "[unused]: ./unused.md", "",
		].join("\n");
		writeFileSync(document, draft);
		const fingerprint = execFileSync(process.execPath, [script, "fingerprint", document], { encoding: "utf8" }).trim();
		const approved = draft.replace("SHA-256: pending", `SHA-256: ${fingerprint}`);
		const cases = [
			{ before: "./v1.json", after: "./v2.json", expected: 3, label: "full reference in acceptance task" },
			{ before: "Approved schema", after: "Revised schema", expected: 3, label: "link title alone changed" },
			{ before: "./format.md", after: "./format-v2.md", expected: 3, label: "collapsed reference in Goal" },
			{ before: "[primary]:", after: "[fallback]:", expected: 3, label: "same URL moves to another shortcut in a quote" },
			{ before: "./v1.png", after: "./v2.png", expected: 3, label: "reference image in a table cell" },
			{ before: "./sample.md", after: "./example.md", expected: 0, label: "label appears only in fenced code" },
			{ before: "./release.md", after: "./release-v2.md", expected: 0, label: "link appears only in Delivery" },
			{ before: "./unused.md", after: "./unrelated.md", expected: 0, label: "unused definition" },
		];
		for (const { before, after, expected, label } of cases) {
			writeFileSync(document, approved.replace(before, after));
			const result = spawnSync(process.execPath, [script, "verify", document], { encoding: "utf8" });
			expect.soft(result.status, label).toBe(expected);
		}
	});

	it("uses the first definition of a repeated reference label", () => {
		const document = join(temporary(), "change.md");
		const script = resolve("assets/skills/engineering/scripts/approval-fingerprint.mjs");
		const draft = [
			"## Goal", "Deliver a schema.", "", "## Design", "Design revision: 1", "",
			"## Acceptance Criteria", "- [ ] Use the [approved schema][schema].", "",
			"## Approval", "Status: approved", "Approved revision: 1", "Approved content SHA-256: pending",
			"Evidence: User approved the active schema.", "", "## Delivery", "",
			"[schema]: ./active.json", "", "[schema]: ./unused.json", "",
		].join("\n");
		writeFileSync(document, draft);
		const fingerprint = execFileSync(process.execPath, [script, "fingerprint", document], { encoding: "utf8" }).trim();
		const approved = draft.replace("SHA-256: pending", `SHA-256: ${fingerprint}`);
		for (const [source, expected] of [
			[approved, 0],
			[approved.replace("./unused.json", "./alternate.json"), 0],
			[approved.replace("./active.json", "./changed.json"), 3],
		] as const) {
			writeFileSync(document, source);
			const result = spawnSync(process.execPath, [script, "verify", document], { encoding: "utf8" });
			expect(result.status).toBe(expected);
		}
	});

	it("requires confirmation when a reference definition disappears from a legacy approval", () => {
		const document = join(temporary(), "change.md");
		const script = resolve("assets/skills/engineering/scripts/approval-fingerprint.mjs");
		const definition = "[schema]: ./v1.json";
		const legacy = [
			"## Goal", "Deliver a schema.", "", "## Design", "Design revision: 1", "",
			"## Acceptance Criteria", "- [ ] Use the [approved schema][schema].", "",
			"## Approval", "Status: approved", "Approved revision: 1",
			"Approved content SHA-256: 01ea01b5dc00181ab16944a8493de081b15da1b51653c128e6a1bc7f86aed6a9",
			"Evidence: User approved the v1 schema.", "", "## Delivery", "", definition, "",
		].join("\n");
		for (const source of [legacy, legacy.replace(definition, "")]) {
			writeFileSync(document, source);
			const result = spawnSync(process.execPath, [script, "verify", document], { encoding: "utf8" });
			expect([2, 3]).toContain(result.status);
			expect(result.stdout).toMatch(/STALE|NEEDS_CONFIRMATION/);
		}
	});

	it("keeps a previously approved document with an inline link valid", () => {
		const document = join(temporary(), "change.md");
		const script = resolve("assets/skills/engineering/scripts/approval-fingerprint.mjs");
		writeFileSync(document, [
			"# Change", "", "## Goal", "Keep the result.", "",
			"## Design", "Design revision: 1", "See the [interface](./api.md).", "",
			"## Acceptance Criteria", "- [ ] The result is preserved.", "",
			"## Approval", "Status: approved", "Approved revision: 1",
			"Approved content SHA-256: e142d9f7a98f48685d0f27dd0992bfc28fb200b99e9013bef9eee39dc9af0069",
			"Evidence: User confirmed revision 1", "",
		].join("\n"));
		const result = spawnSync(process.execPath, [script, "verify", document], { encoding: "utf8" });
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("APPROVED revision 1");
	});

	it("requires current approval fields in the visible Markdown body", () => {
		const document = join(temporary(), "change.md");
		const script = resolve("assets/skills/engineering/scripts/approval-fingerprint.mjs");
		const change = "# Change\n\n## Goal\nKeep the result.\n\n## Design\nDesign revision: 1\n\n## Acceptance Criteria\n- [ ] The result is preserved.\n\n## Approval\n\n";
		writeFileSync(document, change);
		const fingerprint = execFileSync(process.execPath, [script, "fingerprint", document], { encoding: "utf8" }).trim();
		const fields = `Status: approved\nApproved revision: 1\nApproved content SHA-256: ${fingerprint}\nEvidence: User confirmed revision 1`;
		const history = `<!-- Archived confirmation\n${fields}\n-->`;
		const cases = [
			{ approval: `${history}\n\nWaiting for confirmation.`, expected: 2, label: "archived fields alone" },
			{ approval: `${history}\n\n${fields}`, expected: 0, label: "current approval alongside its history" },
			{ approval: `<pre>\n${fields}\n</pre>`, expected: 2, label: "fields in an HTML example" },
			{ approval: fields.replace("Evidence: User confirmed revision 1", "Evidence: <!-- prior confirmation -->"), expected: 2, label: "empty visible evidence" },
		];
		for (const { approval, expected, label } of cases) {
			writeFileSync(document, change + approval + "\n");
			const result = spawnSync(process.execPath, [script, "verify", document], { encoding: "utf8" });
			expect.soft(result.status, label).toBe(expected);
		}
	});

	it("runs fingerprint and verify from a complete Skill copy outside the repository", () => {
		const root = temporary(), skillCopy = join(root, ".pi/skills/engineering"), document = join(root, "change.md");
		cpSync(resolve("assets/skills/engineering"), skillCopy, { recursive: true });
		const script = join(skillCopy, "scripts/approval-fingerprint.mjs");
		const options = { cwd: root, encoding: "utf8", env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "", PI_WEB_PKG_ROOT: "" } } as const;
		writeFileSync(document, "# Standalone\n\n## Goal\nRun without installed project dependencies.\n\n## Design\nDesign revision: 1\nKeep the Skill copy executable.\n\n## Approval\nStatus: pending\nApproved revision: none\nApproved content SHA-256: none\nEvidence: no user confirmation recorded\n\n## Acceptance Criteria\n- [ ] Both commands work outside the repository\n");
		const fingerprint = execFileSync(process.execPath, [script, "fingerprint", document], options).trim();
		expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
		writeFileSync(document, readFileSync(document, "utf8").replace("Status: pending\nApproved revision: none\nApproved content SHA-256: none\nEvidence: no user confirmation recorded", `Status: approved\nApproved revision: 1\nApproved content SHA-256: ${fingerprint}\nEvidence: User confirmed revision 1`));
		const verified = spawnSync(process.execPath, [script, "verify", document], options);
		expect(verified.status).toBe(0);
		expect(verified.stdout).toContain("APPROVED revision 1");
		writeFileSync(document, readFileSync(document, "utf8").replace("Both commands work outside the repository", "Verify only works inside the repository"));
		const stale = spawnSync(process.execPath, [script, "verify", document], options);
		expect(stale.status).toBe(3);
		expect(stale.stdout).toContain("STALE");
	});

	it("runs approval verification through native Bash without node on PATH", async () => {
		const cwd = temporary(), packageRoot = bundledFixture(), document = join(cwd, "change.md"), script = resolve("assets/skills/engineering/scripts/approval-fingerprint.mjs");
		writeFileSync(document, "# Approved\n\n## Goal\nKeep runtime access.\n\n## Design\nDesign revision: 1\nUse the host runtime.\n\n## Approval\nStatus: pending\nApproved revision: none\nApproved content SHA-256: none\nEvidence: no user confirmation recorded\n\n## Acceptance Criteria\n- [ ] Verification works without node on PATH\n");
		const fingerprint = execFileSync(process.execPath, [script, "fingerprint", document], { encoding: "utf8" }).trim();
		writeFileSync(document, readFileSync(document, "utf8").replace("Status: pending\nApproved revision: none\nApproved content SHA-256: none\nEvidence: no user confirmation recorded", `Status: approved\nApproved revision: 1\nApproved content SHA-256: ${fingerprint}\nEvidence: User confirmed revision 1`));
		const path = process.env.PATH, runtime = process.env.PI_WEB_NODE_RUNTIME;
		try {
			process.env.PATH = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32") : "/usr/bin:/bin";
			delete process.env.PI_WEB_NODE_RUNTIME;
			engineeringResources("normal", packageRoot);
			expect(process.env.PI_WEB_NODE_RUNTIME).toBe(process.execPath);
			const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
			const command = `if [ -n "$PI_WEB_NODE_RUNTIME" ]; then runtime="$PI_WEB_NODE_RUNTIME"; else runtime=node; fi\n"$runtime" ${quote(script)} verify ${quote(document)}`;
			const result = await createBashTool(cwd).execute("host-runtime", { command });
			expect(result.structuredContent).toMatchObject({ exit_code: 0 });
			expect(JSON.stringify(result.content)).toContain("APPROVED revision 1");
		} finally {
			if (path === undefined) delete process.env.PATH; else process.env.PATH = path;
			if (runtime === undefined) delete process.env.PI_WEB_NODE_RUNTIME; else process.env.PI_WEB_NODE_RUNTIME = runtime;
		}
	});

	it("ships dependency-closed skills with thin orchestration and recorded upstream pins", () => {
		const root = resolve(".");
		for (const name of engineeringSkillNames) {
			const content = readFileSync(engineeringSkillPath(name, root), "utf8");
			expect(content).not.toContain("Skill tool");
			expect(content).not.toContain("subagent_type");
		}
		expect(readFileSync(engineeringSkillPath("engineering", root), "utf8").split("\n").length).toBeLessThanOrEqual(100);
		for (const name of ["reflect", "learn", "ask"] as const) expect(readFileSync(engineeringSkillPath(name, root), "utf8")).toContain("disable-model-invocation: true");
		const notice = readFileSync(join(root, "assets/skills/THIRD_PARTY.md"), "utf8");
		expect(notice).toContain("d1478fcb140db0b93c0c8df17bcfd311844749d0");
		expect(notice).toContain("005d8f6e8ec057b738adcd08a08b30db0478402d");
		expect(readFileSync(join(root, "assets/skills/LICENSES/mattpocock-skills-MIT.txt"), "utf8")).toContain("Copyright (c) 2026 Matt Pocock");
		expect(readFileSync(join(root, "assets/skills/LICENSES/pstack-MIT.txt"), "utf8")).toContain("Copyright (c) 2026 Lauren Tan");
	});

	it("ships the license of the pi-harness Skills and identifies Engineering's bundled Marked notice for Reflect", () => {
		const skills = resolve("assets/skills");
		const notice = readFileSync(join(skills, "THIRD_PARTY.md"), "utf8").split("\n");
		const license = "LICENSES/pi-harness-MIT.txt";
		for (const name of ["engineering", "knowledge-sync", "ask", "learn"]) {
			const entry = notice.find(line => line.includes(`\`${name}/\``));
			expect(entry, name).toContain(license);
			if (name === "engineering") expect(entry).toContain("engineering/scripts/vendor/marked-LICENSE.txt");
		}
		expect(readFileSync(join(skills, license))).toEqual(readFileSync(resolve("LICENSE")));
	});
});

describe("engineering routing rule", () => {
	const savedMode = process.env.PI_WEB_ENGINEERING_ROUTE;
	afterEach(() => {
		if (savedMode === undefined) delete process.env.PI_WEB_ENGINEERING_ROUTE;
		else process.env.PI_WEB_ENGINEERING_ROUTE = savedMode;
	});

	it("parses the eval-only route mode with full as default", () => {
		delete process.env.PI_WEB_ENGINEERING_ROUTE;
		expect(engineeringRouteMode()).toBe("full");
		process.env.PI_WEB_ENGINEERING_ROUTE = "description";
		expect(engineeringRouteMode()).toBe("description");
		process.env.PI_WEB_ENGINEERING_ROUTE = "off";
		expect(engineeringRouteMode()).toBe("off");
		process.env.PI_WEB_ENGINEERING_ROUTE = "unexpected";
		expect(engineeringRouteMode()).toBe("full");
	});

	it("appends the rule after file content, keeps the base snapshot, and never duplicates across reloads", async () => {
		delete process.env.PI_WEB_ENGINEERING_ROUTE;
		const cwd = temporary(), packageRoot = bundledFixture();
		writeFileSync(join(cwd, "APPEND_SYSTEM.md"), "user instructions");
		const scope = { cwd, agentDir: cwd };
		const loader = new DefaultResourceLoader({
			cwd, agentDir: cwd, settingsManager: SettingsManager.inMemory(),
			noSkills: true, noExtensions: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			...engineeringResources("normal", packageRoot, scope),
		});
		await loader.reload();
		expect(loader.getAppendSystemPrompt()).toEqual(["user instructions", engineeringRoutingRule]);
		expect(engineeringAppendBase(scope)).toEqual(["user instructions"]);
		writeFileSync(join(cwd, "APPEND_SYSTEM.md"), "updated instructions");
		await loader.reload();
		expect(loader.getAppendSystemPrompt()).toEqual(["updated instructions", engineeringRoutingRule]);
		expect(engineeringAppendBase(scope)).toEqual(["updated instructions"]);
	});

	it("injects no rule without a scope, in description mode, in off mode, or for isolated kinds", () => {
		delete process.env.PI_WEB_ENGINEERING_ROUTE;
		const packageRoot = bundledFixture();
		expect(engineeringResources("normal", packageRoot).appendSystemPromptOverride).toBeUndefined();
		process.env.PI_WEB_ENGINEERING_ROUTE = "description";
		expect(engineeringResources("normal", packageRoot, { cwd: ".", agentDir: "." }).appendSystemPromptOverride).toBeUndefined();
		process.env.PI_WEB_ENGINEERING_ROUTE = "off";
		expect(engineeringResources("normal", packageRoot, { cwd: ".", agentDir: "." })).toEqual({});
		delete process.env.PI_WEB_ENGINEERING_ROUTE;
		for (const kind of ["wiki", "node", "playground"] as const) {
			expect(engineeringResources(kind, packageRoot, { cwd: ".", agentDir: "." })).toEqual({});
		}
	});
});
