const { execFileSync } = require("node:child_process");
const { mkdtempSync, readdirSync, renameSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { Arch } = require("builder-util");

module.exports = function bundlePython(resources, platform, arch) {
	if (platform !== process.platform || Arch[arch] !== process.arch) {
		throw new Error("Build the desktop Python runtime on the target OS and architecture");
	}
	const version = "3.12.13";
	const stage = mkdtempSync(join(resources, ".python-build-"));
	try {
		execFileSync("uv", ["python", "install", version, "--install-dir", stage, "--no-bin", "--no-registry"], { stdio: "inherit" });
		const prefix = readdirSync(stage, { withFileTypes: true }).find(entry => entry.isDirectory() && entry.name.startsWith(`cpython-${version}-`));
		if (!prefix) throw new Error("Managed Python distribution missing from staging directory");
		const root = join(stage, prefix.name);
		const python = join(root, platform === "win32" ? "python.exe" : "bin/python3");
		execFileSync("uv", ["pip", "install", "--python", python, "--break-system-packages", "--only-binary", ":all:", "--link-mode", "copy", "-r", join(__dirname, "notebook-requirements.txt")], { stdio: "inherit" });
		renameSync(root, join(resources, "python"));
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
};
