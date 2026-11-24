import { rmSync } from 'node:fs';
// tsc does not remove outputs whose source files were deleted.
rmSync(new URL('../dist/server/plan/', import.meta.url), { recursive: true, force: true });

// Retired Workspace investigation extension; leave users' transcripts untouched.
for (const path of ['subagents/', 'subagent-presentation.js', 'subagent-presentation.js.map', 'subagent-steps.js', 'subagent-steps.js.map']) {
	rmSync(new URL('../dist/server/' + path, import.meta.url), { recursive: true, force: true });
}

// Remove compiled modules retired from the browser and skill integrations.
for (const module of ["page-reader", "browser-mcp", "design-first-resources"]) {
	for (const suffix of [".js", ".js.map"]) rmSync(new URL(`../dist/server/${module}${suffix}`, import.meta.url), { force: true });
}
