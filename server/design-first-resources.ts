import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
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

export function designFirstSkillPath(root?: string): string {
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = root ? [root] : [process.env.PI_WEB_PKG_ROOT, resolve(here, ".."), resolve(here, "../..")];
	for (const candidate of candidates) {
		if (!candidate) continue;
		try {
			const pkg = JSON.parse(readFileSync(join(candidate, "package.json"), "utf8"));
			if (pkg.name === "@youweichen/pi-harness") return join(candidate, "assets/skills/design-first/SKILL.md");
		} catch { /* Try the source/compiled package root. */ }
	}
	throw Error("Cannot locate bundled Design First skill");
}

export function designFirstResources(kind: DesignFirstSessionKind, dataDir = documentDataDir(), root?: string): Pick<DefaultResourceLoaderOptions, "additionalPromptTemplatePaths" | "promptsOverride"> {
	if (kind !== "normal") return {};
	const path = resolve(designFirstSkillPath(root));
	// SDK prompt expansion runs after this override; JSON escapes keep path dollars literal.
	const encodedPath = JSON.stringify(path).replaceAll("$", "\\u0024");
	const commandPaths = ["design", "bug-fix", "feat"].map(name => join(dirname(path), "commands", `${name}.md`));
	const isBundledCommand = (filePath: string) => commandPaths.includes(resolve(filePath));
	return {
		additionalPromptTemplatePaths: commandPaths,
		promptsOverride(base) {
			try {
				const enabled = designFirstSettings(dataDir).enabled;
				return {
					...base,
					prompts: base.prompts.filter(prompt => enabled || !isBundledCommand(prompt.filePath)).map(prompt => isBundledCommand(prompt.filePath)
						? { ...prompt, content: prompt.content.replaceAll("{{DESIGN_FIRST_SKILL_PATH}}", () => encodedPath) }
						: prompt),
				};
			} catch (error) {
				return {
					prompts: base.prompts.filter(prompt => !isBundledCommand(prompt.filePath)),
					diagnostics: [...base.diagnostics, { type: "warning", message: `Design First shortcuts unavailable: ${error instanceof Error ? error.message : String(error)}`, path }],
				};
			}
		},
	};
}
