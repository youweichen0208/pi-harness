import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export function dbeaverDataRoots(home: string): string[] {
	return [...new Set([
		join(home, "Library/DBeaverData"), join(home, ".local/share/DBeaverData"),
		...(process.env.XDG_DATA_HOME && isAbsolute(process.env.XDG_DATA_HOME) ? [join(process.env.XDG_DATA_HOME, "DBeaverData")] : []),
		...(process.env.APPDATA ? [join(process.env.APPDATA, "DBeaverData")] : []),
		...(process.env.DBEAVER_DATA && isAbsolute(process.env.DBEAVER_DATA) ? [process.env.DBEAVER_DATA] : []),
	])];
}

/** DBeaver's UTF-8 .workspaces backup stores one absolute workspace path per line. */
export function registeredDbeaverSources(dataRoots: string[]): string[] {
	const workspaces = new Set<string>();
	const add = (value: string) => {
		if (workspaces.size < 32 && value.length <= 4096 && !/[\0\r\n]/.test(value) && isAbsolute(value)) workspaces.add(resolve(value));
	};
	if (process.env.DBEAVER_WORKSPACE) add(process.env.DBEAVER_WORKSPACE);
	for (const root of dataRoots) {
		add(join(root, "workspace6"));
		try {
			const file = join(root, ".workspaces"), stat = lstatSync(file);
			if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
			for (const path of readFileSync(file, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) add(path);
		} catch { /* Missing or unreadable history must not hide other data directories. */ }
	}
	const sources = new Set<string>(); let projects = 0;
	function inspect(project: string) {
		try {
			const directory = join(project, ".dbeaver"), file = join(directory, "data-sources.json");
			if (lstatSync(directory).isDirectory() && lstatSync(file).isFile()) sources.add(file);
		} catch { /* Not every project contains database connections. */ }
	}
	for (const workspace of workspaces) {
		if (projects >= 2500 || sources.size >= 100) break;
		try {
			if (!lstatSync(workspace).isDirectory()) continue;
			inspect(workspace);
			for (const entry of readdirSync(workspace, { withFileTypes: true })) {
				if (++projects > 2500 || sources.size >= 100) break;
				if (entry.isDirectory() && !entry.name.startsWith(".")) inspect(join(workspace, entry.name));
			}
		} catch { /* Stale workspaces are common; do not traverse arbitrary parents. */ }
	}
	return [...sources];
}
