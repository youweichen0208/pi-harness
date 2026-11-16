import { useEffect, useState } from "react";
import type { OmpSkillSettingKey, OmpSkillSettingValue, UiOmpSkillSettings } from "../types";
import { useT } from "../i18n";

const labels = {
	enabled: "ompSkillsEnabled", enableSkillCommands: "ompSkillsCommands",
	enableCodexUser: "ompSkillsCodexUser", enableClaudeUser: "ompSkillsClaudeUser", enableClaudeProject: "ompSkillsClaudeProject",
	enablePiUser: "ompSkillsPiUser", enablePiProject: "ompSkillsPiProject", enableAgentsUser: "ompSkillsAgentsUser", enableAgentsProject: "ompSkillsAgentsProject",
	customDirectories: "ompSkillsDirectories", ignoredSkills: "ompSkillsIgnored", manualSkills: "ompSkillsManual", includeSkills: "ompSkillsIncluded",
} as const;

export function OmpSkillSettings({ settings, busy, save }: { settings: UiOmpSkillSettings; busy: boolean; save: (version: string, patch: Partial<Record<OmpSkillSettingKey, OmpSkillSettingValue | null>>) => Promise<void> }) {
	const t = useT();
	const [patch, setPatch] = useState<Partial<Record<OmpSkillSettingKey, OmpSkillSettingValue | null>>>({});
	const [arrays, setArrays] = useState<Partial<Record<OmpSkillSettingKey, string>>>({});
	useEffect(() => { setPatch({}); setArrays({}); }, [settings]);
	const update = (key: OmpSkillSettingKey, value: OmpSkillSettingValue | null) => setPatch(previous => ({ ...previous, [key]: value }));
	const dirty = Object.keys(patch).length > 0;
	return <details className="omp-skill-settings" data-dirty={dirty}>
		<summary>{t("ompSkillsPreferences")}</summary>
		<p className="settings-intro">{t("ompSkillsScope")}</p>
		<form onSubmit={event => { event.preventDefault(); void save(settings.version, patch); }}>
			<fieldset disabled={busy}>
				<div className="settings-group">{settings.entries.map(entry => {
					const value = Object.hasOwn(patch, entry.key) ? patch[entry.key]! : entry.global;
					const id = `omp-skill-${entry.key}`;
					return <div className="omp-skill-setting" key={entry.key}>
						<label htmlFor={id}>{t(labels[entry.key])}</label>
						{typeof entry.value === "boolean" ? <select id={id} value={value === null ? "default" : String(value)} onChange={event => update(entry.key, event.target.value === "default" ? null : event.target.value === "true")}>
							<option value="default">{t("ompSettingInherit")}</option><option value="true">{t("ompSettingOn")}</option><option value="false">{t("ompSettingOff")}</option>
						</select> : <>
							<textarea id={id} rows={2} value={arrays[entry.key] ?? (Array.isArray(value) ? value.join("\n") : "")} placeholder={t("ompSkillsOnePerLine")} onChange={event => {
								const text = event.target.value; setArrays(previous => ({ ...previous, [entry.key]: text })); update(entry.key, text.split(/\r?\n/).map(line => line.trim()).filter(Boolean));
							}} />
							<button type="button" className="btn sm" onClick={() => { update(entry.key, null); setArrays(previous => ({ ...previous, [entry.key]: "" })); }}>{t("ompSettingInherit")}</button>
						</>}
						<small>{t("ompSettingEffective", { value: typeof entry.value === "boolean" ? t(entry.value ? "ompSettingOn" : "ompSettingOff") : entry.value.join(", ") || "—", source: t(`ompSettingSource_${entry.source}`) })}</small>
					</div>;
				})}</div>
				<button className="btn primary" type="submit" disabled={!dirty}>{t("ompSkillsSave")}</button>
			</fieldset>
		</form>
	</details>;
}
