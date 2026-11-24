#!/usr/bin/env node
// A/B evaluation for the engineering skill auto-trigger. Dev-only; requires `npm run build` first.
// Usage: node dev/skill-eval/run.mjs [--mode full|description|off|all] [--only id1,id2] [--timeout-ms 240000] [--out dir]
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "../..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
	const index = args.indexOf(`--${name}`);
	return index >= 0 ? args[index + 1] : fallback;
};
const modeArg = option("mode", "all");
const modes = modeArg === "all" ? ["off", "description", "full"] : [modeArg];
for (const mode of modes) if (!["off", "description", "full"].includes(mode)) throw new Error(`Unknown mode: ${mode}`);
const only = option("only", "")?.split(",").filter(Boolean);
const timeoutMs = Number(option("timeout-ms", "240000"));
const outDir = resolve(option("out", join(here, "results")));
const tasks = JSON.parse(readFileSync(join(here, "tasks.json"), "utf8"))
	.filter(task => !only?.length || only.includes(task.id));
if (!tasks.length) throw new Error("No tasks selected");

const { createAgentSessionServices, createAgentSessionFromServices, SessionManager } = await import("@earendil-works/pi-coding-agent");
const { engineeringResources } = await import(resolve(pkgRoot, "dist/server/engineering-skills.js"));

function prepareAgentDir() {
	const source = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	const agentDir = mkdtempSync(join(tmpdir(), "pi-skill-eval-agent-"));
	for (const name of ["auth.json", "models.json", "settings.json"]) {
		const file = join(source, name);
		if (existsSync(file)) copyFileSync(file, join(agentDir, name));
	}
	if (!existsSync(join(agentDir, "auth.json")) && !existsSync(join(agentDir, "models.json"))) {
		throw new Error(`No Pi auth/models found in ${source}; configure a model in Pi first`);
	}
	return agentDir;
}

const specialistNames = ["knowledge-sync", "grilling", "domain-modeling", "codebase-design", "tdd", "architect", "blast-radius", "reflect"];
const slash = value => value.replaceAll("\\", "/");

async function runTask(agentDir, task) {
	const workdir = mkdtempSync(join(tmpdir(), "pi-skill-eval-work-"));
	cpSync(join(here, "fixture-project"), workdir, { recursive: true });
	const reads = [], writes = [];
	const usage = { input: 0, output: 0 };
	let error;
	const started = Date.now();
	let session;
	try {
		const services = await createAgentSessionServices({
			cwd: workdir,
			agentDir,
			resourceLoaderOptions: { noSkills: true, ...engineeringResources("normal", pkgRoot, { cwd: workdir, agentDir }) },
		});
		({ session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(workdir) }));
		session.subscribe(event => {
			if (event.type === "tool_execution_start") {
				const path = typeof event.args?.path === "string" ? slash(event.args.path) : undefined;
				if (event.toolName === "read" && path) reads.push(path);
				if ((event.toolName === "write" || event.toolName === "edit") && path) writes.push(path);
			}
			const message = event.message;
			if ((event.type === "assistant_message" || event.type === "turn_end") && message?.usage) {
				usage.input += message.usage.input ?? 0;
				usage.output += message.usage.output ?? 0;
			}
		});
		for (const turn of task.turns ?? [task.prompt]) {
			await session.prompt(turn);
			await Promise.race([
				session.waitForIdle(),
				new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)),
			]);
		}
	} catch (err) {
		error = String(err?.message ?? err);
	} finally {
		session?.dispose();
	}
	const durationMs = Date.now() - started;
	const readSkill = name => reads.some(path => path.includes(`/skills/${name}/SKILL.md`));
	const triggered = readSkill("engineering");
	const specialist = specialistNames.filter(readSkill);
	const changeDoc = writes.some(path => path.includes("/docs/changes/"));
	const route = !triggered ? "none"
		: specialist.some(name => ["architect", "domain-modeling", "grilling"].includes(name)) ? "complex"
		: changeDoc ? "feature" : "quick-fix";
	rmSync(workdir, { recursive: true, force: true });
	return {
		id: task.id, lang: task.lang, expect: task.expect, expectedRoute: task.route,
		triggered, route, specialist, changeDoc, readCount: reads.length, durationMs,
		usage, ...(error ? { error } : {}),
	};
}

function summarize(records) {
	const engineering = records.filter(r => r.expect === "engineering" && !r.error);
	const readOnly = records.filter(r => r.expect === "none" && !r.error);
	const routed = engineering.filter(r => r.expectedRoute && r.triggered);
	const quickFixes = engineering.filter(r => r.expectedRoute === "quick-fix");
	const percent = (yes, total) => total ? Math.round((yes / total) * 1000) / 10 : null;
	const avg = values => values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null;
	return {
		tasks: records.length, errors: records.filter(r => r.error).length,
		triggerRate: percent(engineering.filter(r => r.triggered).length, engineering.length),
		skipRate: percent(readOnly.filter(r => !r.triggered).length, readOnly.length),
		routeAccuracy: percent(routed.filter(r => r.route === r.expectedRoute).length, routed.length),
		quickFixAvgDurationMs: avg(quickFixes.map(r => r.durationMs)),
		quickFixAvgOutputTokens: avg(quickFixes.map(r => r.usage.output)),
	};
}

const agentDir = prepareAgentDir();
const report = { createdAt: new Date().toISOString(), modes: {} };
try {
	for (const mode of modes) {
		process.env.PI_WEB_ENGINEERING_ROUTE = mode;
		const records = [];
		for (const task of tasks) {
			process.stdout.write(`[${mode}] ${task.id} ... `);
			const record = await runTask(agentDir, task);
			records.push(record);
			console.log(`${record.error ? `ERROR ${record.error}` : `triggered=${record.triggered} route=${record.route} ${(record.durationMs / 1000).toFixed(1)}s out=${record.usage.output}tok`}`);
		}
		report.modes[mode] = { summary: summarize(records), records };
	}
} finally {
	rmSync(agentDir, { recursive: true, force: true });
}
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `skill-eval-${report.createdAt.replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify(report, null, 2));
console.log(`\nReport: ${file}`);
console.table(Object.fromEntries(Object.entries(report.modes).map(([mode, data]) => [mode, data.summary])));
console.log("Targets: trigger >=95%, route accuracy >=90%, skip >=95%, quick-fix duration/token increase <=15% vs off");
