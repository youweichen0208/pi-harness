import { realpathSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Optional <Electron executable> <resources/app> makes the same real-runtime
// regressions exercise a shipped application, outside the checkout.
const supplied = process.argv.slice(2);
if (supplied.length !== 0 && supplied.length !== 2) throw Error("Expected optional executable and application root");
export const ompTestExecutable = supplied.length ? realpathSync(resolve(supplied[0])) : process.execPath;
export const ompTestRoot = realpathSync(supplied.length ? resolve(supplied[1]) : fileURLToPath(new URL("../../", import.meta.url)));
export const ompTestPackaged = supplied.length === 2;
export const loadOmpTestModule = name => import(pathToFileURL(join(ompTestRoot, "dist/server/omp", name)).href);
