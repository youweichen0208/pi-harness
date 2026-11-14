import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AnyModel } from "@earendil-works/pi-ai";

export function outputTokenLimit(maxTokens: number, contextWindow: number, env: NodeJS.ProcessEnv = process.env): number {
	// Preserve explicitly configured legacy floors; the new override takes precedence.
	if (env.PI_MAX_TOKENS === undefined && env.PI_MAX_TOKENS_FLOOR !== undefined) {
		const floor = Number(env.PI_MAX_TOKENS_FLOOR);
		return Number.isSafeInteger(floor) && floor > 0 ? Math.max(maxTokens, Math.min(floor, contextWindow)) : maxTokens;
	}
	const limit = Number(env.PI_MAX_TOKENS ?? 128000);
	return Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, contextWindow) : maxTokens;
}

const wrapped = new WeakSet<ModelRuntime>();
/** A public-API facade: leave SDK providers, credentials and source files untouched.
 * Project effective limits on reads and requests, including models restored before
 * a reload. Explicit per-call budgets (e.g. compaction) remain authoritative.
 */
export function withOutputTokenFloor(runtime: ModelRuntime, env: NodeJS.ProcessEnv = process.env): ModelRuntime {
	if (wrapped.has(runtime)) return runtime;
	const model = <T extends AnyModel | undefined>(value: T): T => {
		if (!value || (value.type && value.type !== "chat") || !("maxTokens" in value)) return value;
		const maxTokens = outputTokenLimit(value.maxTokens, value.contextWindow, env);
		return maxTokens === value.maxTokens ? value : { ...value, maxTokens };
	};
	const single = new Set(["getModel", "getModelOfType", "getPhysicalModel"]);
	const lists = new Set(["getModels", "getModelsOfType", "getAllModels", "getAvailableSnapshot"]);
	const asyncLists = new Set(["getAvailable", "getAvailableOfType", "getAllAvailable"]);
	const requests = new Set(["stream", "complete", "streamSimple", "completeSimple"]);
	const facade = new Proxy(runtime, {
		get(target, key) {
			const value = Reflect.get(target, key, target);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				if (requests.has(String(key))) args[0] = model(args[0] as AnyModel);
				const result = Reflect.apply(value, target, args);
				if (single.has(String(key))) return model(result as AnyModel | undefined);
				if (lists.has(String(key))) return (result as AnyModel[]).map(model);
				if (asyncLists.has(String(key))) return (result as Promise<AnyModel[]>).then((items: AnyModel[]) => items.map(model));
				if (key === "resolveModel") return (result as Promise<{ model: AnyModel }>).then((route: { model: AnyModel }) => ({ ...route, model: model(route.model) }));
				return result;
			};
		},
	});
	wrapped.add(facade);
	return facade;
}
