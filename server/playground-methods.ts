/** Browser-safe Java method discovery and typed input validation. No execution. */
import { parser } from "@lezer/java";
import type { PlaygroundCase, PlaygroundMethod, PlaygroundTestConfig, PlaygroundValue } from "./protocol.js";

type Node = ReturnType<typeof parser.parse>["topNode"];
const children = (node: Node | null): Node[] => {
	if (!node) return [];
	const result: Node[] = [];
	for (let child = node.firstChild; child; child = child.nextSibling) result.push(child);
	return result;
};
const TYPES = new Set(["byte", "short", "int", "long", "float", "double", "boolean", "char", "Byte", "Short", "Integer", "Long", "Float", "Double", "Boolean", "Character", "String"]);
const unbox: Record<string, string> = { Byte: "byte", Short: "short", Integer: "int", Long: "long", Float: "float", Double: "double", Boolean: "boolean", Character: "char" };
const normalizeType = (text: string) => text.replace(/\s/g, "").replace(/\bjava\.lang\./g, "").replace(/\bjava\.util\.List</g, "List<");
export const listElementType = (type: string): string | undefined => /^List<(.+)>$/.exec(normalizeType(type))?.[1];
export const isReferenceType = (type: string): boolean => type.endsWith("[]") || /^[A-Z]/.test(normalizeType(type));
export const isJsonType = (type: string): boolean => type.endsWith("[]") || listElementType(type) !== undefined;
export function supportedType(type: string, depth = 0): boolean {
	if (depth >= 64) return false;
	type = normalizeType(type);
	const element = listElementType(type);
	if (element !== undefined) return !element.endsWith("[]") && (Object.hasOwn(unbox, element) || element === "String" || (listElementType(element) !== undefined && supportedType(element, depth + 1)));
	return TYPES.has(type.replace(/(?:\[\])+$/, ""));
}
const javaType = (type: string): string => normalizeType(type).replace(/\bList</g, "java.util.List<");
export const reflectionType = (type: string): string => listElementType(type) !== undefined ? "java.util.List" : type;
export function valuePlaceholder(type: string): string {
	if (!supportedType(type)) return "";
	type = normalizeType(type);
	const element = listElementType(type);
	if (element !== undefined) return `[${valuePlaceholder(element) || "1"}]`;
	if (type.endsWith("[]")) return "[1, 2]";
	if (type === "String" || type === "Character") return '"a"';
	if (type === "boolean" || type === "Boolean") return "true";
	return "";
}

export function discoverJavaMethods(input: string): { code: string; fileName: string; methods: PlaygroundMethod[] } {
	let code = input;
	let tree = parser.parse(code);
	let top = children(tree.topNode);
	// Only compilation-unit declarations count: local/nested classes do not turn
	// a method fragment into a complete source file.
	if (!top.some(node => /^(Class|Interface|Enum|Record|AnnotationType)Declaration$/.test(node.name))) {
		const headers = top.filter(node => node.name === "ImportDeclaration" || node.name === "PackageDeclaration");
		let body = code;
		for (const node of [...headers].reverse()) body = body.slice(0, node.from) + body.slice(node.from, node.to).replace(/[^\n]/g, " ") + body.slice(node.to);
		code = `${headers.map(node => code.slice(node.from, node.to)).join("\n")}\npublic class Main {\n${body}\n}`;
		tree = parser.parse(code);
		top = children(tree.topNode);
	}
	const text = (node: Node | null) => node ? code.slice(node.from, node.to) : "";
	const modifiers = (node: Node) => children(node.getChild("Modifiers") ?? node).map(n => n.name);
	const pkg = top.find(n => n.name === "PackageDeclaration");
	const identifiers = (node: Node): string[] => node.name === "Identifier" ? [text(node)] : children(node).flatMap(identifiers);
	const packageName = pkg ? identifiers(pkg).join(".") : "";
	const declarations = top.filter(node => /^(Class|Interface|Enum|Record)Declaration$/.test(node.name));
	const owner = declarations.find(node => modifiers(node).includes("public")) ?? declarations[0];
	const fileName = `${packageName ? packageName.replace(/\./g, "/") + "/" : ""}${owner ? text(owner.getChild("Definition")) : "Main"}.java`;
	const methods: PlaygroundMethod[] = [];
	// Incomplete code is normal while typing. Never turn parser recovery text
	// into a filesystem path or generated Java identifier.
	const validName = (name: string) => /^[$_\p{ID_Start}][$_\p{ID_Continue}]*$/u.test(name);
	if (packageName.split(".").some(name => name && !validName(name)) || (owner && !validName(text(owner.getChild("Definition"))))) return { code, fileName: "Main.java", methods };
	for (const klass of declarations.filter(n => n.name === "ClassDeclaration")) {
		if (!validName(text(klass.getChild("Definition")))) continue;
		const className = `${packageName ? packageName + "." : ""}${text(klass.getChild("Definition"))}`;
		const members = children(klass.getChild("ClassBody")!);
		const constructors = members.filter(n => n.name === "ConstructorDeclaration");
		const constructible = !modifiers(klass).includes("abstract") && (!constructors.length || constructors.some(n => modifiers(n).includes("public") && !children(n.getChild("FormalParameters")!).some(p => /Parameter$/.test(p.name))));
		for (const node of members.filter(n => n.name === "MethodDeclaration" && modifiers(n).includes("public"))) {
			const parts = children(node);
			const name = text(node.getChild("Definition"));
			if (!validName(name)) continue;
			const returnNode = parts.find(n => /Type$|TypeName$/.test(n.name) || n.name === "void");
			const returnType = normalizeType(text(returnNode ?? null)) + "[]".repeat(parts.filter(n => n.name === "Dimension").length);
			const parameters = children(node.getChild("FormalParameters")!).filter(n => /Parameter$/.test(n.name)).map(param => {
				const items = children(param);
				const type = items.find(n => /Type$|TypeName$/.test(n.name));
				return { name: text(param.getChild("Definition") ?? param.getChild("VariableDeclarator")?.getChild("Definition") ?? null), type: normalizeType(text(type ?? null)) + "[]".repeat(items.filter(n => n.name === "Dimension").length + (param.name === "SpreadParameter" ? 1 : 0)) };
			});
			const isStatic = modifiers(node).includes("static");
			if (name === "main" && isStatic && returnType === "void" && parameters.length === 1 && parameters[0].type === "String[]") continue;
			let unsupported: string | undefined;
			if (parameters.some(p => !supportedType(p.type)) || (returnType !== "void" && !supportedType(returnType))) unsupported = "Only primitive types, boxed types, String, arrays and Lists of boxed types, String or Lists are supported.";
			if (node.getChild("TypeParameters") || klass.getChild("TypeParameters")) unsupported = "Generic methods and classes are not supported.";
			if (!unsupported && !isStatic && !constructible) unsupported = "Instance methods require a concrete class with a default or public no-argument constructor.";
			if (!node.getChild("Block")) unsupported = "The method must have an implementation.";
			methods.push({ id: `${className}#${name}(${parameters.map(p => p.type).join(",")})`, className, name, parameters, returnType, isStatic, ...(unsupported ? { unsupported } : {}) });
		}
	}
	return { code, fileName, methods };
}

