import { OmpPathButton } from "./OmpPathButton";
import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { getClientId } from "../use-chat";
import { withToken } from "../auth-token";
import { randomUuid } from "../uuid";
import type { OmpPackageOperation, OmpPackageScope, UiOmpPackageJob, UiOmpPackagePlan, UiOmpPackages } from "../types";
import { OmpMarketplacePanel } from "./OmpMarketplacePanel";
import { OmpPackageSettings } from "./OmpPackageSettings";
import { OmpPackageFeatures } from "./OmpPackageFeatures";

export function OmpPackagesPanel({ cwd, conversationId, busy }: { cwd: string; conversationId: string; busy: boolean }) {
	const t = useT();
	const [view, setView] = useState<UiOmpPackages>();
	const [jobs, setJobs] = useState<UiOmpPackageJob[]>([]);
	const [plan, setPlan] = useState<{ id: string; value: UiOmpPackagePlan }>();
	const [target, setTarget] = useState("");
	const [operation, setOperation] = useState<"install" | "link">("install");
	const [error, setError] = useState("");
	const [pending, setPending] = useState(false);
	const lifecycle = useRef<AbortController>();
	const planElement = useRef<HTMLDivElement>(null);
	const statusElement = useRef<HTMLParagraphElement>(null);
	const focusStatus = useRef(false);
	useEffect(() => {
		if (plan) planElement.current?.querySelector("button")?.focus();
		else if (focusStatus.current) { focusStatus.current = false; statusElement.current?.focus(); }
	}, [plan?.id]);
	const inFlight = useRef(false);
	const request = async <T,>(payload: Record<string, unknown>): Promise<T> => {
		const response = await fetch(withToken("/api/omp-packages"), { method: "POST", signal: lifecycle.current?.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId: getClientId(), cwd, conversationId, ...payload }) });
		const body = await response.json();
		if (!response.ok) throw Error(body.error ?? response.statusText);
		return body;
	};
	const refresh = async () => {
		const data = await request<UiOmpPackages & { jobs: UiOmpPackageJob[] }>({ action: "list" });
		if (!lifecycle.current?.signal.aborted) { setView(data); setJobs(data.jobs); }
	};
	const act = async (work: () => Promise<void>) => {
		if (inFlight.current) return;
		inFlight.current = true; setPending(true); setError("");
		const controller = lifecycle.current;
		try { await work(); }
		catch (error) { if (!controller?.signal.aborted) setError((error as Error).message); }
		finally { if (!controller?.signal.aborted) { inFlight.current = false; setPending(false); } }
	};
	useEffect(() => {
		const controller = new AbortController(); lifecycle.current = controller;
		inFlight.current = false;
		void act(refresh);
		return () => controller.abort();
	}, []);
	const running = jobs.filter(job => job.phase === "running");
	useEffect(() => {
		if (!running.length) return;
		const timer = setInterval(() => {
			void act(async () => {
				const updated = await Promise.all(running.map(job => request<UiOmpPackageJob>({ action: "job", id: job.id })));
				setJobs(previous => previous.map(job => updated.find(item => item.id === job.id) ?? job));
				if (updated.some(job => job.phase !== "running")) await refresh();
			});
		}, 2000);
		return () => clearInterval(timer);
	}, [running.map(job => job.id).join(",")]);
	const labels = { install: "ompPkgInstall", link: "ompPkgLink", update: "ompPkgUpdate", remove: "ompPkgRemove", enable: "ompPkgEnable", disable: "ompPkgDisable", features: "ompPkgFeatures", "marketplace-add": "ompMarketAdd", "marketplace-refresh": "ompMarketRefresh", "marketplace-remove": "ompMarketRemove", "plugin-install": "ompMarketInstall", "plugin-update": "ompPkgUpdate", "plugin-remove": "ompPkgRemove", "plugin-enable": "ompPkgEnable", "plugin-disable": "ompPkgDisable", "plugin-features": "ompPkgFeatures" } as const;
	const label = (operation: OmpPackageOperation) => t(labels[operation]);
	const phaseLabel = (phase: UiOmpPackageJob["phase"]) => t(phase === "running" ? "ompPkgRunning" : phase === "success" ? "ompPkgSuccess" : phase === "failed" ? "ompPkgFailed" : "ompPkgUnknown");
	const preview = (operation: OmpPackageOperation, target: string, scope?: OmpPackageScope, selectedFeatures?: string[] | null, expectedVersion?: string) => act(async () => {
		const value = await request<UiOmpPackagePlan>({ action: "preview", operation, target, scope, selectedFeatures, expectedVersion });
		setPlan({ id: randomUuid(), value });
	});
	const disabled = busy || pending || !!running.length;
	return <section className="omp-packages-panel" aria-label={t("ompPkgTitle")}>
		<h3>{t("ompPkgTitle")}</h3>
		<p className="settings-intro">{t("ompPkgIntro")}</p>
		<p className="omp-package-status" role="status" tabIndex={-1} ref={statusElement}>{jobs[0] && `${label(jobs[0].plan.operation)} · ${jobs[0].plan.target} · ${phaseLabel(jobs[0].phase)}`}</p>
		{view && <p className="settings-paths"><code>{view.root}</code></p>}
		<div className="omp-package-actions">
			<select aria-label={t("ompPkgOperation")} value={operation} disabled={disabled} onChange={event => { setOperation(event.target.value as "install" | "link"); setPlan(undefined); }}><option value="install">{t("ompPkgInstall")}</option><option value="link">{t("ompPkgLink")}</option></select>
			<input aria-label={t("ompPkgTarget")} placeholder={operation === "link" ? t("ompPkgLocalPath") : "@scope/package@version"} value={target} disabled={disabled} onChange={event => { setTarget(event.target.value); setPlan(undefined); }} />
			<button className="btn" disabled={disabled || !target.trim()} onClick={() => void preview(operation, target)}>{t("ompPkgPreview")}</button>
			<button className="btn" disabled={pending} onClick={() => void act(refresh)}>{t("ompPkgRefresh")}</button>
		</div>
		{error && <p role="alert" className="settings-error">{error}</p>}
		{plan && <div className="settings-group omp-package-plan" ref={planElement} role="group" aria-label={t("ompPkgPreview")}>
			<strong>{label(plan.value.operation)}</strong><code>{plan.value.target}</code><code>{plan.value.root}</code>
			{plan.value.scope && <p>{t(plan.value.scope === "project" ? "ompPkgProject" : "ompPkgUser")}</p>}
			{plan.value.sharedRoot && <p>{t("ompMarketSharedCache")}<br /><code>{plan.value.sharedRoot}</code></p>}
			{plan.value.source && <code>{plan.value.source}</code>}
			{(plan.value.fromVersion || plan.value.toVersion) && <p>{plan.value.fromVersion ?? "?"} → {plan.value.toVersion ?? "?"}</p>}
			{plan.value.selectedFeatures !== undefined && <p>{plan.value.selectedFeatures === null ? t("ompPkgFeaturesDefault") : plan.value.selectedFeatures.join(", ") || t("ompPkgFeaturesNone")}</p>}
			<p>{t(plan.value.selectedFeatures !== undefined ? "ompPkgFeaturesReview" : plan.value.operation === "marketplace-remove" ? "ompMarketRemoveReview" : "ompPkgReview")}</p>
			<div className="omp-package-actions"><button className="btn primary" disabled={disabled} onClick={() => void act(async () => {
				const job = await request<UiOmpPackageJob>({ action: "start", id: plan.id, plan: plan.value });
				focusStatus.current = true; setJobs(previous => [job, ...previous.filter(item => item.id !== job.id)]); setPlan(undefined);
			})}>{t("ompPkgApply")}</button><button className="btn" disabled={pending} onClick={() => setPlan(undefined)}>{t("cancel")}</button></div>
		</div>}
		<div className="settings-group">{view?.items.map(item => <div className="settings-skill-row" key={item.name}>
			<div className="settings-skill-info"><strong>{item.name}</strong><small>{item.version} · {t(item.enabled ? "ompPkgEnabled" : "ompPkgDisabled")}</small>{item.enabled !== item.effectiveEnabled && <small>{t("ompPkgProjectOverride")}</small>}<small>{item.path}</small>
				<OmpPackageSettings target={item.name} disabled={disabled} request={request} changed={() => setPlan(undefined)} />
				{item.featureConfig && <OmpPackageFeatures config={item.featureConfig} version={view.version} disabled={disabled} changed={() => setPlan(undefined)} preview={(features, version) => { void preview("features", item.name, undefined, features, version); }} />}
			</div>
			<div className="omp-package-actions">
				<OmpPathButton cwd={cwd} conversationId={conversationId} target={{ kind: "package", name: item.name }} />
				<button className="btn" disabled={disabled} onClick={() => void preview(item.enabled ? "disable" : "enable", item.name)}>{label(item.enabled ? "disable" : "enable")}</button>
				<button className="btn" disabled={disabled || !item.updatable} onClick={() => void preview("update", item.name)}>{t("ompPkgUpdate")}</button>
				<button className="btn" disabled={disabled} onClick={() => void preview("remove", item.name)}>{t("ompPkgRemove")}</button>
			</div>
		</div>)}{view && !view.items.length && <p className="settings-empty">{t("extNoResults")}</p>}</div>
		{view?.marketplace && <OmpMarketplacePanel cwd={cwd} conversationId={conversationId} settingsRequest={request} state={view.marketplace} version={view.version} disabled={disabled} changed={() => setPlan(undefined)} preview={(operation, target, scope, features, version) => { void preview(operation, target, scope, features, version); }} />}
		{jobs.length > 0 && <details className="omp-package-jobs" open><summary>{t("ompPkgJobs")}</summary>{jobs.map(job => <div key={job.id} className="settings-skill-row">
			<div className="settings-skill-info"><strong>{label(job.plan.operation)} · {job.plan.target}</strong>{job.plan.scope && <small>{t(job.plan.scope === "project" ? "ompPkgProject" : "ompPkgUser")}</small>}<small>{phaseLabel(job.phase)}</small>{job.error && <small>{t(job.error === "conflict" ? "ompPkgConflict" : job.error === "busy" ? "ompPkgBusy" : job.error === "invalid" ? "ompPkgInvalid" : "ompPkgInspect")}</small>}</div>
			{job.phase === "running" && <button className="btn" disabled={pending} onClick={() => void act(async () => { await request({ action: "cancel", id: job.id }); await refresh(); })}>{t("ompPkgStop")}</button>}
		</div>)}</details>}
	</section>;
}
