import { rmSync } from 'node:fs';
// tsc does not remove outputs whose source files were deleted.
rmSync(new URL('../dist/server/plan/', import.meta.url), { recursive: true, force: true });
