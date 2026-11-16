/** Kill a pid and its whole process tree (cross-platform). */
export function killPidTree(pid: number): void {
	try {
		if (process.platform === "win32") {
			void Promise.all([import("node:child_process"), import("node:path")]).then(([{ spawn }, { win32 }]) => {
				const taskkill = win32.join(process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows", "System32", "taskkill.exe");
				spawn(taskkill, ["/F", "/T", "/PID", String(pid)], {
					stdio: "ignore",
					detached: true,
					windowsHide: true,
				}).on("error", () => {}).unref();
			}).catch(() => {});
		} else {
			process.kill(-pid, "SIGKILL");
		}
	} catch {
		// already dead
	}
}
