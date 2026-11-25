// Static TypeScript graph extraction shared by the product worker and the offline oracle.
import ts from "typescript";
import { posix } from "node:path";

const property = n => n && ts.isPropertyAccessExpression(n);
const isThis = n => n?.kind === ts.SyntaxKind.ThisKeyword;
const own = n => property(n) && isThis(n.expression);
const paramSymbol = (checker, method, i) => method.parameters[i] && checker.getSymbolAtLocation(method.parameters[i].name);
const symbol = (checker, n) => ts.isIdentifier(n) ? checker.getSymbolAtLocation(n) : undefined;
const declaration = (checker, n) => checker.getSymbolAtLocation(n)?.valueDeclaration;

function visit(node, fn, enterFunctions = true) {
	if (!enterFunctions && ts.isFunctionLike(node)) return;
	fn(node);
	ts.forEachChild(node, child => visit(child, fn, enterFunctions));
}

// Recognize ordinary statements and the body of try, but do not claim a
// structurally validated route through conditional/loop or catch bodies.
function directStatementPath(start, body, allowPrevious) {
	for (let node = start; node !== body; node = node.parent) {
		const parent = node.parent;
		if (ts.isExpressionStatement(parent)) continue;
		if (ts.isTryStatement(parent) && parent.tryBlock === node) continue;
		if (!ts.isBlock(parent)) return false;
		for (const previous of parent.statements) {
			if (previous === node) break;
			if (allowPrevious) {
				if (!allowPrevious(previous)) return false;
				continue;
			}
			if (ts.isVariableStatement(previous) || ts.isExpressionStatement(previous)) continue;
			if (ts.isIfStatement(previous) && previous.expression.kind !== ts.SyntaxKind.TrueKeyword && !previous.elseStatement) continue;
			return false;
		}
	}
	return true;
}

// Prove that earlier statements allow this particular discriminant to
// reach its handler. An unknown branch that can change it or exit is a gap.
function handlerPrefix(checker, parameter, key, value) {
	function unwrap(node) {
		while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)
			|| ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
		return node;
	}
	const isParam = n => symbol(checker, unwrap(n)) === parameter;
	function isTag(n) {
		const node = unwrap(n);
		if (property(node)) return isParam(node.expression) && node.name.text === key;
		return ts.isElementAccessExpression(node) && isParam(node.expression) && ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === key;
	}
	function test(expr) {
		const n = unwrap(expr);
		if (n.kind === ts.SyntaxKind.TrueKeyword || n.kind === ts.SyntaxKind.FalseKeyword) return n.kind === ts.SyntaxKind.TrueKeyword;
		if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.ExclamationToken) {
			const evaluated = test(n.operand);
			return evaluated === undefined ? undefined : !evaluated;
		}
		if (!ts.isBinaryExpression(n)) return undefined;
		const op = n.operatorToken.kind;
		if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
			const a = test(n.left), b = test(n.right);
			const decisive = op === ts.SyntaxKind.BarBarToken;
			if (a === decisive || b === decisive) return decisive;
			return a === !decisive && b === !decisive ? !decisive : undefined;
		}
		const compared = isTag(n.left) ? unwrap(n.right) : isTag(n.right) ? unwrap(n.left) : undefined;
		if (!compared || !ts.isStringLiteral(compared)) return undefined;
		if (op === ts.SyntaxKind.EqualsEqualsEqualsToken) return value === compared.text;
		if (op === ts.SyntaxKind.ExclamationEqualsEqualsToken) return value !== compared.text;
	}
	function writesOrAliases(expression) {
		let found = false;
		visit(expression, part => {
			if (ts.isBinaryExpression(part) && part.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
				&& part.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
				const lhs = unwrap(part.left);
				if (isParam(lhs) || isTag(lhs) || ts.isElementAccessExpression(lhs) && isParam(lhs.expression) || isParam(part.right)) found = true;
			}
			if (ts.isVariableDeclaration(part) && part.initializer && isParam(part.initializer)) found = true;
			if (ts.isDeleteExpression(part) && isTag(part.expression)) found = true;
			if ((ts.isPrefixUnaryExpression(part) || ts.isPostfixUnaryExpression(part)) && (part.operator === ts.SyntaxKind.PlusPlusToken
				|| part.operator === ts.SyntaxKind.MinusMinusToken) && (isTag(part.operand) || isParam(part.operand))) found = true;
			if (ts.isCallExpression(part) && property(part.expression) && part.arguments[0] && isParam(part.arguments[0])
				&& ["assign", "defineProperty", "defineProperties", "set", "deleteProperty"].includes(part.expression.name.text)) found = true;
		});
		return found;
	}
	function fallsThrough(statement) {
		if (ts.isBlock(statement)) return statement.statements.every(fallsThrough);
		if (ts.isIfStatement(statement)) {
			if (writesOrAliases(statement.expression)) return false;
			const condition = test(statement.expression);
			return (condition === false || fallsThrough(statement.thenStatement))
				&& (condition === true || !statement.elseStatement || fallsThrough(statement.elseStatement));
		}
		return (ts.isVariableStatement(statement) || ts.isExpressionStatement(statement) || ts.isEmptyStatement(statement))
			&& !writesOrAliases(statement);
	}
	return fallsThrough;
}

