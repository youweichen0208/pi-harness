import { rmSync } from 'node:fs';
// tsc does not remove outputs whose source files were deleted.
rmSync(new URL('../dist/server/plan/', import.meta.url), { recursive: true, force: true });

// Retired Workspace investigation extension; leave users' transcripts untouched.
for (const path of ['subagents/', 'subagent-presentation.js', 'subagent-presentation.js.map', 'subagent-steps.js', 'subagent-steps.js.map']) {
	rmSync(new URL('../dist/server/' + path, import.meta.url), { recursive: true, force: true });
}
