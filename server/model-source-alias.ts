import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";

/** Preserve native provider/model identities without lending a key to unrelated models.
 * Each fallback forwards through its own authenticated runtime provider. The marker
 * only satisfies SDK admission and is never sent to an upstream endpoint.
 */
export function registerSourceAliases(runtime: ModelRuntime, aliases: { provider: string; target: Model<Api> }[]): Map<string, Provider | undefined> {
	const originals = new Map<string, Provider | undefined>();
	for (const provider of new Set(aliases.map(a => a.provider))) {
		const targets = new Map(aliases.filter(a => a.provider === provider).map(a => [a.target.id, a.target]));
		const original = runtime.getProvider(provider);
		const nativeConfigured = runtime.hasConfiguredAuth(provider);
		const available = new Set(runtime.getAvailableSnapshot().filter(m => m.provider === provider).map(m => m.id));
		originals.set(provider, runtime.getRegisteredNativeProvider(provider));
		const models = [...(original?.getModels() ?? []).filter(m => !targets.has(m.id)), ...[...targets.values()].map(m => ({ ...m, provider }))];
		const auth = original?.auth.apiKey;
		runtime.registerNativeProvider({
			...original,
			id: provider, name: original?.name ?? provider,
			auth: { ...original?.auth, apiKey: {
				...auth, name: auth?.name ?? "Synced model alias",
				check: async () => ({ configured: true, type: "api_key", source: "synced alias" }),
				resolve: async input => await auth?.resolve(input) ?? { auth: { apiKey: "pi-harness-alias" }, source: "synced alias" },
			} },
			getModels: () => models,
			getAllModels: () => [...(original?.getAllModels?.() ?? []).filter(m => m.type && m.type !== "chat"), ...models],
			filterModels: listed => listed.filter(m => targets.has(m.id) || available.has(m.id)),
			filterAllModels: listed => listed.filter(m => (!m.type || m.type === "chat") ? targets.has(m.id) || available.has(m.id) : nativeConfigured),
			stream: (model, context, options) => {
				const target = targets.get(model.id);
				if (!target) return original!.stream(model, context, options);
				const { apiKey: _key, headers: _headers, env: _env, ...rest } = options ?? {};
				return runtime.stream(target, context, rest);
			},
			streamSimple: (model, context, options) => {
				const target = targets.get(model.id);
				if (!target) return original!.streamSimple(model, context, options);
				const { apiKey: _key, headers: _headers, env: _env, ...rest } = options ?? {};
				return runtime.streamSimple(target, context, rest);
			},
		});
	}
	return originals;
}
