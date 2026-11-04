import type { ClientMessage, ModelSourceStatus } from "../types";
import { useT } from "../i18n";
export const MODEL_SOURCE_NAMES = { pi: "Pi", claude: "Claude Code", codex: "Codex", opencode: "OpenCode" };
export function ModelSources({ sources, send }: { sources: ModelSourceStatus[]; send: (msg: ClientMessage) => boolean }) {
	const t = useT();
	return <section className="model-sources" aria-label={t("modelSources")}>
		<div className="provider-row"><h3>{t("modelSources")}</h3><button type="button" className="btn sm" onClick={() => send({ type: "sync_model_sources" })}>{t("syncModelsNow")}</button></div>
		<p className="modal-desc">{t("modelSourcesHint")}</p>
		{sources.map(s => <div className="provider-row" key={s.source}>
			<div className="provider-info"><label><input type="checkbox" checked={s.enabled} onChange={e => send({ type: "sync_model_sources", source: s.source, enabled: e.target.checked })} /> {MODEL_SOURCE_NAMES[s.source]}</label>
				<span className="provider-sub" role="status">{t(`modelSource_${s.status}`)}{s.pending ? ` · ${t("modelSourcePending")}` : ""} · {t("modelsCount", { n: s.count })} · {new Date(s.checkedAt).toLocaleTimeString()}</span></div>
			<button type="button" className="btn sm" onClick={() => send({ type: "sync_model_sources", source: s.source, enabled: true, restore: true })}>{t("restoreModelSync")}</button>
		</div>)}
	</section>;
}
