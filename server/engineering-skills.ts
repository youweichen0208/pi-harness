import { loadSkills, type DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type DefaultResourceLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];

export const engineeringSkillNames = ["engineering", "knowledge-sync", "grilling", "domain-modeling", "codebase-design", "tdd", "architect", "blast-radius", "reflect", "learn", "ask", "build-graph", "update-graph"] as const;
export type EngineeringSkillName = typeof engineeringSkillNames[number];
export type EngineeringSessionKind = "normal" | "wiki" | "node" | "playground";

export const engineeringRoutingRule = "When the user requests a software project change, including small fixes or casual requests, load the engineering skill if available and follow its workflow. Select the route based on actual scope and risk, not the length or wording of the request. Do not trigger engineering for read-only review, explanation, or discussion alone. Reuse the skill instructions already loaded in the current context when they remain applicable. If the engineering skill is not available, proceed directly without it.";

/** Eval-only switch: full (default) injects the routing rule, description relies on the skill description alone, off disables the bundled skills entirely. */
export type EngineeringRouteMode = "full" | "description" | "off";

export function engineeringRouteMode(env: NodeJS.ProcessEnv = process.env): EngineeringRouteMode {
	const value = env.PI_WEB_ENGINEERING_ROUTE;
	return value === "description" || value === "off" ? value : "full";
}

export interface EngineeringScope {
	cwd: string;
	agentDir: string;
}

const appendBaseSnapshots = new Map<string, readonly string[]>();
const scopeKey = (scope: EngineeringScope) => `${resolve(scope.agentDir)}\0${resolve(scope.cwd)}`;

/** File-sourced append entries captured before the routing rule was added; undefined when no rule is injected. */
export function engineeringAppendBase(scope: EngineeringScope): readonly string[] | undefined {
	return appendBaseSnapshots.get(scopeKey(scope));
}

export function engineeringPackageRoot(root?: string): string {
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = root ? [root] : [process.env.PI_WEB_PKG_ROOT, resolve(here, ".."), resolve(here, "../..")];
	for (const candidate of candidates) {
		if (!candidate) continue;
		try {
			const pkg = JSON.parse(readFileSync(join(candidate, "package.json"), "utf8"));
			if (pkg.name === "@youweichen/pi-harness") return candidate;
		} catch { }
	}
	throw Error("Cannot locate bundled Engineering Skills");
}

export function engineeringSkillPath(name: EngineeringSkillName, root?: string): string {
	return join(engineeringPackageRoot(root), "assets/skills", name, "SKILL.md");
}

export function engineeringResources(kind: EngineeringSessionKind, root?: string, scope?: EngineeringScope): Pick<DefaultResourceLoaderOptions, "skillsOverride" | "appendSystemPromptOverride"> {
	if (kind !== "normal") return {};
	if (engineeringRouteMode() === "off") return {};
	process.env.PI_WEB_NODE_RUNTIME = process.execPath;
	const resources: Pick<DefaultResourceLoaderOptions, "skillsOverride" | "appendSystemPromptOverride"> = {
		skillsOverride(base) {
			try {
				const skillPaths = engineeringSkillNames.filter(name => !base.skills.some(skill => skill.name === name))
					.map(name => engineeringSkillPath(name, root));
				const bundled = loadSkills({ cwd: process.cwd(), agentDir: process.cwd(), skillPaths, includeDefaults: false });
				return { skills: [...base.skills, ...bundled.skills], diagnostics: [...base.diagnostics, ...bundled.diagnostics] };
			} catch (error) {
				return { ...base, diagnostics: [...base.diagnostics, { type: "warning", message: `Engineering Skills unavailable: ${String(error)}` }] };
			}
		},
	};
	if (engineeringRouteMode() === "full" && scope) {
		const key = scopeKey(scope);
		resources.appendSystemPromptOverride = base => {
			appendBaseSnapshots.set(key, Object.freeze([...base]));
			return [...base, engineeringRoutingRule];
		};
	}
	return resources;
}
