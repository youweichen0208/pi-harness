/** Xshell 7 credentials stay on the server and are read only for a requested connection. */
import { createHash, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { parseXshellIni, readBounded, resolveXshellNode } from "./node-sources.js";
import type { NodeProfile, NodeSource } from "./protocol.js";

export class NodeCredentialError extends Error {
	constructor(message: string, readonly reason: "missing" | "locked" | "unavailable" = "missing") { super(message); }
}

export interface WindowsIdentity { username: string; sid: string }

export async function currentWindowsIdentity(): Promise<WindowsIdentity> {
	if (process.platform !== "win32") throw new NodeCredentialError("自动读取 Xshell 7 密码需要在原 Windows 用户下运行；也可手动填写认证信息。", "unavailable");
	try {
		const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; @{ username = [Environment]::UserName; sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value } | ConvertTo-Json -Compress'], { windowsHide: true, timeout: 5000, maxBuffer: 16384 });
		const value = JSON.parse(stdout.replace(/^\uFEFF/, ""));
		if (typeof value.username !== "string" || !value.username || typeof value.sid !== "string" || !/^S-1-\d+(?:-\d+)+$/.test(value.sid)) throw new Error();
		return value;
	} catch { throw new NodeCredentialError("无法读取当前 Windows 用户身份，请以保存 Xshell 会话的用户运行，或手动填写认证信息。", "unavailable"); }
}

/** Standard RC4, limited to decoding the legacy Xshell file format (not new storage). */
function rc4(input: Buffer, key: Buffer): Buffer {
	const state = Uint8Array.from({ length: 256 }, (_, i) => i);
	let j = 0;
	for (let i = 0; i < 256; i++) {
		j = (j + state[i] + key[i % key.length]) & 255;
		[state[i], state[j]] = [state[j], state[i]];
	}
	const output = Buffer.alloc(input.length);
	let i = 0; j = 0;
	for (let n = 0; n < input.length; n++) {
		i = (i + 1) & 255; j = (j + state[i]) & 255;
		[state[i], state[j]] = [state[j], state[i]];
		output[n] = input[n] ^ state[(state[i] + state[j]) & 255];
	}
	state.fill(0);
	return output;
}

/** Returns nothing unless the decoded bytes pass the embedded SHA-256 checksum. */
export function decryptXshell7(encoded: string, identity: WindowsIdentity, masterPassword?: string): string | undefined {
	if (encoded.length > 20000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return undefined;
	const bytes = Buffer.from(encoded, "base64");
	if (bytes.length < 32) return undefined;
	const key = createHash("sha256").update(masterPassword ?? [...identity.sid].reverse().join("") + identity.username, "utf8").digest();
	const plain = rc4(bytes.subarray(0, -32), key);
	try {
		if (!timingSafeEqual(createHash("sha256").update(plain).digest(), bytes.subarray(-32))) return undefined;
		return new TextDecoder("utf-8", { fatal: true }).decode(plain);
	} catch { return undefined; }
	finally { key.fill(0); plain.fill(0); bytes.fill(0); }
}

export class XshellCredentials {
	private unlocked = new Map<string, string>();
	private generation = 0;
	private identity?: Promise<WindowsIdentity>;
	constructor(private readonly getIdentity: () => Promise<WindowsIdentity> = currentWindowsIdentity) {}
	private key(clientId: string, sourceId: string): string { return JSON.stringify([clientId, sourceId]); }
	clear(): void { this.generation++; this.unlocked.clear(); }

	async read(clientId: string, source: NodeSource, node: NodeProfile, masterPassword?: string): Promise<string | undefined> {
		const generation = this.generation;
		let text: string;
		let file: string;
		try {
			if (!node.sourceKey || isAbsolute(node.sourceKey)) throw new Error();
			const root = await realpath(source.path);
			file = await realpath(resolve(root, node.sourceKey));
			const within = relative(root, file);
			if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within) || !/\.xsh$/i.test(file)) throw new Error();
			text = await readBounded(file);
		} catch { throw new NodeCredentialError("无法读取 Xshell 会话文件，请同步来源或补填认证信息。", "unavailable"); }
		const fresh = resolveXshellNode(text, source.path, resolve(source.path, node.sourceKey!));
		if (["host", "port", "username", "auth", "keyPath", "unsupported"].some(key => JSON.stringify(fresh[key as keyof typeof fresh]) !== JSON.stringify(node[key as keyof NodeProfile]))) throw new Error("Xshell 来源配置已变化，请同步后重新连接。");
		const sections = parseXshellIni(text);
		const version = sections.SESSIONINFO?.VERSION;
		if (version && !/^7(?:\.|$)/.test(version)) throw new NodeCredentialError("此会话的凭据格式尚未适配；当前仅支持 Xshell 7，请补填认证信息。", "unavailable");
		const auth = sections["CONNECTION:AUTHENTICATION"] ?? {};
		const encoded = node.auth === "key" ? auth.PASSPHRASE : auth.PASSWORD;
		if (!encoded) return undefined;
		let masterEnabled: boolean | undefined;
		let ancestor = resolve(source.path);
		for (let depth = 0; depth < 4; depth++) {
			try {
				const settings = parseXshellIni(await readBounded(join(ancestor, "Common", "MasterPassword.mpw")));
				masterEnabled = Object.values(settings).some(section => section.ENBLMASTERPASSWD === "1");
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new NodeCredentialError("无法读取 Xshell 主密码设置，请检查来源目录或补填认证信息。", "unavailable");
			}
			const parent = dirname(ancestor); if (parent === ancestor) break; ancestor = parent;
		}
		const unlockKey = this.key(clientId, source.id);
		if (masterEnabled === false) this.unlocked.delete(unlockKey);
		const master = masterPassword ?? this.unlocked.get(unlockKey);
		if (masterEnabled && master === undefined) throw new NodeCredentialError("请输入 Xshell 主密码解锁此来源，或单独填写节点认证信息。", "locked");
		const identity = master !== undefined ? { username: "", sid: "" } : await (this.identity ??= this.getIdentity().catch(error => { this.identity = undefined; throw error; }));
		const secret = decryptXshell7(encoded, identity, master);
		if (secret === undefined) {
			this.unlocked.delete(unlockKey);
			throw new NodeCredentialError(master !== undefined ? "Xshell 主密码不正确或会话格式不兼容，请重试或补填认证信息。" : "无法验证 Xshell 保存的凭据；若启用了主密码，请解锁，否则请补填认证信息。", masterEnabled || master !== undefined ? "locked" : "unavailable");
		}
		if (generation !== this.generation) throw new Error("认证请求已取消。");
		if (masterPassword !== undefined) this.unlocked.set(unlockKey, masterPassword);
		return secret;
	}
}
