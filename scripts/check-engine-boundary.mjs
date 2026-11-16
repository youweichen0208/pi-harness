/** Production source and build output must not depend on the retired Pi SDK. */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
const root = process.cwd(), violations = [];
const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
for (const name of Object.keys(manifest.dependencies ?? {})) if (name.startsWith('@earendil-works/')) violations.push(`production dependency: ${name}`);
for (const name of Object.keys(manifest.devDependencies ?? {})) if (name.startsWith('@earendil-works/')) violations.push(`development dependency: ${name}`);
const config = ts.readConfigFile('tsconfig.production.json', ts.sys.readFile);
if (config.error) throw Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
if (parsed.errors.length) throw Error(parsed.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
// Type imports count too: otherwise a transport interface can drag the entire
// old agent into tsc's emitted output even when runtime imports are clean.
const program = ts.createProgram({ rootNames: [...parsed.fileNames, path.join(root, 'extensions/webui.ts')], options: parsed.options });
// TypeScript uses forward slashes on Windows; compare native absolute paths.
const sources = program.getSourceFiles().filter(file => path.resolve(file.fileName).startsWith(root + path.sep) && !path.resolve(file.fileName).includes(path.sep + 'node_modules' + path.sep));
if (!sources.some(source => path.resolve(source.fileName) === path.join(root, 'server/index.ts'))) {
	throw Error('Production source graph does not include server/index.ts');
}
const checked = new Map(sources.map(source => [path.resolve(source.fileName), source]));
// Retired imports must not survive in tests, development-only modules or scripts.
function collect(directory) {
	if (!fs.existsSync(directory)) return;
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const file = path.join(directory, entry.name);
		if (entry.isDirectory()) { if (entry.name !== 'scratch' && entry.name !== 'local') collect(file); }
		else if (/\.(?:ts|tsx|mjs|cjs)$/.test(entry.name) && !checked.has(file)) checked.set(file, ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true));
	}
}
for (const directory of ['server', 'extensions', 'web/src', 'tests', 'scripts', 'dev/context-eval']) collect(path.join(root, directory));
for (const source of checked.values()) {
	function walk(node) {
		let spec;
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) spec = node.moduleSpecifier?.text;
		if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) spec = node.argument.literal.text;
		if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) spec = node.moduleReference.expression.text;
		if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require') && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) spec = node.arguments[0].text;
		if (spec && /(?:^|\/)@earendil-works\//.test(spec)) violations.push(`${path.relative(root, source.fileName)} -> ${spec}`);
		ts.forEachChild(node, walk);
	}
	walk(source);
}
if (process.argv.includes('--built')) {
	const directory = path.join(root, 'dist/server');
	const expected = new Set(sources.filter(source => !source.isDeclarationFile && path.resolve(source.fileName).startsWith(path.join(root, 'server') + path.sep)).map(source => path.relative(path.join(root, 'server'), source.fileName).replace(/\.ts$/, '.js')));
	for (const file of expected) if (!fs.existsSync(path.join(directory, file))) violations.push(`missing production output: ${file}`);
	function inspect(dir) {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const file = path.join(dir, entry.name);
			if (entry.isDirectory()) inspect(file);
			else if (entry.name.endsWith('.js') && !expected.has(path.relative(directory, file))) violations.push(`unexpected production output: ${path.relative(directory, file)}`);
		}
	}
	if (fs.existsSync(directory)) inspect(directory);
}
if (violations.length) { console.error(violations.join('\n')); process.exitCode = 1; }
else console.log(`OMP production boundary: ${sources.length} source files checked, including type dependencies${process.argv.includes('--built') ? ' and emitted output' : ''}; no legacy Pi SDK.`);
