export type DatabaseTable = { schema: string; name: string; kind: string };
export function quoteDatabaseName(name: string, mysql: boolean) {
	const quote = mysql ? "`" : '"';
	return quote + name.split(quote).join(quote + quote) + quote;
}
/** Completions are a snapshot of the selected database, never a model/network request. */
export function databaseCompletions(tables: DatabaseTable[], mysql: boolean) {
	const q = (name: string) => quoteDatabaseName(name, mysql);
	return [
		...[...new Set(tables.map(table => table.schema))].map(schema => ({ label: schema, type: "namespace", apply: `${q(schema)}.` })),
		...tables.map(table => ({ label: `${table.schema}.${table.name}`, displayLabel: `${table.schema}.${table.name}`, type: "class", apply: `${q(table.schema)}.${q(table.name)}` })),
	];
}

/** Find the identifier under the cursor, excluding SQL strings and comments. */
export function databaseCompletionRange(text: string): { from: number; prefix: string } | undefined {
	let from = 0, quote = "", comment = "", dollar = "", depth = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text[i], next = text[i + 1];
		if (comment === "line") { if (c === "\n") comment = ""; from = i + 1; continue; }
		if (comment === "block") {
			if (c === "/" && next === "*") { depth++; i++; }
			else if (c === "*" && next === "/") { if (--depth === 0) comment = ""; i++; }
			from = i + 1; continue;
		}
		if (dollar) { if (text.startsWith(dollar, i)) { i += dollar.length - 1; dollar = ""; } from = i + 1; continue; }
		if (quote) {
			if (c === quote) { if (next === quote) i++; else quote = ""; }
			else if (c === "\\" && quote === "'") i++;
			continue;
		}
		if (c === "-" && next === "-") { comment = "line"; i++; continue; }
		if (c === "/" && next === "*") { comment = "block"; depth = 1; i++; continue; }
		const tag = c === "$" && /^(\$[a-zA-Z_][\w]*\$|\$\$)/.exec(text.slice(i));
		if (tag) { dollar = tag[0]; i += dollar.length - 1; continue; }
		if (c === "'" || c === '"' || c === "`") { quote = c; if (from > i) from = i; continue; }
		if (!/[\p{L}\p{N}_$.]/u.test(c)) from = i + 1;
	}
	if (comment || dollar || quote === "'") return undefined;
	return { from, prefix: text.slice(from).replace(/["`]/g, "") };
}
