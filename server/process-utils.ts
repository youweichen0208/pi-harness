/** Kill a pid and its whole process tree (cross-platform). */
export function killPidTree(pid: number): void {
	try {
		if (process.platform === "win32") {
			void import("node:child_process").then(({ spawn }) => {
				spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
					stdio: "ignore",
					detached: true,
					windowsHide: true,
				}).unref();
			});
		} else {
			process.kill(-pid, "SIGKILL");
		}
	} catch {
		// already dead
	}
}
