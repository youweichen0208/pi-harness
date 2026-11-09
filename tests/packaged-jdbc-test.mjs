/** Real Java bridge in the built/packaged app. No database, network, credentials or model calls. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { testEnv } from "./lib/test-env.mjs";
const executable = process.argv[2] || process.execPath, app = resolve(process.argv[3] || ".");
const root = mkdtempSync(join(tmpdir(), "pi-packaged-jdbc-"));
try {
	const classes = join(root, "classes"), driver = join(root, "gauss driver.jar"); mkdirSync(classes);
	const tool = name => process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", name + (process.platform === "win32" ? ".exe" : "")) : name;
	for (const [name, args] of [["javac", ["--release", "8", "-encoding", "UTF-8", "-d", classes, "tests/fixtures/jdbc/GaussDriver.java"]], ["jar", ["cf", driver, "-C", classes, "."]]]) {
		const result = spawnSync(tool(name), args, { encoding: "utf8" }); assert.equal(result.status, 0, result.stderr);
	}
	const profile = { url: "jdbc:gaussdb://localhost/fixture", driverClass: "fixture.GaussDriver", configDir: root, properties: {}, jars: [{ path: driver, sha256: createHash("sha256").update(readFileSync(driver)).digest("hex") }] };
	const script = join(root, "verify.mjs");
	writeFileSync(script, `import assert from 'node:assert/strict';\nimport {executeJdbc} from ${JSON.stringify(pathToFileURL(join(app, "dist/server/database/jdbc-runtime.js")).href)};\nconst result=await executeJdbc(${JSON.stringify(profile)},'reader','fixture-only','SELECT 1','fixture',50,new AbortController().signal);\nassert.equal(result.rows[0][0],'9223372036854775807');\nconsole.log('PASS packaged JDBC bridge');\n`);
	const result = spawnSync(executable, [script], { encoding: "utf8", timeout: 30000, env: { ...testEnv(), ELECTRON_RUN_AS_NODE: "1", JAVA_HOME: process.env.JAVA_HOME, PI_WEB_JAVA: process.env.PI_WEB_JAVA } });
	assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /PASS packaged JDBC bridge/); console.log(result.stdout.trim());
} finally { rmSync(root, { recursive: true, force: true }); }
