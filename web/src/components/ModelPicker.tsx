import { MODEL_SOURCE_NAMES } from "./ModelSources";
import { UiIcon } from "./UiIcon";
import { memo, useEffect, useId, useMemo, useState } from "react";
import { FiCpu, FiSearch } from "react-icons/fi";
import type { ClientMessage, ModelInfo, UiState } from "../types";
import { Dropdown, DropdownItem } from "./Dropdown";
import { useT } from "../i18n";

/** Messages this component sends (a subset shared by TopBar and ChatInput). */
export type ModelPickerMsg =
	| Extract<ClientMessage, { type: "login_provider" }>
	| { type: "list_models" }
	| { type: "set_model"; modelId: string }
	| Extract<ClientMessage, { type: "set_cache_warming" }>
	| Extract<ClientMessage, { type: "set_run_settings" }>;

/** Props are deliberately NARROW (no whole-ChatState object): every field is
 *  stable while tokens stream in, so the shallow-compared memo() below keeps
 *  both toolbars idle during streaming. */
interface Props {
	state: Pick<UiState, "model" | "routedModel" | "conversationId" | "runSettings"> | null;
	accounts?: import("../types").ModelAccount[];
	models: ModelInfo[];
	modelsLoading: boolean;
	send: (msg: ModelPickerMsg) => boolean;
	/** Opens the custom-model config modal (App-level state). */
	onManageModels: () => void;
	/** Compact triggers for narrow toolbars (mobile input row). */
	compact?: boolean;
}

