import { loadSkills, type DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type DefaultResourceLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];

export const engineeringSkillNames = ["engineering", "knowledge-sync", "grilling", "domain-modeling", "codebase-design", "tdd", "architect", "blast-radius", "reflect"] as const;
export type EngineeringSkillName = typeof engineeringSkillNames[number];
export type EngineeringSessionKind = "normal" | "wiki" | "node" | "playground";

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

export function engineeringResources(kind: EngineeringSessionKind, root?: string): Pick<DefaultResourceLoaderOptions, "skillsOverride"> {
	if (kind !== "normal") return {};
	process.env.PI_WEB_NODE_RUNTIME = process.execPath;
	return {
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
}