// Interpret declaration emission settings only from explicit, in-source tsc
// config files. Unsupported external bases leave the mapping unresolved.
function declarationConfig(files, file, seen = new Set()) {
	if (!files.has(file) || seen.has(file) || seen.size >= 12) return;
	const parsed = ts.parseConfigFileTextToJson(file, files.get(file).text);
	if (parsed.error || !parsed.config) return;
	const config = parsed.config, inherited = {};
	const bases = config.extends === undefined ? [] : Array.isArray(config.extends) ? config.extends : [config.extends];
	for (const base of bases) {
		if (typeof base !== "string" || !base.startsWith(".")) return;
		const path = posix.resolve(posix.dirname(file), base.endsWith(".json") ? base : base + ".json");
		if (path.split("/")[1] !== file.split("/")[1]) return;
		const parent = declarationConfig(files, path, new Set([...seen, file]));
		if (!parent) return;
		Object.assign(inherited, parent.options);
	}
	return { local: config.compilerOptions ?? {}, options: { ...inherited, ...config.compilerOptions } };
}

export function packageResolver(files) {
	const byRoot = new Map(), byName = new Map(), publicEntries = new Map();
	for (const [file, entry] of files) {
		if (posix.basename(file) !== "package.json") continue;
		const manifest = JSON.parse(entry.text);
		if (manifest === null || typeof manifest !== "object") throw Error("Invalid package manifest");
		const root = posix.dirname(file);
		byRoot.set(root, manifest);
		const named = byName.get(manifest.name) ?? [];
		named.push({ root, manifest });
		byName.set(manifest.name, named);
	}
	return (specifier, importer) => {
		if (specifier.startsWith(".")) {
			const name = posix.resolve(posix.dirname(importer), specifier);
			if (name.split("/")[1] !== importer.split("/")[1]) return undefined;
			if (files.has(name) && /\.(?:tsx?|mts|cts)$/.test(name)) return name;
			const substitution = name.match(/^(.*)\.(js|jsx|mjs|cjs)$/);
			const stems = substitution ? [substitution[1]] : [name, posix.join(name, "index")];
			const extensions = substitution ? { js: [".ts", ".tsx"], jsx: [".tsx"], mjs: [".mts"], cjs: [".cts"] }[substitution[2]] : [".ts", ".tsx", ".mts", ".cts"];
			const choices = stems.flatMap(stem => extensions.map(ext => stem + ext)).filter(file => files.has(file));
			return choices.length === 1 ? choices[0] : undefined;
		}
		let directory = posix.dirname(importer);
		while (directory !== "/" && !byRoot.has(directory)) directory = posix.dirname(directory);
		const pin = byRoot.get(directory)?.dependencies?.[specifier];
		if (typeof pin !== "string" || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(pin)) return undefined;
		const matches = (byName.get(specifier) ?? []).filter(p => pin === p.manifest.version);
		if (matches.length !== 1) return undefined;
		const { root, manifest } = matches[0];
		if (publicEntries.has(root)) return publicEntries.get(root);
		const exports = manifest.exports;
		const keys = exports && typeof exports === "object" ? Object.keys(exports) : [];
		const subpaths = keys.some(k => k.startsWith("."));
		if (Array.isArray(exports) || subpaths && (!Object.hasOwn(exports, ".") || keys.some(k => !k.startsWith(".")))) return undefined;
		const publicRoot = subpaths ? exports["."] : exports;
		const target = exports === undefined ? manifest.types
			: typeof publicRoot === "string" ? publicRoot : publicRoot?.types ?? publicRoot?.import ?? publicRoot?.default;
		if (typeof target !== "string" || (exports !== undefined && !target.startsWith("./")) || /[\\*]/.test(target) || posix.isAbsolute(target) || target.split("/").includes("..")) return undefined;
		const direct = posix.join(root, target);
		if (direct.startsWith(root + "/") && /\.(?:tsx?|mts|cts)$/.test(direct) && files.has(direct)) {
			publicEntries.set(root, direct);
			return direct;
		}
		// Only accept the unbundled tsc script and explicit local source/output
		// roots. A same-named class elsewhere in the workspace cannot bind.
		const entries = new Set();
		for (const [name, script] of Object.entries(manifest.scripts ?? {})) {
			if (!/^build(?:$|:)/.test(name) || typeof script !== "string") continue;
			const config = /(?:^|&&\s*)tsc -p ([\w./-]+\.json)(?:\s*&&|$)/.exec(script);
			const configPath = config && posix.join(root, config[1]);
			if (!configPath?.startsWith(root + "/")) continue;
			const configInfo = declarationConfig(files, configPath);
			if (!configInfo) continue;
			const { rootDir, outDir } = configInfo.local;
			const { noEmit, declaration, composite, declarationDir, outFile } = configInfo.options;
			if (typeof rootDir !== "string" || typeof outDir !== "string" || noEmit === true || declarationDir || outFile
				|| declaration !== true && !(composite === true && declaration === undefined)) continue;
			const configDir = posix.dirname(configPath);
			const suffix = posix.relative(posix.join(configDir, outDir), posix.join(root, target));
			if (suffix.startsWith("..") || !suffix.endsWith(".d.ts")) continue;
			const source = posix.join(configDir, rootDir, suffix.replace(/\.d\.ts$/, ".ts"));
			if (source.startsWith(root + "/") && files.has(source)) entries.add(source);
		}
		const result = entries.size === 1 ? [...entries][0] : undefined;
		publicEntries.set(root, result);
		return result;
	};
}

