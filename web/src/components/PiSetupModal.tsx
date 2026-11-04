import { ModelSources } from "./ModelSources";
import { useDialogFocus } from "../use-dialog-focus";
import { useEffect, useState } from "react";
import { FiCpu, FiRefreshCw, FiX } from "react-icons/fi";
import type { ClientMessage, ModelSourceStatus, ProviderStatus } from "../types";
import { useT } from "../i18n";

interface PiSetupModalProps {
	sources?: ModelSourceStatus[];
	onManage?: () => void;
	send: (msg: ClientMessage) => boolean;
	/** Fetched from the latest snapshot; true once auth.json has credentials. */
	piConfigured: boolean;
	/** Whether the pi CLI binary is installed (snapshot piAgentInstalled). */
	piAgentInstalled: boolean;
	/** Built-in providers with auth status (key-only config). */
	providers: ProviderStatus[];
	/** Real result of the last install_pi_agent run (null = not finished). */
	installResult: { ok: boolean; detail: string } | null;
	onClose: () => void;
}

/** First-run API setup, powered by the embedded SDK; no CLI installation required. */
export function PiSetupModal({
	send,
	piConfigured,
	sources = [],
	onManage,
	providers,
	onClose,
}: PiSetupModalProps) {
	const t = useT();
	const dialogRef = useDialogFocus();

	const [provider, setProvider] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [saving, setSaving] = useState(false);

	// Built-in provider list for the dropdown.
	useEffect(() => {
		send({ type: "list_providers" });
		send({ type: "sync_model_sources" });
	}, [send]);

	// Auto-close once the config is actually ready (snapshot-driven).
	useEffect(() => {
		if (piConfigured) onClose();
	}, [piConfigured, onClose]);

	// Default to the first unconfigured provider once the list arrives.
	useEffect(() => {
		if (!provider && providers.length > 0) {
			setProvider(providers.find((p) => !p.configured)?.id ?? providers[0].id);
		}
	}, [providers, provider]);

	const saveKey = () => {
		if (!apiKey.trim() || saving) return;
		setSaving(true);
		send({
			type: "set_provider_api_key",
			provider: provider.trim(),
			apiKey: apiKey.trim(),
		});
		// The server refreshes models and flushes a snapshot — the modal closes
		// itself once piConfigured flips true. Keep the button disabled meanwhile.
		setTimeout(() => setSaving(false), 3000);
	};

	const recheck = () => {
		send({ type: "get_state" });
		send({ type: "list_providers" });
		send({ type: "sync_model_sources" });
	};

	const selected = providers.find((p) => p.id === provider);


	return (
		<div className="modal-backdrop">
			<div className="modal setup-modal" role="dialog" aria-modal="true" aria-label={t("setupTitle")} ref={dialogRef} tabIndex={-1}>
				<button
					type="button"
					className="modal-close"
					aria-label={t("close")}
					onClick={onClose}
				>
					<FiX />
				</button>
				<div className="modal-head">
					<FiCpu className="modal-head-icon" />
					<h2>{t("setupTitle")}</h2>
				</div>
				<p className="modal-desc">{t("setupDesc")}</p>

				<ModelSources sources={sources} send={send} />
				<button type="button" className="btn" onClick={onManage}>{t("manageModels")}</button>
				<div className="setup-key-form">
						<label className="field">
							<span className="field-label">{t("provider")}</span>
							<select
								value={provider}
								onChange={(e) => setProvider(e.target.value)}
							>
								{providers.length === 0 && (
									<option value="">{t("loading")}</option>
								)}
								{providers.map((p) => (
									<option key={p.id} value={p.id}>
										{p.name}（{p.id}）
										{p.configured ? ` · ${t("configured")}` : ""}
									</option>
								))}
							</select>
							{selected?.configured && (
								<div className="field-hint">{t("providerKeyReady")}</div>
							)}
						</label>
						<label className="field">
							<span className="field-label">{t("apiKey")}</span>
							<input
								type="password"
								value={apiKey}
								onChange={(e) => setApiKey(e.target.value)}
								placeholder="sk-…"
							/>
						</label>
						<div className="setup-actions">
							{selected?.oauth && <button type="button" className="btn" onClick={() => send({ type: "login_provider", provider })}>{t("providerLogin")}</button>}
							<button
								type="button"
								className="btn primary"
								disabled={!apiKey.trim() || saving || !provider}
								onClick={saveKey}
							>
								{saving ? t("saving") : t("saveAndStart")}
							</button>
							<button type="button" className="btn" onClick={recheck}>
								<FiRefreshCw /> {t("recheck")}
							</button>
						</div>
					</div>

			</div>
		</div>
	);
}
