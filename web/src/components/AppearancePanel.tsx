import { useEffect, useState } from "react";
import { APPEARANCE_EVENT, getAgentExpressions, setAgentExpressions, THEMES, getAppearanceState, lightThemeOf, setAppearanceState, type AppearanceState, type Theme } from "../appearance";
import { AgentExpression } from "./AgentExpression";
import { useT } from "../i18n";

const LABELS = {
	warm: ["1a", "themeWarm", "themeWarmNote"],
	mist: ["1b", "themeMist", "themeMistNote"],
	sage: ["1c", "themeSage", "themeSageNote"],
	oat: ["1d", "themeOat", "themeOatNote"],
	graphite: ["1e", "themeGraphite", "themeGraphiteNote"],
} as const satisfies Record<Theme, readonly [string, string, string]>;

export function AppearancePanel() {
	const t = useT();
	const [expressions, setExpressions] = useState(getAgentExpressions);
	const [state, setState] = useState<AppearanceState>(getAppearanceState);
	useEffect(() => {
		const sync = () => { setState(getAppearanceState()); setExpressions(getAgentExpressions()); };
		window.addEventListener(APPEARANCE_EVENT, sync);
		return () => window.removeEventListener(APPEARANCE_EVENT, sync);
	}, []);
	const update = (next: AppearanceState) => { setState(next); setAppearanceState(next); };
	const lightKey = lightThemeOf(state.theme);
	return <div className="appearance-panel">
		<div className="settings-page-heading"><h2>{t("settingsAppearance")}</h2></div>
		<div className="appearance-title"><span>{t("themeHeading")}</span><small>{t("themeHint")}</small></div>
		<div className="theme-grid" role="radiogroup" aria-label={t("themeHeading")}>
			{THEMES.map(key => {
				const [id, name, note] = LABELS[key];
				const locked = state.follow && key === "graphite";
				const on = (state.follow ? lightKey : state.theme) === key;
				return <button key={key} type="button" role="radio" aria-checked={on} disabled={locked} className={`theme-card${on ? " active" : ""}`} onClick={() => update({ ...state, theme: key })}>
					<span className="theme-swatch" data-theme={key} aria-hidden="true">
						<span className="ts-side"><i /><i /><i /></span>
						<span className="ts-main"><i className="ts-bubble" /><i className="ts-line" /><i className="ts-line short" /><i className="ts-input"><b /></i></span>
					</span>
					<span className="theme-card-name"><span className="theme-radio" /><code>{id}</code>{t(name)}</span>
					<span className="theme-card-note">{t(note)}</span>
				</button>;
			})}
		</div>
		<div className="appearance-follow">
			<div><span>{t("themeFollowSystem")}</span><small>{t("themeFollowDesc")} <b>{LABELS[lightKey][0]} {t(LABELS[lightKey][1])}</b></small></div>
			<button type="button" role="switch" aria-checked={state.follow} aria-label={t("themeFollowSystem")} className="appearance-switch" onClick={() => update({ ...state, follow: !state.follow, theme: state.follow || state.theme !== "graphite" ? state.theme : "warm" })}><span /></button>
		</div>
		<div className="appearance-follow expression-setting">
			<AgentExpression pose="waving" active />
			<div><span>{t("agentExpressions")}</span><small>{t("agentExpressionsHint")} <a href="/pets/grass-cow/ATTRIBUTION.md" target="_blank" rel="noreferrer">{t("agentExpressionsCredit")}</a></small></div>
			<button type="button" role="switch" aria-checked={expressions} aria-label={t("agentExpressions")} className="appearance-switch" onClick={() => setAgentExpressions(!expressions)}><span /></button>
		</div>
	</div>;
}
