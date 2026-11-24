import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { lazyStream, normalizeContext, type AnyModel, type Api, type AssistantMessageEvent, type Context, type Model, type ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { clampMaxTokensToContext, MIN_ANSWER_TOKENS } from "@earendil-works/pi-ai/api/simple-options";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";

export type OutputLimitSource = "provider" | "user-config" | "inferred";
export interface OutputBudgetMetadata {
	providerCap?: number;
	userConfiguredCap?: number;
	inferred?: boolean;
}
export interface OutputBudgetDecision {
	resolvedBudget: number;
	sdkBudget: number;
	source: OutputLimitSource;
	contextTokens: number;
	override?: "PI_MAX_TOKENS" | "PI_MAX_TOKENS_FLOOR";
	explicit?: boolean;
	fallback?: boolean;
}
export class OutputBudgetError extends Error {
	constructor(readonly code: "context-insufficient" | "explicit-budget-unavailable", readonly decision: OutputBudgetDecision) {
		super(code);
		this.name = "OutputBudgetError";
	}
}
export interface OutputBudgetRuntimeOptions {
	metadata?: (model: Model<Api>) => OutputBudgetMetadata | undefined;
	reserveAutomaticAction?: (model: Model<Api>, options?: ModelsSimpleStreamOptions) => boolean;
	onBudget?: (model: Model<Api>, decision: OutputBudgetDecision, options?: ModelsSimpleStreamOptions) => void;
}

const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export function outputTokenLimit(maxTokens: number, contextWindow: number, env: NodeJS.ProcessEnv = process.env): number {
	if (env.PI_MAX_TOKENS === undefined && env.PI_MAX_TOKENS_FLOOR !== undefined) {
		const floor = Number(env.PI_MAX_TOKENS_FLOOR);
		return Number.isSafeInteger(floor) && floor > 0 ? Math.max(maxTokens, Math.min(floor, contextWindow)) : maxTokens;
	}
	const limit = Number(env.PI_MAX_TOKENS);
	return Number.isSafeInteger(limit) && limit > 0 ? Math.min(maxTokens, limit, contextWindow) : maxTokens;
}

function capabilities(model: Model<Api>, metadata?: OutputBudgetMetadata): { source: OutputLimitSource; cap: number } {
	const caps = [metadata?.providerCap, metadata?.userConfiguredCap].filter(positive);
	if (metadata?.inferred && !caps.length) return { source: "inferred", cap: 8192 };
	if (caps.length) {
		return {
			source: metadata?.userConfiguredCap !== undefined ? "user-config" : "provider",
			cap: Math.min(...caps),
		};
	}
	return positive(model.maxTokens) ? { source: "provider", cap: model.maxTokens } : { source: "inferred", cap: 8192 };
}

export function resolveOutputBudget(
	model: Model<Api>,
	context: Context,
	metadata: OutputBudgetMetadata | undefined,
	env: NodeJS.ProcessEnv = process.env,
	explicitMaxTokens?: number,
	fallback = false,
): OutputBudgetDecision {
	const transcript = normalizeContext(context);
	const contextTokens = estimateContextTokens(transcript).tokens;
	const capability = capabilities(model, metadata);
	let resolvedBudget = fallback ? Math.min(capability.cap, 4096) : capability.cap;
	let override: OutputBudgetDecision["override"];
	const explicit = explicitMaxTokens !== undefined;
	if (explicit) {
		if (!positive(explicitMaxTokens) || capability.source !== "inferred" && explicitMaxTokens > capability.cap) {
			const decision = { resolvedBudget: explicitMaxTokens, sdkBudget: 0, source: capability.source, contextTokens, explicit: true };
			throw new OutputBudgetError("explicit-budget-unavailable", decision);
		}
		resolvedBudget = explicitMaxTokens;
	} else if (!fallback) {
		if (env.PI_MAX_TOKENS === undefined && env.PI_MAX_TOKENS_FLOOR !== undefined) {
			const floor = Number(env.PI_MAX_TOKENS_FLOOR);
			if (Number.isSafeInteger(floor) && floor > 0) {
				resolvedBudget = Math.max(resolvedBudget, floor);
				override = "PI_MAX_TOKENS_FLOOR";
			}
		} else {
			const limit = Number(env.PI_MAX_TOKENS);
			if (Number.isSafeInteger(limit) && limit > 0) {
				resolvedBudget = Math.min(resolvedBudget, limit);
				override = "PI_MAX_TOKENS";
			}
		}
	}
	const sdkBudget = clampMaxTokensToContext(model, transcript, resolvedBudget);
	const decision: OutputBudgetDecision = { resolvedBudget, sdkBudget, source: capability.source, contextTokens, override, explicit, fallback };
	if (explicit && (sdkBudget !== explicitMaxTokens || sdkBudget < MIN_ANSWER_TOKENS)) throw new OutputBudgetError("explicit-budget-unavailable", decision);
	if (!explicit && sdkBudget < MIN_ANSWER_TOKENS) throw new OutputBudgetError("context-insufficient", decision);
	return decision;
}

export function isInvalidOutputBudgetError(message: string): boolean {
	if (/context(?:\s|_)*(?:length|window)|input tokens|prompt tokens/i.test(message)) return false;
	return /max_tokens|max_output_tokens|max_completion_tokens|maxTokens|maximum output tokens?|output token limit/i.test(message)
		&& /invalid|unsupported|too large|too many|exceed(?:s|ed)?|greater than|above|at most|maximum of/i.test(message);
}

function hasConsumableOutput(event: AssistantMessageEvent): boolean {
	if (event.type === "done" || event.type === "error") return (event.type === "done" ? event.message : event.error).content.length > 0;
	return event.type === "text_delta" || event.type === "thinking_delta" || event.type.startsWith("toolCall");
}

function invalidBudgetMessage(event: AssistantMessageEvent): string | undefined {
	if (event.type !== "error") return undefined;
	const message = event.error.errorMessage ?? "";
	return isInvalidOutputBudgetError(message) ? message : undefined;
}

const wrapped = new WeakSet<ModelRuntime>();
const reasoningWrapped = new WeakSet<ModelRuntime>();

export function withOutputTokenFloor(runtime: ModelRuntime, env: NodeJS.ProcessEnv = process.env, options: OutputBudgetRuntimeOptions = {}): ModelRuntime {
	if (wrapped.has(runtime)) return runtime;
	const model = <T extends AnyModel | undefined>(value: T): T => {
		if (!value || (value.type && value.type !== "chat") || !("maxTokens" in value)) return value;
		const maxTokens = outputTokenLimit(value.maxTokens, value.contextWindow, env);
		return maxTokens === value.maxTokens ? value : { ...value, maxTokens };
	};
	const single = new Set(["getModel", "getModelOfType", "getPhysicalModel"]);
	const lists = new Set(["getModels", "getModelsOfType", "getAllModels", "getAvailableSnapshot"]);
	const asyncLists = new Set(["getAvailable", "getAvailableOfType", "getAllAvailable"]);
	const streamRequest = (key: "stream" | "streamSimple", requested: Model<Api>, context: Context, rawOptions?: ModelsSimpleStreamOptions): ReturnType<ModelRuntime["streamSimple"]> => {
		return lazyStream(requested, async () => {
			let physical = requested;
			let requestOptions = rawOptions;
			if (key === "streamSimple" && requested.api === "pi-virtual") {
				const route = await runtime.resolveModel(requested, normalizeContext(context).messages, {
					reason: "direct", thinkingLevel: rawOptions?.reasoning ?? "off", signal: rawOptions?.signal,
				});
				physical = route.model;
				requestOptions = { ...rawOptions, reasoning: route.thinkingLevel === "off" ? undefined : route.thinkingLevel };
			}
			const metadata = options.metadata?.(physical);
			const decision = resolveOutputBudget(physical, context, metadata, env, requestOptions?.maxTokens);
			options.onBudget?.(physical, decision, requestOptions);
			const invoke = (maxTokens: number): ReturnType<ModelRuntime["streamSimple"]> => Reflect.apply(runtime[key], runtime, [physical, context, { ...requestOptions, maxTokens }]);
			const retryable = decision.source === "inferred" && !decision.explicit && !decision.fallback;
			return (async function* () {
				let retried = false, produced = false;
				for await (const event of invoke(decision.sdkBudget)) {
					if (retryable && !retried && !produced && invalidBudgetMessage(event)) {
						retried = true;
						const allowed = !requestOptions?.signal?.aborted && (options.reserveAutomaticAction?.(physical, requestOptions) ?? false) && !requestOptions?.signal?.aborted;
						if (allowed) {
							const fallback = resolveOutputBudget(physical, context, metadata, env, undefined, true);
							options.onBudget?.(physical, fallback, requestOptions);
							for await (const retryEvent of invoke(fallback.sdkBudget)) yield retryEvent;
							return;
						}
					}
					if (hasConsumableOutput(event)) produced = true;
					yield event;
				}
			})();
		}, undefined, rawOptions?.signal);
	};
	const facade = new Proxy(runtime, {
		get(target, key) {
			const value = Reflect.get(target, key, target);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				if (key === "stream" || key === "streamSimple") return streamRequest(key, args[0] as Model<Api>, args[1] as Context, args[2] as ModelsSimpleStreamOptions | undefined);
				if (key === "complete") return streamRequest("stream", args[0] as Model<Api>, args[1] as Context, args[2] as ModelsSimpleStreamOptions | undefined).result();
				if (key === "completeSimple") return streamRequest("streamSimple", args[0] as Model<Api>, args[1] as Context, args[2] as ModelsSimpleStreamOptions | undefined).result();
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

export function withReasoningEnabled(runtime: ModelRuntime): ModelRuntime {
	if (reasoningWrapped.has(runtime)) return runtime;
	const enable = <T extends AnyModel | undefined>(value: T): T => !value || (value.type && value.type !== "chat") || value.reasoning ? value : { ...value, reasoning: true };
	const single = new Set(["getModel", "getModelOfType", "getPhysicalModel"]);
	const lists = new Set(["getModels", "getModelsOfType", "getAllModels", "getAvailableSnapshot"]);
	const asyncLists = new Set(["getAvailable", "getAvailableOfType", "getAllAvailable"]);
	const requests = new Set(["stream", "complete", "streamSimple", "completeSimple"]);
	const facade = new Proxy(runtime, {
		get(target, key) {
			const value = Reflect.get(target, key, target);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				if (requests.has(String(key))) args[0] = enable(args[0] as AnyModel);
				const result = Reflect.apply(value, target, args);
				if (single.has(String(key))) return enable(result as AnyModel | undefined);
				if (lists.has(String(key))) return (result as AnyModel[]).map(enable);
				if (asyncLists.has(String(key))) return (result as Promise<AnyModel[]>).then((items: AnyModel[]) => items.map(enable));
				if (key === "resolveModel") return (result as Promise<{ model: AnyModel }>).then((route: { model: AnyModel }) => ({ ...route, model: enable(route.model) }));
				return result;
			};
		},
	});
	reasoningWrapped.add(facade);
	return facade;
}
