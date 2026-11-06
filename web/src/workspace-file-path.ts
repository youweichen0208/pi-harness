/** Lexical UI preflight only. The server still validates real paths (including symlinks). */
export function workspaceFilePath(cwd: string, path: string) {
	const windows = /^[a-z]:[\\/]/i.test(cwd) || /^\\\\/.test(cwd) || /^\/\/[^/]/.test(cwd);
	const separators = (value: string) => windows ? value.replaceAll("\\", "/") : value;
	const splitRoot = (value: string): [string, string] => {
		const match = windows ? /^(?:[a-z]:\/|\/\/[^/]+\/[^/]+\/?)/i.exec(value) : /^\//.exec(value);
		return match ? [match[0].replace(/\/$/, ""), value.slice(match[0].length)] : ["", value];
	};
	const normalize = (value: string) => {
		const [root, rest] = splitRoot(value);
		const parts: string[] = [];
		for (const part of rest.split("/")) {
			if (!part || part === ".") continue;
			if (part === "..") parts.pop(); else parts.push(part);
		}
		return { root, parts, absolute: `${root}/${parts.join("/")}` };
	};
	const base = normalize(separators(cwd));
	const input = separators(path);
	const absolute = windows ? /^(?:[a-z]:\/|\/\/)/i.test(input) : input.startsWith("/");
	// Root-relative Windows paths use the current volume; drive-relative paths
	// depend on per-drive process state the browser cannot know, so don't guess.
	const ambiguousDrive = windows && /^[a-z]:(?!\/)/i.test(input);
	const target = normalize(absolute ? input : windows && input.startsWith("/") ? `${base.root}${input}` : `${base.absolute}/${input}`);
	const compare = (value: string) => windows ? value.toLowerCase() : value;
	const inside = !ambiguousDrive && compare(base.root) === compare(target.root) && base.parts.every((part, i) => compare(part) === compare(target.parts[i] ?? ""));
	return {
		outside: !inside,
		// Keep external absolute paths intact, including their native separators.
		fullPath: absolute || ambiguousDrive ? path : windows ? target.absolute.replaceAll("/", "\\") : target.absolute,
		relativePath: inside ? target.parts.slice(base.parts.length).join("/") : path,
	};
}
