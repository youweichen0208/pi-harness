/** Test-only host I/O fault; never changes the SDK or production storage adapter. */
import fs from "node:fs";
import { resolve } from "node:path";
import { mock } from "bun:test";

const marker = process.env.FIXTURE_HISTORY_IO_FAULT;
if (!marker) throw Error("History I/O fixture requires an explicit marker path");
const original = {
	openSync: fs.openSync, closeSync: fs.closeSync, writeSync: fs.writeSync,
	readFileSync: fs.readFileSync, readFile: fs.promises.readFile, writeFileSync: fs.writeFileSync,
};
const descriptors = new Map();
const normalized = path => {
	if (typeof path !== "string") return undefined;
	const value = resolve(path);
	return process.platform === "win32" ? value.toLowerCase() : value;
};
function check(path, operation) {
	if (!path) return;
	let target;
	try { target = JSON.parse(original.readFileSync(marker, "utf8")).file; }
	catch (error) { if (error.code === "ENOENT") return; throw error; }
	if (normalized(target) !== normalized(path)) return;
	let observed;
	try { observed = JSON.parse(original.readFileSync(marker + ".observed", "utf8")); }
	catch (error) { if (error.code !== "ENOENT") throw error; }
	// The first failure must be a real native writer call, not a passive read.
	if (operation === "read" && !observed?.writeObserved) return;
	original.writeFileSync(marker + ".observed", JSON.stringify({ code: "EIO", operation, file: target, writeObserved: operation === "write" || observed?.writeObserved === true }));
	throw Object.assign(Error("Synthetic history storage I/O failure"), { code: "EIO" });
}
fs.openSync = function (path, ...args) {
	const fd = original.openSync.call(this, path, ...args);
	descriptors.set(fd, path); return fd;
};
fs.closeSync = function (fd) { descriptors.delete(fd); return original.closeSync.call(this, fd); };
fs.writeSync = function (fd, ...args) { check(descriptors.get(fd), "write"); return original.writeSync.call(this, fd, ...args); };
fs.readFileSync = function (path, ...args) { check(typeof path === "number" ? descriptors.get(path) : path, "read"); return original.readFileSync.call(this, path, ...args); };
fs.promises.readFile = async function (path, ...args) { check(path, "read"); return original.readFile.call(this, path, ...args); };
const nativeFile = Bun.file;
Bun.file = function (path, ...args) { check(path, "read"); return nativeFile.call(this, path, ...args); };
// Bun's syncBuiltinESMExports does not update namespace imports. Use its public
// test module seam so the real SDK's named fs imports see the injected syscall.
mock.module("node:fs", () => ({ ...fs, default: fs }));
mock.module("node:fs/promises", () => ({ ...fs.promises, default: fs.promises }));
