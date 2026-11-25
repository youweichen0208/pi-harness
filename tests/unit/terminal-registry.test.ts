import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectRootKey, TerminalRegistry, projectRootKey } from "../../server/terminal-registry.js";

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

describe("projectRootKey", () => {
	it("规范化相对路径与尾部分隔符", () => {
		const root = tmp("pi-root-");
		const dir = join(root, "proj");
		mkdirSync(dir);
		const key = projectRootKey(dir);
		expect(key).toBe(projectRootKey(`${dir}${process.platform === "win32" ? "\\" : "/"}`));
		expect(key).toBe(projectRootKey(join(root, ".", "proj", "..", "proj")));
	});

	it("把符号链接解析到同一个键（否则同一目录会长出两套 PTY）", () => {
		const root = tmp("pi-root-link-");
		const real = join(root, "real");
		mkdirSync(real);
		const link = join(root, "link");
		try {
			symlinkSync(real, link, "dir");
		} catch {
			return; // Windows without developer mode cannot create symlinks
		}
		expect(projectRootKey(link)).toBe(projectRootKey(real));
	});

	it("不存在的路径与文件都没有键", () => {
		const root = tmp("pi-root-none-");
		expect(projectRootKey(join(root, "missing"))).toBeNull();
		const file = join(root, "file.txt");
		writeFileSync(file, "x");
		expect(projectRootKey(file)).toBeNull();
	});

	it("不同目录得到不同的键", () => {
		const root = tmp("pi-root-distinct-");
		for (const name of ["a", "b"]) mkdirSync(join(root, name));
		expect(projectRootKey(join(root, "a"))).not.toBe(projectRootKey(join(root, "b")));
	});
});

describe("TerminalRegistry", () => {
	/** Registry whose managers never spawn a PTY (they are only inspected here). */
	const registry = () => new TerminalRegistry(() => () => {});

	it("同一个键只创建一个管理器，且 get() 不会凭空创建", () => {
		const instance = registry();
		const first = instance.ensure("root-a");
		expect(instance.ensure("root-a")).toBe(first);
		expect(instance.get("root-b")).toBeUndefined();
		expect(instance.has("root-b")).toBe(false);
	});

	it("空闲槽按 LRU 回收，保留最近的 8 个", () => {
		const instance = registry();
		const keys = Array.from({ length: 12 }, (_, index) => `idle-${index}`);
		// No PTYs are spawned, so every slot is idle. Equal timestamps keep the
		// insertion order (stable sort), which makes the survivor set exact.
		for (const key of keys) instance.ensure(key);
		instance.reap();
		const survivors = keys.filter((key) => instance.has(key));
		expect(survivors).toHaveLength(8);
		expect(survivors).toEqual(keys.slice(4));
	});

	it("closeAll() 清空全部槽位", () => {
		const instance = registry();
		instance.ensure("root-a");
		instance.ensure("root-b");
		instance.closeAll();
		expect(instance.has("root-a")).toBe(false);
		expect(instance.has("root-b")).toBe(false);
		expect(instance.liveCount()).toBe(0);
	});

	it("键就是管理器自己的 workspaceRoot", () => {
		const dir = resolve(tmp("pi-root-manager-"), "proj");
		mkdirSync(dir);
		const key = projectRootKey(dir) as ProjectRootKey;
		expect(key).not.toBeNull();
		const instance = registry();
		expect(instance.ensure(key)).toBe(instance.get(key));
	});
});