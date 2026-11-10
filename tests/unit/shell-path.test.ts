import { describe, expect, it } from "vitest";
import {
	ensureMacosShellPath,
	MACOS_STANDARD_BIN_DIRS,
	withStandardBinDirs,
} from "../../server/shell-path.js";

const ALL = (): boolean => true;
const NONE = (): boolean => false;
const only = (...dirs: string[]) => (dir: string) => dirs.includes(dir);

describe("withStandardBinDirs", () => {
	it("GUI 启动的极小 PATH 会补齐 Homebrew", () => {
		expect(withStandardBinDirs("/usr/bin:/bin:/usr/sbin:/sbin", undefined, ALL)).toBe(
			"/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin",
		);
	});

	it("追加在末尾，绝不前置——用户自己的目录保持优先", () => {
		const out = withStandardBinDirs("/usr/bin", undefined, ALL);
		expect(out.startsWith("/usr/bin")).toBe(true);
		expect(out.split(":").indexOf("/opt/homebrew/bin")).toBeGreaterThan(0);
	});

	it("已含 /opt/homebrew/bin 时不重复", () => {
		const out = withStandardBinDirs("/opt/homebrew/bin:/usr/bin", undefined, ALL);
		expect(out).toBe("/opt/homebrew/bin:/usr/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin");
		expect(out.split(":").filter(p => p === "/opt/homebrew/bin")).toHaveLength(1);
	});

	it("空 PATH / undefined 只返回补出来的目录", () => {
		expect(withStandardBinDirs("", undefined, ALL)).toBe(MACOS_STANDARD_BIN_DIRS.join(":"));
		expect(withStandardBinDirs(undefined, undefined, ALL)).toBe(MACOS_STANDARD_BIN_DIRS.join(":"));
	});

	it("不存在的目录不写入（Intel Mac 没有 /opt/homebrew）", () => {
		expect(withStandardBinDirs("/usr/bin", undefined, only("/usr/local/bin"))).toBe(
			"/usr/bin:/usr/local/bin",
		);
	});

	it("没有任何候选目录存在时原样返回", () => {
		expect(withStandardBinDirs("/usr/bin:/bin", undefined, NONE)).toBe("/usr/bin:/bin");
	});

	it("保留原 PATH 中的空段与重复项，不擅自清理", () => {
		expect(withStandardBinDirs("/usr/bin::/usr/bin", ["/opt/homebrew/bin"], ALL)).toBe(
			"/usr/bin::/usr/bin:/opt/homebrew/bin",
		);
	});

	it("相对路径候选被忽略", () => {
		expect(withStandardBinDirs("/usr/bin", ["bin", "/opt/homebrew/bin"], ALL)).toBe(
			"/usr/bin:/opt/homebrew/bin",
		);
	});
});

describe("ensureMacosShellPath", () => {
	it("被平台门禁：非 darwin 时是 no-op", () => {
		// 平台无法在测试进程内伪造，按实际平台断言门禁行为。
		const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
		const added = ensureMacosShellPath(env, ["/opt/homebrew/bin"], ALL);
		if (process.platform === "darwin") {
			expect(added).toEqual(["/opt/homebrew/bin"]);
			expect(env.PATH).toBe("/usr/bin:/opt/homebrew/bin");
		} else {
			expect(added).toEqual([]);
			expect(env.PATH).toBe("/usr/bin");
		}
	});

	it.skipIf(process.platform !== "darwin")("darwin 下就地改写 env.PATH 并返回新增目录", () => {
		const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
		const added = ensureMacosShellPath(env, ["/opt/homebrew/bin"], ALL);
		expect(added).toEqual(["/opt/homebrew/bin"]);
		expect(env.PATH).toBe("/usr/bin:/opt/homebrew/bin");
		// 幂等：再跑一次不重复追加
		expect(ensureMacosShellPath(env, ["/opt/homebrew/bin"], ALL)).toEqual([]);
		expect(env.PATH).toBe("/usr/bin:/opt/homebrew/bin");
	});
});
