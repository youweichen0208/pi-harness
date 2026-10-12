/**
 * 扩展代码模块缓存管理（issue #64）。
 *
 * pi SDK 通过 jiti 加载扩展文件；jiti 对原生 .js/.mjs 走 Node 的
 * import()（连 CJS 入口也是），因此进程内的 ESM loader 缓存会让
 * /restart 或 session.reload() 重建扩展工厂后仍命中旧代码、旧状态
 * （扩展里的 MCP 桥死连接就是这么遗留的）。.ts 由 jiti 每次实例化
 * 重新转译，天然是新鲜的。
 *
 * 策略（已在本机用一次性探测脚本验证，回归见 tests/restart-extension-cache-test.mjs）：
 * - module.registerHooks 在 resolve 阶段给受控目录下的模块 URL 追加
 *   ?piextgen=<代数>；代数递增即得到新 URL，绕开 ESM loader 的永久缓存。
 *   CJS 的 require() 会剥掉 search 再查 require.cache，因此参数无副作用。
 * - 同时清空受控目录下的 require.cache 条目，刷新 CJS 模块本体
 *   （含包内相对 require 的子模块）；旧实例靠闭包存活，不受影响。
 *
 * 生命周期：每个会话创建 runtime 前调用 registerExtensionModuleScope()
 * 注册该 cwd 的扩展目录（幂等）；仅在用户显式的 /restart 与 /reload 前调用
 * bumpExtensionModuleCache()——ESM 缓存不可释放，每次刷新都会多留一份
 * 模块实例，所以设置、提示词、MCP 保存触发的重载不刷新。
 *
 * 代数是进程全局的：一次刷新后，其他对话里扩展再懒加载受控目录下的
 * 模块也会拿到新实例（与已加载的旧实例状态分离），require.cache 同理。
 * 刷新仅由用户显式触发，接受这一影响。
 */
import module from "node:module";
import { realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const QUERY_KEY = "piextgen";

/** 一个受控目录：require.cache 键用真实路径前缀，ESM URL 用两种形式的前缀。 */
interface Scope {
	pathPrefix: string;
	urlPrefixes: string[];
}

const scopes = new Map<string, Scope>();
let generation = 0;
let hooksRegistered = false;
let hooksUnsupported = false;

const require = createRequire(import.meta.url);

function registerHooks(): void {
	if (hooksRegistered || hooksUnsupported) return;
	if (typeof module.registerHooks !== "function") {
		// Node < 22.15（如旧版 Electron）：ESM 缓存无法绕开，/restart 后
		// ESM 形式的扩展代码仍是旧的；require.cache 清理照常生效。
		hooksUnsupported = true;
		console.warn("[pi-harness] module.registerHooks 不可用，/restart 无法刷新原生 ESM 形式的扩展代码。");
		return;
	}
	hooksRegistered = true;
	module.registerHooks({
		resolve(specifier, context, nextResolve) {
			const resolved = nextResolve(specifier, context);
			// 代数为 0（尚未发生任何刷新）时保持原始 URL，首次加载不加参数。
			if (generation === 0 || scopes.size === 0) return resolved;
			try {
				const u = new URL(resolved.url);
				if (u.protocol !== "file:" || u.search || !inScope(u)) return resolved;
				resolved.url = `${resolved.url}?${QUERY_KEY}=${generation}`;
			} catch {
				// 非 URL 结果，原样返回。
			}
			return resolved;
		},
	});
}

function inScope(u: URL): boolean {
	for (const scope of scopes.values()) {
		for (const prefix of scope.urlPrefixes) {
			if (u.href.startsWith(prefix)) return true;
		}
	}
	return false;
}

/**
 * 注册一个扩展代码根目录（幂等，可随 cwd/.pi 变化重复调用）：
 * 全局 <agentDir>/extensions、<agentDir>/npm 与项目 <cwd>/.pi/extensions、
 * <cwd>/.pi/npm。目录可能尚不存在（首个项目扩展），此时按字面路径注册，
 * 下次调用会用真实路径覆盖。
 */
export function registerExtensionModuleScope(dir: string): void {
	if (!dir) return;
	registerHooks();
	const resolved = resolve(dir);
	let real = resolved;
	try {
		real = realpathSync(resolved);
	} catch {
		// 目录不存在：仍按字面路径注册，等下次调用再校正。
	}
	// 末尾带 "/"，避免 …/extensions 误匹配 …/extensions-old/…（与 pathPrefix + sep 一致）。
	const urlPrefixes = [`${pathToFileURL(real).href}/`];
	if (real !== resolved) urlPrefixes.push(`${pathToFileURL(resolved).href}/`);
	scopes.set(dir, { pathPrefix: real, urlPrefixes });
}

/**
 * 重建扩展工厂前调用：代数 +1（import 的入口换新 URL）并清空受控目录下的
 * require.cache 条目（require 的 CJS 模块本体换新实例）。
 */
export function bumpExtensionModuleCache(): void {
	generation++;
	if (scopes.size === 0) return;
	let removed = 0;
	for (const key of Object.keys(require.cache)) {
		for (const scope of scopes.values()) {
			if (key === scope.pathPrefix || key.startsWith(scope.pathPrefix + sep)) {
				delete require.cache[key];
				removed++;
				break;
			}
		}
	}
	if (removed > 0) console.debug(`[pi-harness] 扩展模块缓存已刷新（${removed} 个 CJS 条目，代数 ${generation}）。`);
}
