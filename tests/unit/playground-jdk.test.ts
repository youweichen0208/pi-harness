import { expect, it } from "vitest";
import { JdkProbe, probeJdk, resolveJdkCommands } from "../../server/playground-jdk.js";

/** Fake filesystem: only the listed paths exist. */
const files = (...paths: string[]) => {
	const set = new Set(paths);
	return (path: string) => set.has(path);
};

it("prefers JAVA_HOME over PATH", () => {
	const exists = files("/jdk/bin/javac", "/jdk/bin/java", "/usr/bin/javac", "/usr/bin/java");
	expect(resolveJdkCommands({ JAVA_HOME: "/jdk", PATH: "/usr/bin" }, exists, "linux"))
		.toEqual({ javac: "/jdk/bin/javac", java: "/jdk/bin/java" });
});

it("falls back to PATH when JAVA_HOME is unset, empty or useless", () => {
	const exists = files("/usr/bin/javac", "/usr/bin/java");
	expect(resolveJdkCommands({ PATH: "/usr/bin" }, exists, "linux")).toEqual({ javac: "/usr/bin/javac", java: "/usr/bin/java" });
	expect(resolveJdkCommands({ JAVA_HOME: "", PATH: "/usr/bin" }, exists, "linux")).toEqual({ javac: "/usr/bin/javac", java: "/usr/bin/java" });
	expect(resolveJdkCommands({ JAVA_HOME: "/empty", PATH: "/usr/bin" }, exists, "linux")).toEqual({ javac: "/usr/bin/javac", java: "/usr/bin/java" });
});

it("requires both javac and java, so a JRE-only directory is skipped", () => {
	const exists = files("/jre/bin/java", "/jdk/bin/javac", "/jdk/bin/java");
	expect(resolveJdkCommands({ PATH: "/jre/bin:/jdk/bin" }, exists, "linux"))
		.toEqual({ javac: "/jdk/bin/javac", java: "/jdk/bin/java" });
});

it("reports no JDK when nothing has both", () => {
	expect(resolveJdkCommands({ PATH: "/jre/bin" }, files("/jre/bin/java"), "linux")).toBeUndefined();
	expect(resolveJdkCommands({ PATH: "/jre/bin:/jdk/bin" }, files("/jre/bin/java", "/jdk/bin/java"), "linux")).toBeUndefined();
	expect(resolveJdkCommands({}, files(), "linux")).toBeUndefined();
});

it("ignores empty PATH entries instead of treating them as the working directory", () => {
	expect(resolveJdkCommands({ PATH: "::/jdk/bin:" }, files("/jdk/bin/javac", "/jdk/bin/java"), "linux"))
		.toEqual({ javac: "/jdk/bin/javac", java: "/jdk/bin/java" });
});

it("uses .exe and the Windows separator on win32", () => {
	const exists = files("C:\\jdk\\bin\\javac.exe", "C:\\jdk\\bin\\java.exe");
	expect(resolveJdkCommands({ PATH: "C:\\other;C:\\jdk\\bin" }, exists, "win32"))
		.toEqual({ javac: "C:\\jdk\\bin\\javac.exe", java: "C:\\jdk\\bin\\java.exe" });
	expect(resolveJdkCommands({ JAVA_HOME: "C:\\jdk", PATH: "C:\\other" }, exists, "win32"))
		.toEqual({ javac: "C:\\jdk\\bin\\javac.exe", java: "C:\\jdk\\bin\\java.exe" });
});

it("explains an unusable javac with javac's own message", async () => {
	// macOS ships /usr/bin/javac stubs that exist and are executable but refuse
	// to run; the stub's own text is what tells the user what to install.
	const status = await probeJdk({ PATH: "/stub" }, {
		resolve: () => ({ javac: "/stub/javac", java: "/stub/java" }),
		runVersion: async () => ({ error: "Unable to locate a Java Runtime." }),
	});
	expect(status.available).toBe(false);
	expect(status.path).toBe("/stub/javac");
	expect(status.reason).toContain("Unable to locate a Java Runtime.");
});

it("reports a missing JDK when nothing on the machine resolves", async () => {
	const status = await probeJdk({ PATH: "/nothing" }, { resolve: () => undefined });
	expect(status).toEqual({ available: false, reason: expect.stringMatching(/JDK/) });
});

it("caches the probe for its TTL and re-probes when asked", async () => {
	let calls = 0;
	let clock = 0;
	const probe = new JdkProbe(async () => { calls += 1; return { available: true, version: `v${calls}` }; }, 1000, () => clock);
	expect(await probe.get()).toMatchObject({ version: "v1" });
	expect(await probe.get()).toMatchObject({ version: "v1" });
	clock = 1500;
	expect(await probe.get()).toMatchObject({ version: "v2" });
	expect(await probe.get(true)).toMatchObject({ version: "v3" });
	expect(calls).toBe(3);
});
