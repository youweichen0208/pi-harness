/** Bun-only host operations absent from OMP's public RPC command catalogue. */
import { SessionManager, type AgentSession } from "@oh-my-pi/pi-coding-agent";
import { RpcFrameEncoder } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame";
import * as AIError from "@oh-my-pi/pi-ai/error";
import lockfile from "proper-lockfile";
import { createHash } from "node:crypto";
import { YAML } from "bun";
import { readFileSync, existsSync, unlinkSync, realpathSync } from "node:fs";
import { writeFileAtomic } from "../private-file.js";
import { mergeChatProvider, isChatModelConfig, readModelCompat } from "../model-config-merge.js";
import type { UiProviderConfig } from "../protocol.js";
import { basename, dirname, join, relative, isAbsolute } from "node:path";
import { isRecord } from "./framing.js";
import type { OmpBootstrap } from "./bootstrap.js";
import { cfgTreeFilterMode } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { treeMetadata } from "./tree-metadata.js";
import { hasProjectedMessage } from "./presentation.js";
import { nativeEntryMessage } from "./native-messages.js";
import { nativeTree } from "./tree-native.js";
import { OmpRecovery } from "./recovery.js";
import { cloneModelProvider, mergeDiscoveredModels, modelConfigView, ModelCatalogError, probeModelCatalog } from "./model-catalog.js";
import { OmpHistoryMetadata } from "./history-metadata.js";
import { OmpTaskHistory } from "./task-history.js";
import { skillSettingsView, saveSkillSettings, SkillSettingsError } from "./skill-settings.js";
import { OmpMcpControl, OmpMcpError } from "./mcp-control.js";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { OmpExtensionSettings, OmpExtensionError } from "./extension-settings.js";
import { OmpPromptControl, OmpPromptError } from "./prompt-control.js";
import { OmpPersistence, writesSession } from "./persistence.js";
import type { OmpSessionStorage } from "./session-storage.js";
import { OmpPersistenceJournal } from "./persistence-journal.js";
import { transcriptEntryMessage } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import { createBranchSummaryMessage, createCompactionSummaryMessage } from "@oh-my-pi/pi-agent-core/compaction/messages";

