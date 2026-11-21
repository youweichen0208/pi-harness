import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSkills, type DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { documentDataDir } from "./document-extension-settings.js";
import { writeFileAtomic } from "./private-file.js";

type DefaultResourceLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];

export type DesignFirstSessionKind = "normal" | "wiki" | "node" | "playground";

export function designFirstSettings(dataDir = documentDataDir()): { enabled: boolean; version: string } {
	let enabled = true;
	try {
		const value: unknown = JSON.parse(readFileSync(join(dataDir, "design-first.json"), "utf8"));
		if (!value || typeof value !== "object" || !("enabled" in value) || typeof value.enabled !== "boolean") throw Error("Invalid design-first.json");
		enabled = value.enabled;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return { enabled, version: createHash("sha256").update(JSON.stringify({ enabled })).digest("hex") };
}

/** M1 setting only: changing it takes effect on native reload/new session. */
export function toggleDesignFirst(enabled: boolean, version: string, dataDir = documentDataDir()): void {
	if (typeof enabled !== "boolean") throw Error("Invalid Design First setting");
	if (designFirstSettings(dataDir).version !== version) throw Error("Design First settings changed; refresh and retry");
	writeFileAtomic(join(dataDir, "design-first.json"), JSON.stringify({ enabled }, null, "\t") + "\n");
}

export const designFirstNames = ["design-first", "bug-fix", "feat"] as const;

export function designFirstSkillPath(root?: string, name: typeof designFirstNames[number] = "design-first"): string {
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = root ? [root] : [process.env.PI_WEB_PKG_ROOT, resolve(here, ".."), resolve(here, "../..")];
	for (const candidate of candidates) {
		if (!candidate) continue;
		try {
			const pkg = JSON.parse(readFileSync(join(candidate, "package.json"), "utf8"));
			if (pkg.name === "@youweichen/pi-harness") return join(candidate, "assets/skills/design-first", name === "design-first" ? "" : name, "SKILL.md");
		} catch { /* Try the source/compiled package root. */ }
	}
	throw Error("Cannot locate bundled Design First skill");
}

export function designFirstResources(kind: DesignFirstSessionKind, dataDir = documentDataDir(), root?: string): Pick<DefaultResourceLoaderOptions, "skillsOverride"> {
	if (kind !== "normal") return {};
	return {
		skillsOverride(base) {
			try {
				if (!designFirstSettings(dataDir).enabled) return base;
				const skillPaths = designFirstNames.filter(name => !base.skills.some(skill => skill.name === name))
					.map(name => designFirstSkillPath(root, name));
				const bundled = loadSkills({ cwd: dataDir, agentDir: dataDir, skillPaths, includeDefaults: false });
				return { skills: [...base.skills, ...bundled.skills], diagnostics: [...base.diagnostics, ...bundled.diagnostics] };
			} catch (error) {
				return { ...base, diagnostics: [...base.diagnostics, { type: "warning", message: `Design First skills unavailable: ${String(error)}` }] };
			}
		},
	};
}
