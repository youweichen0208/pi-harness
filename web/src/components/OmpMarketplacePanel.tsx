import { OmpPathButton } from "./OmpPathButton";
import { useState } from "react";
import { useT } from "../i18n";
import type { OmpPackageOperation, OmpPackageScope, UiOmpMarketplaceState, UiOmpPackageSettings } from "../types";
import { OmpPackageSettings } from "./OmpPackageSettings";
import { OmpPackageFeatures } from "./OmpPackageFeatures";

export function OmpMarketplacePanel({ cwd, conversationId, state, version, disabled, preview, changed, settingsRequest }: { cwd: string; conversationId: string; settingsRequest: (payload: Record<string, unknown>) => Promise<UiOmpPackageSettings>; state: UiOmpMarketplaceState; version: string; disabled: boolean; changed: () => void; preview: (operation: OmpPackageOperation, target: string, scope?: OmpPackageScope, features?: string[] | null, expectedVersion?: string) => void }) {
	const t = useT();
	const [source, setSource] = useState("");
	const [scope, setScope] = useState<OmpPackageScope>("user");
	return <section className="omp-marketplace-panel" aria-label="Marketplace">
		<h3>Marketplace</h3>
		<p className="settings-intro">{t("ompMarketIntro")}</p>
		<div className="omp-package-actions">
			<input aria-label={t("ompMarketSource")} placeholder={t("ompMarketSource")} value={source} disabled={disabled} onChange={event => setSource(event.target.value)} />
			<button className="btn" disabled={disabled || !source.trim()} onClick={() => preview("marketplace-add", source)}>{t("ompMarketAdd")}</button>
		</div>
		<label className="omp-package-actions">{t("ompMarketInstallScope")}
			<select aria-label={t("ompMarketInstallScope")} value={scope} disabled={disabled} onChange={event => setScope(event.target.value as OmpPackageScope)}>
				<option value="user">{t("ompPkgUser")}</option><option value="project" disabled={!state.projectRoot}>{t("ompPkgProject")}</option>
			</select>
		</label>
		{scope === "project" && <p className="settings-paths"><code>{state.projectRoot}</code></p>}
		{!state.projectRoot && <p className="settings-intro">{t("ompMarketNoProject")}</p>}
		{state.marketplaces.map(market => <details className="settings-group omp-marketplace-catalog" key={market.name} open>
			<summary>{market.name}</summary><p className="settings-paths"><code>{market.source}</code></p>
			<div className="omp-package-actions">
				<button className="btn" disabled={disabled} onClick={() => preview("marketplace-refresh", market.name)}>{t("ompMarketRefresh")}</button>
				<button className="btn" disabled={disabled} onClick={() => preview("marketplace-remove", market.name)}>{t("ompMarketRemove")}</button>
			</div>
			{!market.available && <p role="status">{t("ompMarketUnavailable")}</p>}
			{market.plugins.map(plugin => <div className="settings-skill-row" key={plugin.id}>
				<div className="settings-skill-info"><strong>{plugin.id}</strong><small>{plugin.version}</small><small>{plugin.description}</small></div>
				<button className="btn" disabled={disabled || scope === "project" && !state.projectRoot || state.installed.some(item => item.id === plugin.id && item.scope === scope)} onClick={() => preview("plugin-install", plugin.id, scope)}>{t("ompMarketInstall")}</button>
			</div>)}
		</details>)}
		<h4>{t("ompMarketInstalled")}</h4>
		<div className="settings-group omp-marketplace-installed">{state.installed.map(plugin => <div className="settings-skill-row" key={`${plugin.id}:${plugin.scope}`}>
			<div className="settings-skill-info"><strong>{plugin.id} · {t(plugin.scope === "project" ? "ompPkgProject" : "ompPkgUser")}</strong><small>{plugin.versions.join(", ")} · {t(plugin.enabled ? "ompMarketEnabled" : "ompMarketDisabled")}</small>{plugin.shadowed && <small>{t("ompMarketShadowed")}</small>}{plugin.paths.map(path => <div key={path}><small>{path}</small><OmpPathButton cwd={cwd} conversationId={conversationId} target={{ kind: "plugin", id: plugin.id, scope: plugin.scope, path }} /></div>)}
				<OmpPackageSettings target={plugin.id} installScope={plugin.scope} disabled={disabled} request={settingsRequest} changed={changed} />
				{plugin.featureConfig && <OmpPackageFeatures config={plugin.featureConfig} version={version} disabled={disabled} changed={changed} preview={(features, expectedVersion) => preview("plugin-features", plugin.id, plugin.scope, features, expectedVersion)} />}
			</div>
			<div className="omp-package-actions">
				<button className="btn" disabled={disabled} onClick={() => preview(plugin.enabled ? "plugin-disable" : "plugin-enable", plugin.id, plugin.scope)}>{t(plugin.enabled ? "ompPkgDisable" : "ompPkgEnable")}</button>
				<button className="btn" disabled={disabled || !state.marketplaces.some(market => market.available && market.plugins.some(item => item.id === plugin.id))} onClick={() => preview("plugin-update", plugin.id, plugin.scope)}>{t("ompPkgUpdate")}</button>
				<button className="btn" disabled={disabled} onClick={() => preview("plugin-remove", plugin.id, plugin.scope)}>{t("ompPkgRemove")}</button>
			</div>
		</div>)}{!state.installed.length && <p className="settings-empty">{t("extNoResults")}</p>}</div>
	</section>;
}