/** Shared model picker and native run settings. */
export const ModelPicker = memo(function ModelPicker({ state, models, accounts, modelsLoading, send, onManageModels, compact = false }: Props) {
	const t = useT();
	const warmingHint = useId();
	const model = state?.model;
	// snapshot model.id is the bare id; list ids are "provider/id".
	const currentModelId = model ? `${model.provider}/${model.id}` : null;
	const [modelOpen, setModelOpen] = useState(false);
	// Model dropdown filter — the list can be long (all providers × models),
	// so a type-to-filter box sits above it. Reset when the dropdown closes.
	const [modelFilter, setModelFilter] = useState("");
	useEffect(() => {
		if (!modelOpen) setModelFilter("");
	}, [modelOpen]);
	const filteredModels = useMemo(() => {
		const q = modelFilter.trim().toLowerCase();
		if (!q) return models;
		return models.filter(
			(m) =>
				accounts?.some(a => a.loggedIn && a.provider === m.provider && a.name.toLowerCase().includes(q)) ||
				m.name.toLowerCase().includes(q) ||
				m.provider.toLowerCase().includes(q) ||
				m.id.toLowerCase().includes(q),
		);
	}, [models, modelFilter, accounts]);


	const runSettings = state?.runSettings && <details className="model-run-settings"><summary>{t("modelMenuSettings")}</summary><div className="model-run-settings-body">
		{(["autoCompaction", "autoRetry"] as const).map(key => <label key={key}>
			<input type="checkbox" checked={state.runSettings![key]} onChange={event => send({ type: "set_run_settings", conversationId: state.conversationId, [key]: event.target.checked })} />
			{t(key === "autoCompaction" ? "conversationAutoCompaction" : "conversationAutoRetry")}
		</label>)}
		<label className="model-cache-warming">
			<span>{t("cacheWarmingGlobal")}</span>
			<select value={state.runSettings.cacheWarming ?? "streaming"} aria-label={t("cacheWarmingGlobal")} aria-describedby={warmingHint} onChange={event => send({ type: "set_cache_warming", mode: event.target.value as "off" | "streaming" | "idle" })}>
				<option value="off">{t("cacheWarmingOff")}</option>
				<option value="streaming">{t("cacheWarmingStreaming")}</option>
				<option value="idle">{t("cacheWarmingIdle")}</option>
			</select>
		</label>
		<p id={warmingHint} className="model-cache-hint">{t("cacheWarmingHint")}</p>
	</div></details>;

	useEffect(() => {
		if (!modelOpen) return;
		const channel = new BroadcastChannel("pi-account-updates");
		channel.onmessage = () => send({ type: "list_models" });
		const refresh = () => send({ type: "list_models" });
		window.addEventListener("focus", refresh);
		const timer = window.setInterval(refresh, 5000);
		return () => { window.clearInterval(timer); channel.close(); window.removeEventListener("focus", refresh); };
	}, [modelOpen, send]);

	return (
		<>
			<Dropdown
				trigger={
					<>
						<FiCpu />
						<span className="chip-model">
							{model ? model.name : t("selectModel")}
							{state?.routedModel && <span className="chip-routed-model" title={`${state.routedModel.provider}/${state.routedModel.id}`}> → {state.routedModel.name}</span>}
						</span>
						{!compact && model?.vision && (
							<span className="chip-vision" title={t("vision")}>
								<UiIcon name="image" />
							</span>
						)}
						{!compact && model && (
							<span className="chip-sub">{model.provider}</span>
						)}
					</>
				}
				open={modelOpen}
				onOpenChange={open => { setModelOpen(open); if (open) send({ type: "list_models" }); }}
				menuClassName="dd-menu-model"
			>
				<div className="dd-header">{t("availableModels")} <span className="model-count">{filteredModels.length}{modelFilter ? " / " + models.length : ""}</span></div>
				<div className="dd-search-row">
					<FiSearch aria-hidden="true" />
					<input
						className="dd-search"
						type="text"
						placeholder={t("searchModels")}
						aria-label={t("searchModels")}
						value={modelFilter}
						onChange={(e) => setModelFilter(e.target.value)}
					/>
				</div>
				{/* Scrollable model list (middle band) — the header/search above
				    and the footer below stay fixed while this scrolls. */}
				<div className="dd-model-scroll">
					{accounts?.filter(a => !modelFilter.trim() || a.name.toLowerCase().includes(modelFilter.trim().toLowerCase()) || filteredModels.some(m => m.provider === a.provider)).map(a => <button
						key={a.provider}
						type="button"
						className="model-account-entry"
						aria-label={`${a.name} · ${t(a.error ? "accountRetry" : !a.enabled || a.loggedIn ? "modelMenuManage" : "providerLogin")}`}
						onClick={() => {
							if (a.error) { send({ type: "list_models" }); return; }
							if (!a.enabled || a.loggedIn) { setModelOpen(false); onManageModels(); return; }
							if (a.replaceKey && !window.confirm(t("accountReplaceKey"))) return;
							send({ type: "login_provider", provider: a.provider, confirmReplaceKey: a.replaceKey });
						}}
					><span>{a.name}</span><span aria-hidden="true">{a.error ? "↻" : a.loggedIn ? "✓" : "›"}</span></button>)}
					{modelsLoading && (
						<div className="dd-loading">{t("loading")}</div>
					)}
					{models.length === 0 &&
						!modelsLoading && (
							<div className="dd-loading">{t("noModels")}</div>
						)}
					{filteredModels.length === 0 && models.length > 0 && !accounts?.some(a => a.name.toLowerCase().includes(modelFilter.trim().toLowerCase())) && (
						<div className="dd-loading">{t("noModelMatches")}</div>
					)}
					{filteredModels.map((m) => (
						<DropdownItem
							key={m.id}
							title={`${m.name} · ${m.provider}`}
							active={currentModelId === m.id}
							onClick={() => {
								if (currentModelId !== m.id) {
									send({ type: "set_model", modelId: m.id });
								}
								setModelOpen(false);
							}}
						>
							<span className="dd-model-cell">
								<span className="dd-model-name">{m.name}</span>
								<span className="dd-model-meta">
									<span className="dd-model-provider">{m.origin?.sources.some(source => source !== "pi") ? m.origin.sources.map(source => MODEL_SOURCE_NAMES[source]).join(" / ") : m.provider}{m.origin?.mode === "local" ? ` · ${t("modelLocal")}` : ""}</span>
									{(m.reasoning || m.vision) && (
										<span className="dd-model-badges">
											{m.reasoning && (
													<span className="dd-model-badge">{t("reasoning")}</span>
											)}
											{m.vision && (
													<span className="dd-model-badge">{t("vision")}</span>
												)}
											</span>
										)}
									</span>
								</span>
							</DropdownItem>
						))}
					</div>
					{runSettings}
					{/* Fixed footer — refresh / manage never scroll away. */}
					<div className="dd-footer">
						<button
							type="button"
							className="dd-refresh"
							title={t("refreshModels")}
							onClick={() => send({ type: "list_models" })}
						>
							{t("modelMenuRefresh")}
						</button>
						<button
							type="button"
							className="dd-refresh"
							onClick={() => {
								setModelOpen(false);
								onManageModels();
							}}
						>
							<UiIcon name="settings" /> {t("modelMenuManage")}
						</button>
					</div>
				</Dropdown>

		</>
	);
});
