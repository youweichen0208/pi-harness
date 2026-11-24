import { randomUUID } from "node:crypto";
import { chmod, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

export type SessionExportFormat = "html" | "jsonl";
export interface SessionExportDownload {
	token: string;
	clientId: string;
	conversationId: string;
	sessionId: string;
	path: string;
	name: string;
	format: SessionExportFormat;
}
interface ExportRecord extends SessionExportDownload {
	expiresAt: number;
	used: boolean;
	timer: NodeJS.Timeout;
}
export interface SessionExportLimits {
	sourceBytes: number;
	entries: number;
	outputBytes: number;
	ttlMs: number;
}
const DEFAULT_LIMITS: SessionExportLimits = {
	sourceBytes: 64 * 1024 * 1024,
	entries: 50_000,
	outputBytes: 200 * 1024 * 1024,
	ttlMs: 60_000,
};

export class SessionExportService {
	private readonly records = new Map<string, ExportRecord>();
	private readonly activeClients = new Set<string>();
	private disposed = false;

	constructor(
		private readonly dataDir: string,
		private readonly limits: SessionExportLimits = DEFAULT_LIMITS,
	) {}

	async create(
		clientId: string,
		conversationId: string,
		session: AgentSession,
		format: SessionExportFormat,
		owned: () => boolean,
	): Promise<SessionExportDownload> {
		if (this.disposed || !owned()) throw new Error("Export conversation unavailable");
		if (this.activeClients.has(clientId)) throw new Error("Another session export is already being prepared");
		this.activeClients.add(clientId);
		let outputPath: string | undefined;
		try {
			const entries = session.sessionManager.getEntries().length;
			if (entries > this.limits.entries) throw new Error(`Session has too many entries to export (${entries})`);
			const sessionFile = session.sessionFile;
			if (sessionFile) {
				try {
					const source = await stat(sessionFile);
					if (source.size > this.limits.sourceBytes) throw new Error("Session file is too large to export");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			}
			if (this.disposed || !owned()) throw new Error("Export conversation unavailable");
			const directory = join(this.dataDir, "exports");
			await mkdir(directory, { recursive: true, mode: 0o700 });
			await chmod(directory, 0o700);
			const sessionId = session.sessionId;
			outputPath = join(directory, `${randomUUID()}.${format}`);
			if (format === "html") await session.exportToHtml(outputPath);
			else session.exportToJsonl(outputPath);
			await chmod(outputPath, 0o600);
			const output = await stat(outputPath);
			if (!output.isFile() || output.size > this.limits.outputBytes) throw new Error("Exported file is too large to download");
			if (this.disposed || !owned()) throw new Error("Export conversation unavailable");
			const safeSession = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "session";
			const token = randomUUID();
			const record: ExportRecord = {
				token, clientId, conversationId, sessionId, path: outputPath,
				name: `pi-session-${safeSession}.${format}`, format,
				expiresAt: Date.now() + this.limits.ttlMs, used: false,
				timer: setTimeout(() => { void this.expire(token); }, this.limits.ttlMs),
			};
			record.timer.unref();
			this.records.set(token, record);
			const { token: downloadToken, clientId: owner, conversationId: conversation, sessionId: id, path, name, format: kind } = record;
			return { token: downloadToken, clientId: owner, conversationId: conversation, sessionId: id, path, name, format: kind };
		} catch (error) {
			if (outputPath) await rm(outputPath, { force: true }).catch(() => {});
			throw error;
		} finally {
			this.activeClients.delete(clientId);
		}
	}

	consume(clientId: string, conversationId: string, sessionId: string, token: string, owned: () => boolean): SessionExportDownload | undefined {
		const record = this.records.get(token);
		if (!record || record.used || record.clientId !== clientId || record.conversationId !== conversationId || record.sessionId !== sessionId || record.expiresAt <= Date.now() || !owned()) {
			if (record && (record.expiresAt <= Date.now() || !owned())) void this.expire(token);
			return undefined;
		}
		record.used = true;
		clearTimeout(record.timer);
		const { token: downloadToken, clientId: owner, conversationId: conversation, sessionId: id, path, name, format } = record;
		return { token: downloadToken, clientId: owner, conversationId: conversation, sessionId: id, path, name, format };
	}

	async finish(token: string): Promise<void> {
		const record = this.records.get(token);
		if (!record) return;
		this.records.delete(token);
		clearTimeout(record.timer);
		await rm(record.path, { force: true }).catch(() => {});
	}

	async invalidate(conversationId?: string): Promise<void> {
		await Promise.all([...this.records.values()]
			.filter(record => !conversationId || record.conversationId === conversationId)
			.map(record => this.expire(record.token)));
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		void this.invalidate();
	}

	private async expire(token: string): Promise<void> {
		await this.finish(token);
	}
}
