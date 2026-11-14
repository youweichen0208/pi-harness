import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
const windows = process.platform === "win32";
const home = process.env.JAVA_HOME;
const tool = name => home ? join(home, "bin", name + (windows ? ".exe" : "")) : name;
const temp = mkdtempSync(join(tmpdir(), "pi-jdbc-build-"));
try {
	mkdirSync("dist/server/database/jdbc", { recursive: true });
	// Java 8 is the supported runtime baseline; silence only obsolete option warnings.
	for (const [name, args] of [
		["javac", ["--release", "8", "-Xlint:-options", "-encoding", "UTF-8", "-d", temp, "server/database/jdbc/PiJdbc.java"]],
		["jar", ["cfe", resolve("dist/server/database/jdbc/pi-jdbc.jar"), "PiJdbc", "-C", temp, "."]],
	]) {
		const result = spawnSync(tool(name), args, { stdio: "inherit", windowsHide: true });
		if (result.error || result.status !== 0) throw Error("JDBC bridge build requires JDK 17+; configure JAVA_HOME.");
	}
} finally { rmSync(temp, { recursive: true, force: true }); }
