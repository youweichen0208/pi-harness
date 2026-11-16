import { useEffect, useState } from "react";
import { useT } from "../i18n";
import type { UiOmpPackageFeatures } from "../types";

export function OmpPackageFeatures({ config, version, disabled, preview, changed }: {
	config: UiOmpPackageFeatures; version: string; disabled: boolean;
	preview: (features: string[] | null, expectedVersion: string) => void; changed: () => void;
}) {
	const t = useT();
	const [draft, setDraft] = useState(config.selected);
	const [baseline, setBaseline] = useState({ selected: config.selected, version });
	const dirty = JSON.stringify(draft) !== JSON.stringify(baseline.selected);
	useEffect(() => {
		if (!dirty || JSON.stringify(draft) === JSON.stringify(config.selected)) {
			setDraft(config.selected); setBaseline({ selected: config.selected, version });
		}
	}, [version]);
	useEffect(() => {
		if (!dirty) return;
		const handler = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
		window.addEventListener("beforeunload", handler); return () => window.removeEventListener("beforeunload", handler);
	}, [dirty]);
	const defaults = config.available.filter(feature => feature.default).map(feature => feature.name);
	const selected = draft ?? defaults;
	const edit = (features: string[] | null) => { changed(); setDraft(features); };
	if (!config.available.length && config.selected === null) return null;
	return <details className="omp-package-features" data-dirty={dirty}>
		<summary>{t("ompPkgFeatures")}</summary>
		<p className="settings-intro">{t("ompPkgFeaturesIntro")}</p>
		{config.overridden && <p>{t("ompPkgFeaturesOverride")}</p>}
		<p>{t("ompPkgFeaturesEffective")} {((config.effective ?? defaults).join(", ")) || t("ompPkgFeaturesNone")}</p>
		<label><input type="checkbox" checked={draft === null} disabled={disabled} onChange={event => edit(event.target.checked ? null : defaults)} />{t("ompPkgFeaturesDefault")}</label>
		{config.available.map(feature => <label className="omp-package-feature" key={feature.name}>
			<input type="checkbox" checked={selected.includes(feature.name)} disabled={disabled || draft === null} onChange={event => edit(event.target.checked ? [...selected, feature.name] : selected.filter(name => name !== feature.name))} />
			<span><strong>{feature.name}</strong>{feature.default && <small>{t("ompPkgFeatureDefault")}</small>}{feature.description && <small>{feature.description}</small>}</span>
		</label>)}
		{dirty && baseline.version !== version && <p role="alert">{t("ompPkgFeaturesStale")}</p>}
		<div className="omp-package-actions">
			<button className="btn" disabled={disabled || !dirty} onClick={() => preview(draft, baseline.version)}>{t("ompPkgPreview")}</button>
			<button className="btn" disabled={disabled || !dirty} onClick={() => { edit(config.selected); setBaseline({ selected: config.selected, version }); }}>{t("ompPkgFeaturesReset")}</button>
		</div>
	</details>;
}
