import { mkdtempSync, realpathSync, cpSync, mkdirSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { parser } from "@lezer/java";
import { JavaRpc } from "./playground-java-rpc.js";
import { resolveHostJdk } from "./playground-jdk.js";
import type { JavaLanguageResult, JavaTextEdit } from "./protocol.js";

export function javaAnalysisSource(input: string) {
	const tree = parser.parse(input);
	let typeName = "Main", pkg = "", headers = "", body = input, complete = false;
	const nodes = [];
	for (let n = tree.topNode.firstChild; n; n = n.nextSibling) nodes.push(n);
	for (const n of nodes) {
		if (/^(Class|Interface|Enum|Record)Declaration$/.test(n.name) && !complete) {
			complete = true; const name = n.getChild("Definition");
			if (name) typeName = input.slice(name.from, name.to);
		}
		if (n.name === "PackageDeclaration") pkg = input.slice(n.from, n.to).replace(/^\s*package\s+|;\s*$/g, "").trim();
	}
	if (!complete) {
		for (const n of [...nodes].reverse()) if (/^(Import|Package)Declaration$/.test(n.name)) {
			headers = input.slice(n.from, n.to) + "\n" + headers;
			body = body.slice(0, n.from) + body.slice(n.from, n.to).replace(/[^\n]/g, " ") + body.slice(n.to);
		}
	}
	if (!/^[$\p{ID_Start}_][$\p{ID_Continue}_]*$/u.test(typeName) || pkg && !pkg.split(".").every(p => /^[$\p{ID_Start}_][$\p{ID_Continue}_]*$/u.test(p))) throw new Error("Incomplete Java declaration");
	const prefix = complete ? "" : `${headers}public class Main {\n`;
	return { code: complete ? input : prefix + body + "\n}", prefix: prefix.length, file: `${pkg ? pkg.replace(/\./g, "/") + "/" : ""}${typeName}.java` };
}
const position = (code: string, offset: number) => { const lines = code.slice(0, offset).split("\n"); return { line: lines.length - 1, character: lines.at(-1)!.length }; };
const offset = (code: string, pos: { line: number; character: number }) => {
	let result = 0; for (let i = 0; i < pos.line; i++) { const end = code.indexOf("\n", result); if (end < 0) return code.length; result = end + 1; }
	return Math.min(code.length, result + pos.character);
};

export class JavaLanguageSession {
	private root = realpathSync(mkdtempSync(join(tmpdir(), "pi-java-ls-")));
	private rpc: JavaRpc;
	private ready: Promise<unknown>;
	private uri = "";
	private version = 0;
	private source = "";
	private diagnostics: any[] = [];
	private diagnosticVersion = -1;
	private queue: Promise<unknown> = Promise.resolve();
	private pending = 0;
	constructor(home: string, env: NodeJS.ProcessEnv) {
		try {
			const jdk = resolveHostJdk(env); if (!jdk) throw new Error("Java language service requires JDK 21+");
			const launcher = readdirSync(join(home, "plugins")).find(name => /^org.eclipse.equinox.launcher_.*\.jar$/.test(name));
			if (!launcher) throw new Error("JDT Language Server is not installed");
			const project = join(this.root, "project"); mkdirSync(join(project, "src"), { recursive: true });
			writeFileSync(join(project, ".project"), '<projectDescription><name>Playground</name><buildSpec><buildCommand><name>org.eclipse.jdt.core.javabuilder</name></buildCommand></buildSpec><natures><nature>org.eclipse.jdt.core.javanature</nature></natures></projectDescription>');
			writeFileSync(join(project, ".classpath"), '<classpath><classpathentry kind="src" path="src"/><classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/><classpathentry kind="output" path="bin"/></classpath>');
			const config = process.platform === "win32" ? "config_win" : process.platform === "darwin" ? "config_mac" : "config_linux";
			cpSync(join(home, config + (process.arch === "arm64" && process.platform !== "win32" ? "_arm" : "")), join(this.root, "config"), { recursive: true });
			this.rpc = new JavaRpc(jdk.java, [`-Dosgi.install.area=${pathToFileURL(home).href}/`, "-Declipse.application=org.eclipse.jdt.ls.core.id1", "-Dosgi.bundles.defaultStartLevel=4", "-Declipse.product=org.eclipse.jdt.ls.core.product", "-Xmx512m", "--add-modules=ALL-SYSTEM", "--add-opens", "java.base/java.util=ALL-UNNAMED", "--add-opens", "java.base/java.lang=ALL-UNNAMED", "-jar", join(home, "plugins", launcher), "-configuration", join(this.root, "config"), "-data", join(this.root, "data")], this.root, (method, params) => {
				if (method === "textDocument/publishDiagnostics" && params.uri === this.uri) { this.diagnostics = params.diagnostics; this.diagnosticVersion = params.version ?? this.version; }
			});
			this.ready = this.rpc.request("initialize", { processId: process.pid, rootUri: pathToFileURL(project).href, workspaceFolders: [{ uri: pathToFileURL(project).href, name: "Playground" }], capabilities: { textDocument: { completion: { completionItem: { snippetSupport: false } }, publishDiagnostics: { versionSupport: true } } }, initializationOptions: { settings: { java: { import: { gradle: { enabled: false }, maven: { enabled: false } }, autobuild: { enabled: true }, signatureHelp: { enabled: true }, completion: { enabled: true, guessMethodArguments: false } } } } }, 60_000).then(() => this.rpc.notification("initialized", {}));
			this.ready.catch(() => {});
		} catch (error) { rmSync(this.root, { recursive: true, force: true }); throw error; }
	}
	analyze(input: string, cursor: number, action: "completion" | "diagnostics" | "signature"): Promise<JavaLanguageResult> {
		if (this.pending >= 4) return Promise.reject(new Error("Java language service busy"));
		this.pending++;
		const work = this.queue.then(async () => {
			await this.ready;
			const source = javaAnalysisSource(input);
			const file = join(this.root, "project", "src", source.file), uri = pathToFileURL(file).href;
			if (uri !== this.uri) {
				if (this.uri) { this.rpc.notification("textDocument/didClose", { textDocument: { uri: this.uri } }); rmSync(join(this.root, "project", "src"), { recursive: true, force: true }); }
				mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, source.code);
				this.uri = uri; this.diagnostics = []; this.diagnosticVersion = -1;
				this.rpc.notification("textDocument/didOpen", { textDocument: { uri, languageId: "java", version: ++this.version, text: source.code } });
			} else if (this.source !== source.code) this.rpc.notification("textDocument/didChange", { textDocument: { uri, version: ++this.version }, contentChanges: [{ text: source.code }] });
			this.source = source.code;
			const params = { textDocument: { uri }, position: position(source.code, cursor + source.prefix) };
			const edit = (value: any): JavaTextEdit | null => {
				if (!value?.range) return null;
				const from = offset(source.code, value.range.start) - source.prefix, to = offset(source.code, value.range.end) - source.prefix;
				if (from < 0) return /\bimport\s/.test(value.newText) && to <= 0 ? { from: 0, to: 0, text: value.newText } : null;
				return to <= input.length ? { from, to, text: value.newText } : null;
			};
			if (action === "completion") {
				const result = await this.rpc.request("textDocument/completion", params);
				const candidates = (Array.isArray(result) ? result : result?.items ?? []).slice(0, 80);
				const items: NonNullable<JavaLanguageResult["items"]> = [];
				for (const candidate of candidates) {
					const resolved = await this.rpc.request("completionItem/resolve", candidate);
					const item = { ...candidate, ...resolved };
					const main = edit(item.textEdit) ?? { from: cursor - (/[\w$]*$/.exec(input.slice(0, cursor))?.[0].length ?? 0), to: cursor, text: item.insertText ?? item.label };
					items.push({ label: item.label, detail: item.detail, kind: item.kind, info: typeof item.documentation === "string" ? item.documentation : item.documentation?.value, edit: main, additionalEdits: (item.additionalTextEdits ?? []).map(edit).filter((v: JavaTextEdit | null): v is JavaTextEdit => !!v) });
				}
				return { items };
			}
			if (action === "signature") {
				const result = await this.rpc.request("textDocument/signatureHelp", params);
				return { signatures: (result?.signatures ?? []).map((s: { label: string }) => s.label) };
			}
			// Diagnostic publications are asynchronous and versioned; never reuse an old draft's errors.
			await this.rpc.request("textDocument/documentSymbol", { textDocument: { uri } });
			for (let i = 0; i < 30 && this.diagnosticVersion !== this.version; i++) await new Promise(resolve => setTimeout(resolve, 100));
			return { diagnostics: this.diagnosticVersion !== this.version ? [] : this.diagnostics.flatMap(d => {
				const from = offset(source.code, d.range.start) - source.prefix, to = offset(source.code, d.range.end) - source.prefix;
				return from < 0 || to > input.length ? [] : [{ from, to, message: d.message, severity: d.severity === 1 ? "error" as const : d.severity === 2 ? "warning" as const : "info" as const }];
			}) };
		}).finally(() => { this.pending--; });
		this.queue = work.catch(() => {}); return work;
	}
	async close(): Promise<void> { this.rpc.close(); await new Promise(resolve => setTimeout(resolve, 2200)); rmSync(this.root, { recursive: true, force: true }); }
}
