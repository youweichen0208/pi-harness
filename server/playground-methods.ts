/** Browser-safe discovery and validation; Python validates syntax again before execution. */
import { parser } from "@lezer/python";
import type { SyntaxNode } from "@lezer/common";
import type { PlaygroundMethod, PlaygroundCase, PlaygroundValue, PlaygroundTestConfig } from "./protocol.js";
const children = (node: SyntaxNode): SyntaxNode[] => { const result: SyntaxNode[] = []; for (let child = node.firstChild; child; child = child.nextSibling) result.push(child); return result; };
export function discoverPythonMethods(code: string): { methods: PlaygroundMethod[] } {
	const methods: PlaygroundMethod[] = [];
	for (const entry of children(parser.parse(code).topNode)) {
		const node = entry.name === "DecoratedStatement" ? entry.getChild("FunctionDefinition") : entry;
		if (node?.name !== "FunctionDefinition") continue;
		const nameNode = node.getChild("VariableName");
		const params = node.getChild("ParamList");
		if (!nameNode || !params) continue;
		const name = code.slice(nameNode.from, nameNode.to);
		const parts = children(params);
		const parameters: PlaygroundMethod["parameters"] = [];
		let expectName = true, unsupported: string | undefined;
		for (let i = 0; i < parts.length; i++) {
			const part = parts[i], text = code.slice(part.from, part.to);
			if (text === "*" || text === "**") unsupported = "Variadic and keyword-only parameters are not supported in function tests; use Run script.";
			if (text === ",") { expectName = true; continue; }
			if (part.name === "VariableName" && expectName) {
				const annotation = parts[i + 1]?.name === "TypeDef" ? code.slice(parts[i + 1].from, parts[i + 1].to).replace(/^:\s*/, "").trim() : "JSON";
				parameters.push({ name: text, type: annotation === "str" ? "str" : "JSON" });
				expectName = false;
			}
		}
		const annotation = node.getChild("TypeDef");
		const returnType = annotation && code.slice(annotation.from, annotation.to).replace(/^->\s*/, "").trim() === "str" ? "str" : "JSON";
		methods.push({ id: `${name}(${parameters.map(p => p.name).join(",")})`, name, parameters, returnType, unsupported });
	}
	return { methods };
}
export const isReferenceType = (_type: string): boolean => true;
export const isJsonType = (type: string): boolean => type !== "str";
export const valuePlaceholder = (type: string): string => type === "str" ? "text" : '1 / true / "text" / [1, 2] / {"key": 1}';
export function validateCases(method: PlaygroundMethod, cases: PlaygroundCase[]): void {
	if (method.unsupported) throw new Error(method.unsupported);
	if (!cases.length || cases.length > 50) throw new Error("Provide between 1 and 50 test cases");
	for (const [index, test] of cases.entries()) {
		try {
			if (test.args.length !== method.parameters.length) throw new Error("Parameter count does not match the method");
			const values: [string, PlaygroundValue][] = method.parameters.map((p, i) => [p.type, test.args[i]]);
			if (test.expected) values.push([method.returnType, test.expected]);
			for (const [type, value] of values) if (!value.isNull && type !== "str") JSON.parse(value.text);
		} catch (error) { throw new Error(`Case ${index + 1}: ${error instanceof Error ? error.message : error}`); }
	}
}
const isValue = (v: unknown): v is PlaygroundValue => !!v && typeof v === "object" && typeof (v as PlaygroundValue).text === "string" && ((v as PlaygroundValue).isNull === undefined || typeof (v as PlaygroundValue).isNull === "boolean");
export function isCaseList(value: unknown): value is PlaygroundCase[] {
	return Array.isArray(value) && value.length <= 50 && new Set(value.map(v => v?.id)).size === value.length && value.every(v => v && typeof v.id === "string" && v.id.length > 0 && v.id.length <= 100 && Array.isArray(v.args) && v.args.length <= 255 && v.args.every(isValue) && (v.expected === undefined || isValue(v.expected)));
}
export function isTestConfig(value: unknown): value is PlaygroundTestConfig {
	if (!value || typeof value !== "object") return false;
	const config = value as PlaygroundTestConfig;
	return (config.mode === "program" || config.mode === "methods") && typeof config.selectedMethod === "string" && !!config.casesByMethod && typeof config.casesByMethod === "object" && !Array.isArray(config.casesByMethod) && Object.values(config.casesByMethod).every(isCaseList) && new TextEncoder().encode(JSON.stringify(value)).length <= 262144;
}
