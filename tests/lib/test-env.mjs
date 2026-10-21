/**
 * test-env — 测试自起 server 的环境基线。
 *
 * 从 pi-harness/Electron 宿主里跑测试时，宿主自己的 PI_* 会泄进被测
 * server：PI_WEB_PKG_ROOT 让它伺服宿主自己的 web/dist（浏览器于是测的是
 * 另一个应用），PI_WEB_WORKSPACES_FILE / PI_SESSION_FILE 指向开发者真实的
 * 工作区与会话。CI 本来就没有 PI_*，剥除在 CI 是无操作、在本地是排雷。
 *
 * 不变量：scrubHostEnv() 调用过之后，进程 env 里剩下的 PI_* 全部是测试
 * 自己设的，testEnv() 不再剥它们——「先改 process.env 再 spawn」的旧式
 * 测试靠这一条把自设变量带给子进程。因此改过 process.env.PI_* 的测试
 * 必须先 scrub（scripts/check-test-env.mjs 强制）。
 *
 * 两种用法：
 * - 展开：`env: { ...testEnv(), PORT, PI_WEB_DATA_DIR }` —— 调用时快照，
 *   scrub 之后改过 process.env 也带得上（不反向修改 process.env）；
 * - 整包：`env: testEnv({ PORT, ... })` —— 同一函数的等价写法。
 * 两种都默认把 PI_WEB_PKG_ROOT 钉到 process.cwd()，显式 override 可覆盖
 * （如 before/after 双检出的 benchmark）。
 *
 * ELECTRON_RUN_AS_NODE 必须保留：宿主里 process.execPath 是 Electron，
 * 剥掉它会以 GUI 方式启动。
 */

let scrubbed = false;

/** 就地剥掉本进程 env 里的全部宿主 PI_*；此后 PI_* 命名空间归测试所有。 */
export function scrubHostEnv() {
	for (const key of Object.keys(process.env)) if (key.startsWith("PI_")) delete process.env[key];
	scrubbed = true;
}

/** env 快照：未 scrub 时先剥宿主 PI_*；PKG_ROOT 钉到仓库根；overrides 最后套。 */
export function testEnv(overrides = {}) {
	const env = { ...process.env };
	if (!scrubbed) for (const key of Object.keys(env)) if (key.startsWith("PI_")) delete env[key];
	env.PI_WEB_PKG_ROOT = process.cwd();
	return { ...env, ...overrides };
}
