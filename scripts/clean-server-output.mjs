import { rmSync } from "node:fs";
// TypeScript keeps files emitted by earlier builds. Remove only the generated
// server tree so retired agents/workers cannot leak into npm or Desktop output.
rmSync(new URL("../dist/server/", import.meta.url), { recursive: true, force: true });
