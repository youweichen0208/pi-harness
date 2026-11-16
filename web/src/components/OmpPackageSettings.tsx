import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import type { OmpPackageScope, OmpPackageSettingsPatch, UiOmpPackageSettings } from "../types";

type Draft = Record<string, { action: "set" | "reset"; text: string }>;
export function OmpPackageSettings({ target, installScope, disabled, request, changed }: {
	target: string; installScope?: OmpPackageScope; disabled: boolean; changed: () => void;
	request: (payload: Record<string, unknown>) => Promise<UiOmpPackageSettings>;
}) {
	const t = useT();
	const [view, setView] = useState<UiOmpPackageSettings>();
	const [scope, setScope] = useState<OmpPackageScope>("user");
	const [draft, setDraft] = useState<Draft>({});
	const [pending, setPending] = useState(false), [error, setError] = useState(""), [saved, setSaved] = useState(false);
	const active = useRef(true), working = useRef(false);
	const dirty = Object.keys(draft).length > 0;
	useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
	useEffect(() => {
		if (!dirty) return;
		const handler = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
		window.addEventListener("beforeunload", handler); return () => window.removeEventListener("beforeunload", handler);
	}, [dirty]);
	const load = async (nextScope = scope, save = false) => {
		if (working.current) return;
		working.current = true; setPending(true); setError(""); setSaved(false);
		try {
			const patch: OmpPackageSettingsPatch = {};
			if (save) for (const [key, edit] of Object.entries(draft)) {
				if (edit.action === "reset") { patch[key] = { action: "reset" }; continue; }
				const field = view?.fields.find(field => field.key === key); if (!field) throw Error(t("ompPkgSettingsInvalid"));
				let value: string | number | boolean = edit.text;
				if (field.type === "number") { if (!edit.text.trim() || !Number.isFinite(Number(edit.text))) throw Error(t("ompPkgSettingsInvalid")); value = Number(edit.text); }
				if (field.type === "boolean") { if (!["true", "false"].includes(edit.text)) throw Error(t("ompPkgSettingsInvalid")); value = edit.text === "true"; }
				patch[key] = { action: "set", value };
			}
			const data = await request({ action: save ? "settings-save" : "settings-read", target, scope: installScope, settingsScope: nextScope, ...(save ? { patch, expectedVersion: view?.version } : {}) });
			if (!active.current) return;
			setView(data); setScope(nextScope); setDraft({}); setSaved(save);
		} catch (error) { if (active.current) setError((error as Error).message); }
		finally { if (active.current) setPending(false); working.current = false; }
	};
	const discard = () => !dirty || window.confirm(t("mcpDiscard"));
	const blocked = disabled || pending;
	return <details className="omp-package-settings" data-dirty={dirty} onToggle={event => { if (event.currentTarget.open && !view && !working.current) void load(); }}>
		<summary>{t("ompPkgSettings")}</summary>
		<p className="settings-intro">{t("ompPkgSettingsIntro")}</p>
		<label>{t("ompPkgSettingsScope")}<select aria-label={t("ompPkgSettingsScope")} value={scope} disabled={blocked} onChange={event => { if (discard()) void load(event.target.value as OmpPackageScope); }}>
			<option value="user">{t("ompPkgUser")}</option><option value="project">{t("ompPkgProject")}</option>
		</select></label>
		{view && <p className="settings-paths"><code>{view.name} · {view.path}</code></p>}
		{error && <p role="alert">{error}</p>}
		{saved && <p role="status">{t("ompPkgSettingsSaved")}</p>}
		{view?.fields.map(field => {
			const edit = draft[field.key], mode = edit?.action ?? "keep", text = edit?.text ?? (field.value === undefined ? "" : String(field.value));
			const update = (action: "keep" | "set" | "reset", value = text) => { changed(); setSaved(false); setDraft(previous => { const next = { ...previous }; if (action === "keep") delete next[field.key]; else next[field.key] = { action, text: value }; return next; }); };
			return <fieldset className="omp-package-setting" key={field.key} disabled={blocked}>
				<legend>{field.key}</legend>{field.description && <p>{field.description}</p>}
				<p>{t(field.configured ? "ompPkgSettingsConfigured" : "ompPkgSettingsUnset")} · {t(field.source === "project" ? "ompPkgSettingsProject" : field.source === "user" ? "ompPkgSettingsUser" : field.source === "default" ? "ompPkgSettingsDefault" : "ompPkgSettingsNone")}{field.effective !== undefined && `: ${String(field.effective)}`}</p>
				{field.env && <small>{t("ompPkgSettingsEnv", { name: field.env })}</small>}
				{field.invalid && <p role="status">{t("ompPkgSettingsInvalidStored")}</p>}
				<label>{t("ompPkgSettingsAction")}<select aria-label={`${field.key} ${t("ompPkgSettingsAction")}`} value={mode} onChange={event => update(event.target.value as "keep" | "set" | "reset")}>
					<option value="keep">{t("ompPkgSettingsKeep")}</option><option value="set">{t("ompPkgSettingsSet")}</option><option value="reset">{t("ompPkgSettingsReset")}</option>
				</select></label>
				{mode === "set" && <label>{field.key}{field.secret && <small>{t("ompPkgSettingsSecret")}</small>}
					{!field.secret && (field.type === "boolean" || field.type === "enum") ? <select aria-label={field.key} value={text} onChange={event => update("set", event.target.value)}>
						<option value="" disabled>{t("ompPkgSettingsChoose")}</option>{(field.type === "boolean" ? ["true", "false"] : field.values ?? []).map(value => <option key={value} value={value}>{value}</option>)}
					</select> : <input aria-label={field.key} type={field.secret ? "password" : field.type === "number" ? "number" : "text"} autoComplete="off" value={text} min={field.min} max={field.max} step={field.step ?? "any"} maxLength={4096} onChange={event => update("set", event.target.value)} />}
				</label>}
			</fieldset>;
		})}
		{view && !view.fields.length && <p>{t("ompPkgSettingsEmpty")}</p>}
		<div className="omp-package-actions">
			<button className="btn primary" disabled={blocked || !dirty} onClick={() => void load(scope, true)}>{t("save")}</button>
			<button className="btn" disabled={blocked} onClick={() => { if (discard()) void load(); }}>{t("ompPkgRefresh")}</button>
			<button className="btn" disabled={blocked || !dirty} onClick={() => { changed(); setDraft({}); }}>{t("ompPkgFeaturesReset")}</button>
		</div>
	</details>;
}
