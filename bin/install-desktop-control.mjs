import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const windows = process.platform === "win32";
if (!windows && process.platform !== "darwin") throw Error("Desktop control supports macOS and Windows.");
const directory = join(homedir(), ".pi-desktop-control");
const python = join(directory, windows ? "Scripts/python.exe" : "bin/python");
function run(command, args) {
	const result = spawnSync(command, args, {stdio: "inherit"});
	if (result.error || result.status !== 0) throw Error(result.error?.message ?? `${command} exited with ${result.status}`);
}
if (!existsSync(python)) run(windows ? "py" : "python3", [...(windows ? ["-3"] : []), "-m", "venv", directory]);
run(python, ["-I", "-m", "pip", "install", "--upgrade", "pip"]);
const requirements = fileURLToPath(new URL("../assets/desktop-control/requirements.txt", import.meta.url));
run(python, ["-I", "-m", "pip", "install", "--only-binary=:all:", "-r", requirements]);
console.log("Desktop helper ready. Enable Desktop control in Settings → Extensions for the current chat.");
