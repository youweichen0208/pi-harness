import { join } from "node:path";

/** The server and its built-in workers use the current Electron executable. */
export function agentRuntimeEnvironment(_pkgRoot, _dataDir, executable = process.execPath) {
	return { ...process.env, ELECTRON_RUN_AS_NODE: "1", PI_WEB_NODE_RUNTIME: executable };
}

export function desktopPythonEnvironment(resources, override = process.env.PI_WEB_PYTHON) {
	return { PI_WEB_PYTHON: override?.trim() || join(resources, "python", process.platform === "win32" ? "python.exe" : "bin/python3") };
}
