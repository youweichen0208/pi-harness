#!/usr/bin/env node
/**
 * check-test-env.mjs — 自起 server 的测试不得泄漏宿主环境。
 *
 * 从 pi-harness/Electron 宿主里跑测试时，宿主自己的 PI_* 会泄进被测
 * server：PI_WEB_PKG_ROOT 让它伺服宿主自己的 web/dist（浏览器于是测的
 * 是另一个应用），PI_WEB_WORKSPACES_FILE / PI_SESSION_FILE 指向开发者
 * 真实的工作区与会话。tests/lib/test-env.mjs 是唯一的环境基线。
 *
 * 三条规则，作用于引用了服务端入口（任意拼路径形态）的 tests/*.mjs：
 *   1. 不得展开 ...process.env（改用 ...testEnv() 或 testEnv({...})）；
 *   2. 不得直传 env: process.env；
 *   3. 给 process.env.PI_* 赋值前必须先 scrubHostEnv()——testEnv() 只在
 *      scrub 之前剥 PI_*，之后的自设变量要靠 scrub 划清命名空间。
 *
 * 用法：node scripts/check-test-env.mjs（CI 独立一步，同 check-protocol-sync）
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// 服务端入口的全部引用形态：字面量路径、server/index.ts（dev）、join 式拼路径。
const SPAWN = /dist\/server\/index\.js|server\/index\.ts|dist["']\s*,\s*["']server/;
const files = readdirSync(join(root, "tests")).filter(name => name.endsWith(".mjs"));

let failed = false;
for (const name of files) {
	const source = readFileSync(join(root, "tests", name), "utf8");
	if (!SPAWN.test(source)) continue;
	const spreads = [...source.matchAll(/\.\.\.process\.env/g)].length;
	const direct = /env:\s*process\.env\s*[,}]/.test(source);
	const mutates = /process\.env\.PI_[A-Z_]+\s*=/.test(source);
	const unscrubbed = mutates && !source.includes("scrubHostEnv");
	if (spreads || direct || unscrubbed) {
		const why = [
			spreads && `${spreads} 处 ...process.env`,
			direct && "env: process.env 直传",
			unscrubbed && "改 process.env.PI_* 前未 scrubHostEnv()",
		].filter(Boolean).join("；");
		console.error(`✗ tests/${name} 自起 server 却泄漏宿主环境（${why}）——改用 tests/lib/test-env.mjs`);
		failed = true;
	}
}
if (failed) process.exit(1);
console.log(`✓ ${files.length} 个测试脚本检查完毕：自起 server 的脚本均未泄漏宿主环境`);
