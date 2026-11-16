/** Browser drafts only. The native writer remains authoritative for validation and CAS. */
export interface OmpMcpForm {
	name: string;
	type: string;
	command: string;
	url: string;
	cwd: string;
	args: string;
	env: string;
	headers: string;
	timeout: string;
	enabled: "" | "true" | "false";
}
type Document = Record<string, unknown>;
const record = (value: unknown): value is Document => value !== null && typeof value === "object" && !Array.isArray(value);
export class OmpMcpDraftError extends Error {
	constructor(readonly key: "ompMcpFormInvalid" | "ompMcpFormName" | "ompMcpFormExists") { super(key); }
}
const invalid = (): never => { throw new OmpMcpDraftError("ompMcpFormInvalid"); };
export function ompMcpServers(document: Document): Record<string, Document> {
	const servers = document.mcpServers ?? {};
	if (!record(servers) || Object.values(servers).some(value => !record(value))) return invalid();
	return servers as Record<string, Document>;
}
export function ompMcpForm(document: Document, name: string | undefined, scope: string): OmpMcpForm {
	const config = name === undefined ? {} : ompMcpServers(document)[name];
	if (!config) return invalid();
	const text = (key: string) => typeof config[key] === "string" ? config[key] : "";
	const json = (key: string) => config[key] === undefined ? "" : JSON.stringify(config[key], null, 2);
	let enabled: OmpMcpForm["enabled"] = typeof config.enabled === "boolean" ? String(config.enabled) as "true" | "false" : "";
	if (scope === "global" && name !== undefined) {
		if (Array.isArray(document.enabledServers) && document.enabledServers.includes(name)) enabled = "true";
		if (Array.isArray(document.disabledServers) && document.disabledServers.includes(name)) enabled = "false";
	}
	return { name: name ?? "", type: text("type") || "stdio", command: text("command"), url: text("url"), cwd: text("cwd"), args: json("args"), env: json("env"), headers: json("headers"), timeout: config.timeout === undefined ? "" : String(config.timeout), enabled };
}
export function saveOmpMcpForm(document: Document, form: OmpMcpForm, originalName: string | undefined, scope: string): Document {
	const servers = ompMcpServers(document), name = form.name;
	if (!name || name.length > 100 || !/^[a-zA-Z0-9_.:-]+(?: [a-zA-Z0-9_.:-]+)*$/.test(name)) throw new OmpMcpDraftError("ompMcpFormName");
	// Renaming would move masked values to a different restoration path.
	if (originalName !== undefined && name !== originalName) return invalid();
	if (originalName === undefined && Object.hasOwn(servers, name)) throw new OmpMcpDraftError("ompMcpFormExists");
	if (originalName !== undefined && !Object.hasOwn(servers, originalName)) return invalid();
	const initial = ompMcpForm(document, originalName, scope);
	const config = { ...(originalName === undefined ? {} : servers[originalName]) };
	const setText = (key: "command" | "url" | "cwd") => { if (form[key]) config[key] = form[key]; else delete config[key]; };
	const setJson = (key: "args" | "env" | "headers") => {
		if (!form[key].trim()) { delete config[key]; return; }
		let value: unknown; try { value = JSON.parse(form[key]); } catch { return invalid(); }
		if (key === "args" ? !Array.isArray(value) || value.some(item => typeof item !== "string") : !record(value) || Object.values(value).some(item => typeof item !== "string")) return invalid();
		config[key] = value;
	};
	if (!["stdio", "http", "sse"].includes(form.type)) return invalid();
	if (form.type !== initial.type || originalName === undefined) config.type = form.type;
	if (form.type === "stdio") {
		if (!form.command.trim()) return invalid();
		setText("command"); setText("cwd"); setJson("args"); setJson("env");
		if (form.type !== initial.type) { delete config.url; delete config.headers; }
	} else {
		if (!form.url.trim()) return invalid();
		setText("url"); setJson("headers");
		if (form.type !== initial.type) for (const key of ["command", "cwd", "args", "env"]) delete config[key];
	}
	if (!form.timeout.trim()) delete config.timeout;
	else {
		const value = Number(form.timeout);
		if (!Number.isFinite(value) || value < 0) return invalid();
		config.timeout = value;
	}
	const result: Document = { ...document, mcpServers: { ...servers, [name]: config } };
	if (form.enabled !== initial.enabled) {
		if (form.enabled === "") delete config.enabled; else config.enabled = form.enabled === "true";
		if (scope === "global") {
			// Native global deny wins over allow, which wins over per-server enabled.
			for (const [key, include] of [["disabledServers", form.enabled === "false"], ["enabledServers", form.enabled === "true"]] as const) {
				const old = document[key];
				if (old !== undefined && (!Array.isArray(old) || old.some(item => typeof item !== "string"))) return invalid();
				const values = (Array.isArray(old) ? old : []).filter(item => item !== name);
				if (include) values.push(name);
				if (values.length) result[key] = values; else delete result[key];
			}
		}
	}
	return result;
}
export function removeOmpMcpServer(document: Document, name: string): Document {
	const servers = ompMcpServers(document);
	if (!Object.hasOwn(servers, name)) return invalid();
	const { [name]: removed, ...remaining } = servers;
	// Match native remove: global rules may also target servers discovered elsewhere.
	return { ...document, mcpServers: remaining };
}