// UTF-16 character construction avoids Java's pre-lexing Unicode escapes and
// source injection, including quotes, backslashes, newlines and lone surrogates.
function javaString(value: string): string {
	return `new String(new char[]{${value.split("").map(c => `(char)${c.charCodeAt(0)}`).join(",")}})`;
}
function scalarLiteral(type: string, value: unknown): string {
	if (value === null) {
		if (!isReferenceType(type)) throw new Error(`${type} cannot be null`);
		return `(${javaType(type)})null`;
	}
	const element = listElementType(type);
	if (element !== undefined) {
		if (!Array.isArray(value)) throw new Error(`${type} requires a JSON array`);
		return `new java.util.ArrayList<${javaType(element)}>(java.util.Arrays.<${javaType(element)}>asList(${value.map(v => scalarLiteral(element, v)).join(",")}))`;
	}
	if (type.endsWith("[]")) {
		if (!Array.isArray(value)) throw new Error(`${type} requires a JSON array`);
		return `new ${type}{${value.map(v => scalarLiteral(type.slice(0, -2), v)).join(",")}}`;
	}
	if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") throw new Error(`Invalid ${type} value`);
	const primitive = unbox[type] ?? type;
	let literal: string;
	if (primitive === "String" || primitive === "char") {
		if (typeof value !== "string") throw new Error(`${type} requires text`);
		if (primitive === "char" && value.length !== 1) throw new Error("char requires exactly one UTF-16 character");
		literal = primitive === "char" ? `(char)${value.charCodeAt(0)}` : javaString(value);
	} else if (primitive === "boolean") {
		if (value !== true && value !== false && value !== "true" && value !== "false") throw new Error("boolean requires true or false");
		literal = String(value);
	} else if (["byte", "short", "int", "long"].includes(primitive)) {
		if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("Large integers in arrays or Lists must be quoted decimal strings");
		if (!/^[+-]?\d+$/.test(String(value))) throw new Error(`${type} requires an integer`);
		const number = BigInt(String(value));
		const bits = { byte: 8n, short: 16n, int: 32n, long: 64n }[primitive]!;
		if (number < -(1n << (bits - 1n)) || number >= (1n << (bits - 1n))) throw new Error(`${type} is out of range`);
		literal = primitive === "long" ? `${number}L` : `(${primitive})${number}`;
	} else {
		if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(String(value))) throw new Error(`${type} requires a finite number`);
		const number = Number(value);
		if (!Number.isFinite(number) || (primitive === "float" && !Number.isFinite(Math.fround(number)))) throw new Error(`${type} is out of range`);
		literal = `${primitive === "float" ? "Float" : "Double"}.parse${primitive === "float" ? "Float" : "Double"}(${javaString(String(value))})`;
	}
	return unbox[type] ? `${type}.valueOf(${literal})` : literal;
}
export function valueLiteral(type: string, value: PlaygroundValue): string {
	if (!supportedType(type)) throw new Error(`Unsupported type: ${type}`);
	return scalarLiteral(normalizeType(type), value.isNull ? null : isJsonType(type) ? JSON.parse(value.text) : value.text);
}
export function validateCases(method: PlaygroundMethod, cases: PlaygroundCase[]): void {
	if (method.unsupported) throw new Error(method.unsupported);
	if (!cases.length || cases.length > 50) throw new Error("Provide between 1 and 50 test cases");
	for (const [index, test] of cases.entries()) {
		try {
			if (test.args.length !== method.parameters.length) throw new Error("Parameter count does not match the method");
			method.parameters.forEach((p, i) => valueLiteral(p.type, test.args[i]));
			if (test.expected) valueLiteral(method.returnType, test.expected);
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