export async function hostControlInput(input: ReadableStream<Uint8Array>, session: AgentSession, bootstrap: OmpBootstrap, manager?: MCPManager, storage?: OmpSessionStorage): Promise<ReadableStream<Uint8Array>> {
	const encoder = new RpcFrameEncoder(); encoder.setProtocolVersion(2);
	const persistence = new OmpPersistence(session, state => process.stdout.write(encoder.encode({ type: "harness_persistence", persistence: state })), storage?.guard, new OmpPersistenceJournal(dirname(bootstrap.agentDir)));
	const monitor = setInterval(() => { if (!stopping && !persistence.failed) { try { storage?.checkSession(session.sessionFile, session.sessionManager.getSessionId(), true); } catch { /* The guard already emitted the failure. */ } } }, 1000);
	monitor.unref();
	let stopping = false;
	const recovery = new OmpRecovery(state => process.stdout.write(encoder.encode({ type: "harness_recovery", recovery: state })));
	const unsubscribeRecovery = session.subscribe(event => {
		recovery.observe(event);
		if (!stopping && event.type === "message_end" && event.message.role === "assistant" && AIError.is(event.message.errorId, AIError.Flag.ThinkingLoop)) {
			// This must happen inside the native subscriber, before its queue drain
			// or retry can start another request. A host RPC round trip is too late.
			stopping = true;
			session.clearQueue({ forInterrupt: true });
			void session.abort({ reason: "Model output repetition interrupted by host" }).catch(() => {});
			process.stdout.write(encoder.encode({ type: "harness_model_loop" }));
		}
	});
	const taskHistory = new OmpTaskHistory();
	const historyMetadata = new OmpHistoryMetadata();
	const scanTasks = () => taskHistory.scan(session.sessionFile, session.sessionManager.getBranch().flatMap((entry): unknown[] => entry.type === "message" ? [entry.message] : entry.type === "custom_message" ? [{ ...entry, role: "custom" }] : []));
	const bytes = new TextEncoder();
	let buffer = "";
	let controlTail = Promise.resolve();
	let mutations = 0;
	const mcp = new OmpMcpControl(session, manager, () => stopping);
	await mcp.initialize();
	const extensions = new OmpExtensionSettings(session, () => stopping);
	const prompts = new OmpPromptControl(session, bootstrap.agentDir, () => stopping);
	if (!bootstrap.restricted) await prompts.markLoaded();
	let loadedSkills = skillSettingsView(session).version;
	const modelsPath = join(bootstrap.agentDir, "models.yml");
	const fingerprint = () => createHash("sha256").update(existsSync(modelsPath) ? readFileSync(modelsPath) : "").digest("hex");
	let loaded = fingerprint();
	let loadedCredentials = session.modelRegistry.authStorage.credentials.generation;
	const acquire = () => lockfile.lock(modelsPath, { realpath: false, stale: 30000, retries: { retries: 40, minTimeout: 20, maxTimeout: 200 } });
	const syncModels = async () => {
		await session.modelRegistry.authStorage.credentials.poll();
		const generation = session.modelRegistry.authStorage.credentials.generation;
		const current = fingerprint();
		if (current === loaded && generation === loadedCredentials) return;
		await session.modelRegistry.refresh("offline");
		if (session.modelRegistry.getError()) throw Error("Invalid model configuration");
		await session.refreshScopedModels();
		const selected = session.model;
		const replacement = selected && session.getAvailableModels().find(model => model.provider === selected.provider && model.id === selected.id);
		if (replacement) await session.setModel(replacement, "default", { persist: false });
		loaded = current; loadedCredentials = generation;
	};
	const readModels = () => {
		const value: unknown = existsSync(modelsPath) ? YAML.parse(readFileSync(modelsPath, "utf8")) : {};
		if (!isRecord(value) || (value.providers !== undefined && !isRecord(value.providers))) throw Error("Invalid OMP models configuration");
		return value;
	};
	const saveModels = async (value: Record<string, unknown>) => {
		const previous = existsSync(modelsPath) ? readFileSync(modelsPath, "utf8") : undefined;
		writeFileAtomic(modelsPath, YAML.stringify(value));
		try { await session.modelRegistry.refresh("offline"); if (session.modelRegistry.getError()) throw Error("Invalid model configuration"); }
		catch (error) { if (previous !== undefined) writeFileAtomic(modelsPath, previous); else unlinkSync(modelsPath); await session.modelRegistry.refresh("offline"); throw error; }
	};
	const decoder = new TextDecoder();
	return input.pipeThrough(new TransformStream<Uint8Array, string>({
		transform(chunk, controller) { controller.enqueue(decoder.decode(chunk, { stream: true })); },
		flush(controller) { controller.enqueue(decoder.decode()); },
	})).pipeThrough(new TransformStream<string, Uint8Array>({
		transform(chunk, controller) {
			buffer += chunk;
			if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) throw Error("Host input too large");
			let index: number;
			while ((index = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
				let frame: unknown;
				try { frame = JSON.parse(line); } catch { controller.enqueue(bytes.encode(line + "\n")); continue; }
				if (isRecord(frame) && typeof frame.type === "string" && writesSession(frame.type)) {
					try { storage?.checkSession(session.sessionFile, session.sessionManager.getSessionId()); } catch { /* The following guard rejects this command. */ }
				}
				if (persistence.failed && isRecord(frame) && typeof frame.type === "string" && writesSession(frame.type)) {
					process.stdout.write(encoder.encode({ type: "response", id: frame.id, command: frame.type, success: false, error: "OMP session persistence failed; reopen saved history explicitly" }));
					continue;
				}
				if (isRecord(frame) && frame.type === "harness_prepare_stop") {
					stopping = true; void mcp.dispose();
					session.clearQueue({ forInterrupt: true });
					session.abortCompaction(); session.abortRetry(); session.abortBranchSummary();
					process.stdout.write(encoder.encode({ type: "response", id: frame.id, command: frame.type, success: true }));
					continue;
				}
				if (stopping && isRecord(frame) && ["prompt", "steer", "follow_up", "fork", "branch", "navigate_tree", "new_session", "switch_session"].includes(String(frame.type))) {
					process.stdout.write(encoder.encode({ type: "response", id: frame.id, command: frame.type, success: false, error: "OMP session is stopping" }));
					continue;
				}
				if (isRecord(frame) && frame.type === "harness_cancel_recovery") {
					const cancelled = typeof frame.operationId === "string" && recovery.cancel(frame.operationId, session);
					process.stdout.write(encoder.encode({ type: "response", id: frame.id, command: frame.type, success: true, data: { cancelled } }));
					continue;
				}
				if (!isRecord(frame) || typeof frame.type !== "string" || !frame.type.startsWith("harness_")) {
					if ((mutations > 0 || mcp.auth.active) && isRecord(frame) && ["prompt", "steer", "follow_up", "set_model", "set_thinking_level", "fork", "branch", "navigate_tree", "new_session", "switch_session"].includes(String(frame.type))) process.stdout.write(encoder.encode({ type: "response", id: frame.id, command: frame.type, success: false, error: "OMP configuration operation in progress" }));
					else controller.enqueue(bytes.encode(line + "\n"));
					continue;
				}
				const command = frame;
				const mutating = frame.type === "harness_extensions" && ["save", "toggle", "save-file"].includes(String(frame.action)) || frame.type === "harness_prompt" && ["save", "delete", "reload"].includes(String(frame.action)) || frame.type === "harness_mcp" && ["save", "reload", "reconnect", "login", "logout", "auth_input", "auth_cancel"].includes(String(frame.action)) || ["harness_sync_skills", "harness_save_skills", "harness_reload", "harness_sync_models", "harness_save_provider", "harness_refresh_provider", "harness_delete_provider", "harness_set_key", "harness_clear_key", "harness_logout", "harness_rename_session", "harness_cwd_event"].includes(frame.type);
				if (mutating) mutations++;
				controlTail = controlTail.then(async () => {
				const frame = command;
				try {
					if (writesSession(String(frame.type))) storage?.checkSession(session.sessionFile, session.sessionManager.getSessionId());
					if (mcp.auth.active && mutating && !["harness_sync_skills", "harness_sync_models"].includes(frame.type as string) && !(frame.type === "harness_mcp" && ["auth_cancel", "auth_input"].includes(String(frame.action)))) throw new OmpMcpError("Complete or cancel MCP OAuth first");
					let data: unknown;
					switch (frame.type) {
						case "harness_extensions":
							if (bootstrap.restricted || stopping) throw new OmpExtensionError("Extension management unavailable");
							if (frame.action === "get") data = await extensions.get();
							else if (frame.action === "save") data = await extensions.save(frame.version, frame.patch);
							else if (frame.action === "toggle") data = await extensions.toggle(frame.version, frame.moduleId, frame.enabled);
							else if (frame.action === "read-file") data = await extensions.readSource(frame.moduleId);
							else if (frame.action === "save-file") data = await extensions.saveSource(frame.moduleId, frame.version, frame.content);
							else throw new OmpExtensionError("Unknown extension operation");
							break;
						case "harness_prompt":
							if (bootstrap.restricted || stopping) throw new OmpPromptError("Prompt management unavailable");
							if (frame.action === undefined || frame.action === "get") data = await prompts.get();
							else if (frame.action === "read") data = await prompts.read(frame.fileId);
							else if (frame.action === "save" || frame.action === "delete") data = await prompts.save(frame.fileId, frame.version, frame.content, frame.action === "delete");
							else if (frame.action === "reload") data = await prompts.reload();
							else throw new OmpPromptError("Unknown prompt operation");
							break;
						case "harness_mcp": {
							if (bootstrap.restricted) throw new OmpMcpError("MCP management is unavailable in restricted sessions");
							if (frame.action === "get") data = await mcp.get(frame.scope);
							else if (frame.action === "status") data = await mcp.status();
							else if (frame.action === "save") data = await mcp.save(frame.scope, frame.version, frame.document);
							else if (frame.action === "reload") data = await mcp.reload();
							else if (frame.action === "reconnect") data = await mcp.reconnect(frame.name);
							else if (frame.action === "login" || frame.action === "logout" || frame.action === "auth_cancel" || frame.action === "auth_input") {
								if (stopping) throw new OmpMcpError("MCP worker stopping");
								if (frame.action === "login") await mcp.auth.login(frame.name);
								else if (frame.action === "logout") await mcp.auth.logout(frame.name);
								else if (frame.action === "auth_cancel") await mcp.auth.cancel(frame.authId);
								else mcp.auth.input(frame.authId, frame.value);
								data = await mcp.status();
							}
							else throw new OmpMcpError("Unknown MCP management action");
							break;
						}
						case "harness_recall_queue": {
							// Reject before mutation; never truncate a recalled image or text.
							const queued = [...session.agent.peekSteeringQueue(), ...session.agent.peekFollowUpQueue()];
							if (Buffer.byteLength(JSON.stringify(queued)) > 16 * 1024 * 1024) throw Error("Queue recall exceeds transfer limit");
							data = session.clearQueue(); break;
						}
						case "harness_sync_models": {
							if (session.isStreaming) { data = { deferred: true }; break; }
							const release = await acquire();
							try { await syncModels(); data = {}; } finally { await release(); } break;
						}
						case "harness_sync_skills": {
							if (bootstrap.restricted || stopping || session.isStreaming) { data = { deferred: true }; break; }
							await session.settings.reloadFromDisk();
							const version = skillSettingsView(session).version;
							if (version !== loadedSkills) await session.refreshSkillsAndCommands();
							loadedSkills = version; data = {}; break;
						}
						case "harness_reload": if (session.isStreaming) throw Error("Session busy"); await session.reload(); data = {}; break;
						case "harness_tree_snapshot":
							data = { entries: session.sessionManager.getEntries(), leafId: session.sessionManager.getLeafId(), sessionId: session.sessionManager.getSessionId() }; break;
						case "harness_tree":
							data = nativeTree(session.sessionManager, frame.filter, frame.query, typeof frame.previewTarget === "string" ? frame.previewTarget : undefined); break;
						case "harness_history": {
							// The model context may omit failed/truncated turns and compacted
							// history. The UI displays the native branch, never reconstructs
							// model input from this transcript or writes it back to the SDK.
							const allEntries = session.sessionManager.getEntries();
							const displayed = new Set(allEntries.filter(entry => entry.type === "compaction" || entry.type === "branch_summary" || hasProjectedMessage(nativeEntryMessage(entry))).map(entry => entry.id));
							const metadata = treeMetadata(allEntries, session.sessionManager.getLeafId(), session.sessionManager.getSessionId(), displayed);
							const tree = { revision: metadata.revision, leafId: metadata.leafId, branchPoints: metadata.branchPoints, rootCount: metadata.rootCount, filterMode: cfgTreeFilterMode.get(session.settings), skipSummaryPrompt: false };
							const entries = session.sessionManager.getBranch();
							const cwdEvents = entries.flatMap(entry => {
								if (entry.type !== "custom" || entry.customType !== "pi-harness.cwd" || !isRecord(entry.data) || entry.data.cwd !== bootstrap.cwd) return [];
								const timestamp = Date.parse(entry.timestamp);
								return Number.isFinite(timestamp) ? [{ cwd: bootstrap.cwd, timestamp }] : [];
							});
							const branch = entries.flatMap(entry => {
								const message = entry.type === "message" || entry.type === "custom_message" ? transcriptEntryMessage(entry)
									: entry.type === "compaction" ? createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp)
										: entry.type === "branch_summary" ? createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp) : undefined;
								return message ? [{ id: entry.id, message, label: metadata.labels.get(entry.id), siblings: metadata.siblings.get(entry.id) }] : [];
							});
							const tasks = await scanTasks();
							data = { tree, messageTree: branch.map(entry => ({ label: entry.label, siblings: entry.siblings })), persistence: persistence.snapshot(), mcpAuthPending: mcp.auth.active, cwdEvents, messages: branch.map(entry => entry.message), entryIds: branch.map(entry => entry.id), tasks, stats: session.getSessionStats(), thinkingLevels: session.getAvailableThinkingLevels(), recovery: recovery.snapshot(), runSettings: { autoCompaction: session.autoCompactionEnabled, autoRetry: session.autoRetryEnabled } }; break;
						}
						case "harness_cwd_event":
							if (bootstrap.restricted || stopping) throw Error("Workspace events unavailable");
							// Custom entries are native history metadata, never model messages.
							session.sessionManager.appendCustomEntry("pi-harness.cwd", { cwd: bootstrap.cwd });
							await session.sessionManager.flush();
							if (persistence.failed) throw Error("Workspace event persistence failed");
							data = {}; break;
						case "harness_task_history": {
							await scanTasks();
							data = await taskHistory.page(frame.handle, frame.cursor); break;
						}
						case "harness_list_sessions":
							data = { sessions: await historyMetadata.list(await SessionManager.list(bootstrap.cwd, bootstrap.sessionDir)) };
							break;
						case "harness_models_config": {
							const config = readModels();
							data = { providers: Object.entries(isRecord(config.providers) ? config.providers : {}).flatMap(([providerId, raw]) => {
								if (!isRecord(raw)) return [];
								const safe: Record<string, unknown> = { providerId };
								safe.nonChatModelCount = Array.isArray(raw.models) ? raw.models.filter(model => isRecord(model) && !isChatModelConfig(model)).length : 0;
								for (const key of ["name", "api", "baseUrl"]) if (typeof raw[key] === "string") safe[key] = raw[key];
								if (typeof raw.authHeader === "boolean") safe.authHeader = raw.authHeader;
								safe.compat = readModelCompat(raw.compat);
								safe.models = Array.isArray(raw.models) ? raw.models.flatMap(model => {
									if (!isRecord(model) || !isChatModelConfig(model) || typeof model.id !== "string") return [];
									const view: Record<string, unknown> = { id: model.id, compat: readModelCompat(model.compat) };
									if (typeof model.name === "string") view.name = model.name;
									if (typeof model.reasoning === "boolean") view.reasoning = model.reasoning;
									if (Array.isArray(model.input)) view.input = model.input.filter(value => value === "text" || value === "image");
									for (const key of ["contextWindow", "maxTokens"]) if (typeof model[key] === "number" && Number.isFinite(model[key])) view[key] = model[key];
									return [view];
								}) : [];
								return [safe];
							}) }; break;
						}
						case "harness_fetch_models": data = { models: await probeModelCatalog(frame) }; break;
						case "harness_clone_provider": {
							const config = readModels();
							data = { config: cloneModelProvider(session.modelRegistry, frame.provider, isRecord(config.providers) ? config.providers : {}) }; break;
						}
						case "harness_refresh_provider": {
							if (session.isBusyForSnapshot) throw new ModelCatalogError("请等待当前任务结束后刷新模型");
							if (typeof frame.providerId !== "string" || !/^[a-zA-Z0-9_.-]{1,120}$/.test(frame.providerId) || ["__proto__", "constructor", "prototype"].includes(frame.providerId)) throw new ModelCatalogError("服务商 ID 无效");
							const release = await acquire();
							try {
								await syncModels();
								const config = readModels(), providers = isRecord(config.providers) ? config.providers : {};
								const saved = providers[frame.providerId];
								if (!isRecord(saved)) throw new ModelCatalogError("已保存的服务商不存在");
								const registry = session.modelRegistry;
								let discovered;
								if (registry.getDiscoveryProviderId(frame.providerId)) {
									await registry.refreshDiscoverableProviders([frame.providerId], "online");
									const state = registry.getProviderDiscoveryState(frame.providerId);
									if (state?.error || state?.status !== "ok") throw new ModelCatalogError("OMP 原生模型发现未成功，请检查服务商配置与认证");
									discovered = registry.getAll().filter(model => model.provider === frame.providerId).map(modelConfigView);
								} else {
									const apiKey = saved.authHeader === false ? undefined : await registry.getApiKeyForProvider(frame.providerId);
									discovered = await probeModelCatalog({ ...saved, apiKey }, await registry.getProviderHeaders(frame.providerId));
								}
								if (!discovered.length) throw new ModelCatalogError("服务商未返回可用聊天模型");
								const merged = mergeDiscoveredModels(saved, discovered);
								await saveModels({ ...config, providers: { ...providers, [frame.providerId]: merged.config } });
								await syncModels(); data = { added: merged.added, total: merged.total };
							} finally { await release(); } break;
						}
						case "harness_save_provider": case "harness_delete_provider": case "harness_set_key": case "harness_clear_key": case "harness_logout": {
							if (session.isStreaming) throw Error("Session is busy");
							if (typeof frame.providerId !== "string" || !/^[a-zA-Z0-9_-]{1,120}$/.test(frame.providerId) || ["__proto__", "constructor", "prototype"].includes(frame.providerId)) throw Error("Invalid provider ID");
							const release = await acquire();
							try {
							const config = readModels(), providers = { ...(isRecord(config.providers) ? config.providers : {}) };
							const existing = providers[frame.providerId];
							const old = isRecord(existing) ? existing : {};
							const credentials = session.modelRegistry.authStorage.credentials;
							if (frame.type === "harness_clear_key" || frame.type === "harness_logout") {
								await credentials.reload();
								for (const row of credentials.list(frame.providerId)) if (row.credential.type === (frame.type === "harness_logout" ? "oauth" : "api_key")) await credentials.removeById(frame.providerId, row.id);
								await syncModels(); data = {}; break;
							}
							if (frame.type === "harness_delete_provider") delete providers[frame.providerId];
							else if (frame.type === "harness_set_key") {
								if (typeof frame.apiKey !== "string" || !frame.apiKey.trim() || frame.apiKey.length > 16384) throw Error("Invalid API key");
								if (typeof old.apiKey === "string" || Array.isArray(old.models) && old.models.length > 0) providers[frame.providerId] = { ...old, apiKey: frame.apiKey.trim() };
								else {
									await credentials.reload();
									if (credentials.hasOAuth(frame.providerId)) throw Error("Log out the OAuth account before replacing authentication");
									await credentials.set(frame.providerId, { type: "api_key", key: frame.apiKey.trim() });
									await syncModels(); data = {}; break;
								}
							} else {
								if (!isRecord(frame.config) || !Array.isArray(frame.config.models) || frame.config.models.some(model => !isRecord(model) || typeof model.id !== "string")) throw Error("Invalid models");
								providers[frame.providerId] = mergeChatProvider(old, frame.config as unknown as UiProviderConfig);
							}
							await saveModels({ ...config, providers }); await syncModels(); data = {};
							} finally { await release(); } break;
						}
						case "harness_providers": {
							const available = new Set(session.getAvailableModels().map(model => model.provider));
							data = { providers: [...new Set(session.modelRegistry.getAll().map(model => model.provider))].map(id => { const kind = session.modelRegistry.authStorage.keys.source(id)?.kind; return { id, name: id, configured: available.has(id), source: kind === "api_key" ? "stored" : kind === "config" ? "models_json_key" : kind === "env" ? "environment" : kind }; }) }; break;
						}
						case "harness_rename_session": {
							if (typeof frame.path !== "string" || typeof frame.name !== "string" || frame.name.length > 200) throw Error("Invalid session rename");
							const path = realpathSync(frame.path), rel = relative(realpathSync(bootstrap.sessionDir), path);
							if (!rel || isAbsolute(rel) || rel.startsWith("..") || !path.endsWith(".jsonl")) throw Error("Session outside workspace");
							if (session.sessionFile && realpathSync(session.sessionFile) === path) await session.sessionManager.setSessionName(frame.name, "user");
							else { const manager = await SessionManager.open(path, bootstrap.sessionDir); await manager.setSessionName(frame.name, "user"); }
							data = {}; break;
						}
						case "harness_save_skills":
							if (bootstrap.restricted || stopping) throw Error("Skill settings unavailable");
							data = await saveSkillSettings(session, frame.version, frame.patch, () => stopping);
							loadedSkills = skillSettingsView(session).version; break;
						case "harness_resources":
							data = { agentDir: bootstrap.agentDir, skillSettings: bootstrap.restricted ? undefined : skillSettingsView(session), skills: session.skills.map(skill => ({ name: skill.name, description: skill.description, path: skill.filePath, enabled: true })), extensions: (session.extensionRunner?.getLoadedExtensions() ?? []).filter(extension => isAbsolute(extension.resolvedPath)).map(extension => ({ id: extension.resolvedPath, name: basename(extension.path), path: extension.resolvedPath, enabled: session.extensionRunner!.isExtensionActive(extension.path) })) };
							break;
						default: throw Error("Unknown host command");
					}
					process.stdout.write(encoder.encode({ type: "response", id: frame.id, command: frame.type, success: true, data }));
				} catch (error) {
					const catalog = ["harness_fetch_models", "harness_clone_provider", "harness_refresh_provider"].includes(String(frame.type));
					const skills = frame.type === "harness_save_skills" && error instanceof SkillSettingsError;
					const mcpError = frame.type === "harness_mcp";
					const promptError = frame.type === "harness_prompt";
					const extensionError = frame.type === "harness_extensions";
					process.stdout.write(encoder.encode({ type: "response", id: frame.id, command: frame.type, success: catalog || skills || mcpError || promptError || extensionError,
						...(extensionError ? { data: { extensionError: error instanceof OmpExtensionError ? error.message : "Extension operation failed; check the native configuration" } } : promptError ? { data: { promptError: error instanceof OmpPromptError ? error.message : "Prompt operation failed; check the native files" } } : mcpError ? { data: { mcpError: error instanceof OmpMcpError ? error.message : "MCP operation failed; check the native configuration" } } : skills ? { data: { skillSettingsError: error.message } } : catalog ? { data: { catalogError: error instanceof ModelCatalogError ? error.message : "OMP 模型目录操作失败，请检查服务商配置" } } : { error: "OMP host operation failed" }),
					}));
				}
				finally { if (mutating) mutations--; }
				});
			}
		},
		async flush(controller) { stopping = true; clearInterval(monitor); unsubscribeRecovery(); await mcp.dispose(); if (buffer.trim()) controller.enqueue(bytes.encode(buffer + "\n")); },
	}));
}