// One source-level witness per import or re-export statement. A declaration
// with several named bindings establishes the same module-to-module dependency.
function packageLinks(checker, parsed, resolve, ref, limit) {
	const links = [];
	for (const file of parsed.values()) {
		for (const statement of file.statements) {
			const isImport = ts.isImportDeclaration(statement);
			if (!isImport && !ts.isExportDeclaration(statement)) continue;
			const name = statement.moduleSpecifier;
			if (!name || !ts.isStringLiteral(name) || name.text.startsWith(".")) continue;
			const entryPath = resolve(name.text, file.fileName);
			if (!entryPath || file.fileName.split("/")[1] === entryPath.split("/")[1]) continue;
			const entry = parsed.get(entryPath);
			const module = entry && checker.getSymbolAtLocation(entry);
			if (!module) continue;
			const bindings = [];
			if (isImport && statement.importClause?.name) bindings.push(["default", statement.importClause.name]);
			const named = isImport ? statement.importClause?.namedBindings : statement.exportClause;
			if (named?.elements) for (const el of named.elements) {
				const binding = el.propertyName ?? el.name;
				bindings.push([binding.text, binding]);
			}
			const exports = checker.getExportsOfModule(module);
			for (const [binding, token] of bindings) {
				const exposed = exports.find(sym => sym.name === binding);
				// A wildcard-only barrel, conflicted declaration or unresolved
				// re-export cannot supply the named public source location.
				const declarations = exposed?.declarations;
				if (declarations?.length !== 1 || declarations[0].getSourceFile() !== entry) continue;
				const original = exposed.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exposed) : exposed;
				const origin = original?.declarations?.find(d => parsed.has(d.getSourceFile().fileName));
				if (!origin) continue;
				const via = declarations[0];
				const typeOnly = !!(isImport ? statement.importClause?.isTypeOnly : statement.isTypeOnly)
					|| token.parent.isTypeOnly === true || !(original.flags & ts.SymbolFlags.Value);
				const anchors = [{ role: "import", ...ref(token) }, { role: "export", ...ref(via.name ?? via) }];
				if (origin !== via) anchors.push({ role: "definition", ...ref(origin.name ?? origin) });
				links.push({ specifier: name.text, binding, typeOnly, operation: isImport ? "imports" : "re-exports", anchors });
				if (links.length > limit) throw Error("Workspace Graph exceeds the package import limit.");
				break;
			}
		}
	}
	return links;
}

