import {chmodSync, lstatSync, mkdirSync} from "node:fs";

export function ensurePrivateReaderDirectory(path) {
	mkdirSync(path, {recursive: true, mode: 0o700});
	const stat = lstatSync(path);
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error("Page Reader socket directory must be a real directory, not a symbolic link.");
	chmodSync(path, 0o700);
}
