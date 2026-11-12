import { resolve } from "node:path";
import { SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { CacheWarmingMode, UiCacheWarming } from "./protocol.js";

const sessions = new Map<AgentSession, { agentDir: string; changed: () => void }>();
const changes = new Map<string, Promise<void>>();

/** Project settings cannot enable paid warming. Keep an explicit native global choice. */
export function cacheWarmingSettings(settings: SettingsManager): SettingsManager {
	const nativeMode = settings.getCacheWarmingMode.bind(settings);
	settings.getCacheWarmingMode = () => settings.getGlobalSettings().cacheWarming === undefined ? "streaming" : nativeMode();
	return settings;
}

/** Lifecycle registration also covers background/Wiki/SSH sessions and native replacements. */
export async function bindCacheWarming(session: AgentSession, agentDir: string, changed: () => void): Promise<void> {
	if (sessions.has(session)) return;
	const directory = resolve(agentDir);
	sessions.set(session, { agentDir: directory, changed });
	const dispose = session.dispose.bind(session);
	session.dispose = () => { sessions.delete(session); dispose(); };
	const before = session.settingsManager.getCacheWarmingMode();
	await changes.get(directory)?.catch(() => {});
	await session.settingsManager.reload();
	if (sessions.has(session) && before !== session.settingsManager.getCacheWarmingMode()) {
		session.setCacheWarmingMode(session.settingsManager.getCacheWarmingMode());
		await session.settingsManager.flush();
	}
}

/** Native settings persistence and native session setters remain the only writers/scheduler. */
export function setGlobalCacheWarming(agentDir: string, mode: CacheWarmingMode): Promise<void> {
	if (!["off", "streaming", "idle"].includes(mode)) return Promise.reject(new Error("Invalid cache warming mode"));
	const directory = resolve(agentDir);
	const previous = changes.get(directory) ?? Promise.resolve();
	const operation = previous.catch(() => {}).then(async () => {
		const settings = SettingsManager.create(directory, directory);
		settings.setCacheWarmingMode(mode);
		await settings.flush();
		const errors = settings.drainErrors();
		if (errors.length) throw new Error("无法保存缓存预热设置 / Could not save cache warming settings");
		await Promise.all([...sessions].filter(([, item]) => item.agentDir === directory).map(async ([session, item]) => {
			await session.settingsManager.reload();
			if (!sessions.has(session)) return;
			session.setCacheWarmingMode(mode);
			await session.settingsManager.flush();
			item.changed();
		}));
	});
	changes.set(directory, operation);
	void operation.finally(() => { if (changes.get(directory) === operation) changes.delete(directory); }).catch(() => {});
	return operation;
}

/** Native usage entries include all branches, matching getSessionStats() session accounting. */
export function cacheWarmingView(session: AgentSession): UiCacheWarming {
	const status = session.cacheWarmingStatus;
	let cost = 0;
	for (const entry of session.sessionManager.getEntries()) {
		if (entry.type === "usage" && entry.kind === "cache_warm") cost += entry.usage.cost.total;
	}
	return { mode: session.settingsManager.getCacheWarmingMode(), state: status?.state ?? "inactive", reason: status?.reason, nextWarmAt: status?.nextWarmAt, cost };
}