export function analyze(files, parsed, maximumPaths = Infinity, includePackageLinks = false) {
	const resolve = packageResolver(files);
	const host = {
		getSourceFile: name => parsed.get(name),
		getDefaultLibFileName: () => "", getCurrentDirectory: () => "/", getNewLine: () => "\n",
		fileExists: name => files.has(name), readFile: name => files.get(name)?.text,
		useCaseSensitiveFileNames: () => true, getCanonicalFileName: name => name, writeFile() {},
		resolveModuleNames: (names, importer) => names.map(spec => {
			const file = resolve(spec, importer);
			return file ? { resolvedFileName: file, extension: ts.Extension.Ts } : undefined;
		}),
	};
	const program = ts.createProgram([...parsed.keys()], { noLib: true, types: [], target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext }, host);
	const checker = program.getTypeChecker();
	const fanouts = new Map(), registrations = new Map(), switches = new Map();
	const emissions = [], subscriptions = [];
	function ref(node) {
		const f = node.getSourceFile();
		const [, source, ...parts] = f.fileName.split("/");
		let member = node;
		while (member.parent && !(member.name && (ts.isClassDeclaration(member.parent) || ts.isInterfaceDeclaration(member.parent)))) member = member.parent;
		const owner = member.parent?.name && member.name ? member.parent.name.getText() + "." + member.name.getText() : undefined;
		const ownerOffset = owner ? member.getStart(f) : undefined;
		return { source, path: parts.join("/"), owner, ownerOffset, line: f.getLineAndCharacterOfPosition(node.getStart(f)).line + 1,
			endLine: f.getLineAndCharacterOfPosition(node.getEnd() - 1).line + 1, sha256: files.get(f.fileName).sha256 };
	}
	function registry(expr, method) {
		if (!own(expr)) return undefined;
		const field = declaration(checker, expr.name);
		return field?.parent === method.parent && ts.isPropertyDeclaration(field) && field.initializer && ts.isArrayLiteralExpression(field.initializer) ? field : undefined;
	}
	for (const file of parsed.values()) {
		visit(file, method => {
			if (!ts.isMethodDeclaration(method) || !method.body) return;
			const first = method.body.statements[0];
			const event = paramSymbol(checker, method, 0);
			if (first && event && ts.isForOfStatement(first) && ts.isVariableDeclarationList(first.initializer) && ts.isBlock(first.statement)) {
				const field = registry(first.expression, method);
				const variable = first.initializer.declarations[0];
				const statement = first.statement.statements[0];
				const call = statement && ts.isExpressionStatement(statement) && statement.expression;
				if (field && variable && call && ts.isCallExpression(call) && symbol(checker, call.expression) === checker.getSymbolAtLocation(variable.name)
					&& call.arguments.length === 1 && symbol(checker, call.arguments[0]) === event) {
					fanouts.set(method, { field, evidence: ref(call) });
				}
			}
			if (first && ts.isExpressionStatement(first) && ts.isCallExpression(first.expression)) {
				const call = first.expression, fn = call.expression;
				const field = property(fn) && fn.name.text === "push" && registry(fn.expression, method);
				if (event && field && call.arguments.length === 1 && symbol(checker, call.arguments[0]) === event) registrations.set(method, { field, evidence: ref(call) });
			}
			visit(method.body, node => {
				if (ts.isSwitchStatement(node) && property(node.expression)) {
					const discriminated = symbol(checker, node.expression.expression);
					if (!discriminated) return;
					const idx = method.parameters.findIndex(p => checker.getSymbolAtLocation(p.name) === discriminated);
					if (idx < 0) return;
					for (const clause of node.caseBlock.clauses) {
						if (!ts.isCaseClause(clause) || !ts.isStringLiteral(clause.expression)) continue;
						const allowed = handlerPrefix(checker, discriminated, node.expression.name.text, clause.expression.text);
						if (!directStatementPath(node, method.body, allowed)) continue;
						const statements = clause.statements.length === 1 && ts.isBlock(clause.statements[0]) ? clause.statements[0].statements : clause.statements;
						for (const statement of statements) {
							if (!allowed(statement)) break;
							const write = ts.isExpressionStatement(statement) && statement.expression;
							if (!write || !ts.isBinaryExpression(write) || write.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !property(write.left)) continue;
							const result = { idx, key: node.expression.name.text, value: clause.expression.text, target: write.left.getText(), guard: ref(clause.expression), write: ref(write) };
							const list = switches.get(method) ?? [];
							list.push(result);
							switches.set(method, list);
						}
					}
				}
				if (!ts.isCallExpression(node) || !property(node.expression)) return;
				const [arg] = node.arguments;
				if (own(node.expression) && arg && ts.isObjectLiteralExpression(arg)) {
					if (!directStatementPath(node, method.body)) return;
					// Reject dynamic/spread keys to prevent an overwritten tag from becoming an edge.
					if (!arg.properties.every(p => p.name && ts.isIdentifier(p.name))) return;
					for (const tag of arg.properties) {
						if (!ts.isPropertyAssignment(tag) || !ts.isStringLiteral(tag.initializer)) continue;
						if (arg.properties.filter(p => p.name.text === tag.name.text).length !== 1) continue;
						emissions.push({ fn: declaration(checker, node.expression.name), key: tag.name.text, value: tag.initializer.text, evidence: ref(node) });
					}
				}
				if (!arg || !ts.isArrowFunction(arg) || !arg.parameters.length) return;
				const callback = paramSymbol(checker, arg, 0);
				const uses = [];
				visit(arg.body, part => { if (callback && symbol(checker, part) === callback) uses.push(part); });
				if (uses.length !== 1) return;
				const receiver = node.expression.expression;
				const receiverDecl = property(receiver) && declaration(checker, receiver.name);
				const target = checker.getResolvedSignature(node)?.declaration;
				visit(arg.body, forwarded => {
					if (!ts.isCallExpression(forwarded) || !own(forwarded.expression) || !directStatementPath(forwarded, arg.body)) return;
					const fn = declaration(checker, forwarded.expression.name);
					forwarded.arguments.forEach((param, idx) => {
						if (uses[0] === param) subscriptions.push({
							target, targetName: node.expression.name.text, receiver: receiverDecl && ref(receiverDecl), subscribe: ref(node.expression),
							fn, idx, forward: ref(forwarded),
						});
					});
				}, false);
			}, false);
		});
	}
	const paths = [], candidates = [];
	for (const sub of subscriptions) {
		for (const sink of switches.get(sub.fn) ?? []) {
			if (sub.idx !== sink.idx) continue;
			const downstream = { ...sink, subscribe: sub.subscribe, forward: sub.forward };
			candidates.push(downstream);
			const registered = registrations.get(sub.target);
			if (!registered) continue;
			for (const source of emissions) {
				const broadcast = fanouts.get(source.fn);
				if (source.key !== sink.key || source.value !== sink.value || broadcast?.field !== registered.field) continue;
				const path = { ...downstream, receiver: sub.receiver, register: registered.evidence, broadcast: broadcast.evidence, emit: source.evidence };
				path.anchors = ["emit", "broadcast", "register", "receiver", "subscribe", "forward", "guard", "write"]
					.filter(role => path[role]).map(role => ({ role, ...path[role] }));
				if (paths.length >= maximumPaths) throw new Error("Workspace Graph exceeded the proven flow limit.");
				paths.push(path);
			}
		}
	}
	return { paths, candidates, packages: includePackageLinks ? packageLinks(checker, parsed, resolve, ref, 25_000) : [] };
}
