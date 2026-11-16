import { OmpExtensionDirectory } from "./OmpPathButton";
import { useEffect, useState, useRef } from "react";
import { useT } from "../i18n";
import { getClientId } from "../use-chat";
import { withToken } from "../auth-token";

import type { UiOmpSkillSettings, OmpSkillSettingKey, OmpSkillSettingValue } from "../types";
import { OmpExtensionPanel } from "./OmpExtensionPanel";
import { OmpPackagesPanel } from "./OmpPackagesPanel";
import { OmpMcpPanel } from "./OmpMcpPanel";
import { OmpSkillSettings } from "./OmpSkillSettings";
import { DatabaseAgentSettings } from "./DatabaseAgentSettings";

type Resources = { skillSettings?: UiOmpSkillSettings; agentDir: string; skills: { name: string; description: string; path: string }[]; extensions: { name: string; path: string }[]; tools: string[] };

export function OmpResourcesPanel({ cwd, conversationId, section, busy }: { cwd: string; conversationId: string; section: "skills" | "extensions" | "native-mcp"; busy: boolean }) {
	const t = useT();
	const [resources, setResources] = useState<Resources>();
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);
	const pending = useRef<AbortController>();
	const request = async (action: string, payload: Record<string, unknown> = {}) => {
		const controller = new AbortController(); pending.current?.abort(); pending.current = controller;
		setLoading(true); setError("");
		try {
			const response = await fetch(withToken("/api/extensions"), { method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId: getClientId(), cwd, conversationId, action, ...payload }) });
			const data = await response.json(); if (!response.ok) throw Error(data.error ?? response.statusText);
			if (!controller.signal.aborted) setResources(data);
		} catch (error) { if (!controller.signal.aborted) setError((error as Error).message); }
		finally { if (!controller.signal.aborted) setLoading(false); }
	};
	useEffect(() => {
		void request("omp-resources");
		return () => pending.current?.abort();
	}, [cwd, conversationId]);
	const save = (version: string, patch: Partial<Record<OmpSkillSettingKey, OmpSkillSettingValue | null>>) => request("omp-save-skills", { version, patch });
	const items = section === "skills" ? resources?.skills : section === "extensions" ? resources?.extensions : resources?.tools.map(name => ({ name, path: "" }));
	return <section>
		<header className="settings-page-heading"><h2 className="settings-page-title">{t(section === "skills" ? "settingsSkills" : section === "extensions" ? "settingsExtensions" : "ompTools")}</h2>{section === "skills" && <button disabled={busy || loading} onClick={() => { if (!document.querySelector('.omp-skill-settings[data-dirty="true"]') || window.confirm(t("extDiscard"))) void request("omp-reload"); }}>{t("extReload")}</button>}</header>
		{section === "extensions" && <DatabaseAgentSettings key={`${cwd}:${conversationId}`} cwd={cwd} conversationId={conversationId} />}
		<p className="settings-intro">{t("ompResourcesIntro")}</p>
		{section === "extensions" && <OmpExtensionDirectory cwd={cwd} conversationId={conversationId} />}
		{section === "extensions" && <OmpExtensionPanel cwd={cwd} conversationId={conversationId} running={busy} />}
		{section === "extensions" && <OmpPackagesPanel key={`${cwd}:${conversationId}`} cwd={cwd} conversationId={conversationId} busy={busy} />}
		{error && <p role="alert" className="settings-error">{error}</p>}
		{section === "skills" && resources?.skillSettings && <OmpSkillSettings settings={resources.skillSettings} busy={busy || loading} save={save} />}
		{section === "native-mcp" && <OmpMcpPanel cwd={cwd} conversationId={conversationId} busy={busy} />}
		{section !== "extensions" && <div className="settings-group">{items?.map(item => <div className="settings-skill-row" key={item.path || item.name}><span className="settings-skill-info"><code>{item.name}</code>{"description" in item && typeof item.description === "string" && <small>{item.description}</small>}<small>{item.path}</small></span></div>)}{!items?.length && <p className="settings-empty">{t(loading ? "loading" : "extNoResults")}</p>}</div>}
		<footer className="settings-paths"><code>{resources?.agentDir}</code></footer>
	</section>;
}
