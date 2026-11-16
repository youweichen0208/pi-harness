/** OMP 18.20 protocol v2 framing. Kept Node-only: importing the SDK loads Bun natives. */
export const OMP_FRAME_BYTES = 1024 * 1024;
export const OMP_MESSAGE_BYTES = 64 * 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;

export function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export class OmpFrameDecoder {
	private pending?: { id: string; count: number; length: number; chunks: Buffer[]; bytes: number };

	clear(): void { this.pending = undefined; }

	push(value: unknown): Record<string, unknown> | undefined {
		if (!isRecord(value) || typeof value.type !== "string") throw Error("Invalid OMP frame");
		if (value.type !== "rpc_chunk") {
			if (this.pending) throw Error("Interrupted OMP chunk sequence");
			return value;
		}
		const { chunkId, index, count, byteLength, data } = value;
		if (typeof chunkId !== "string" || !chunkId.length || chunkId.length > 128 ||
			typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 ||
			typeof count !== "number" || !Number.isSafeInteger(count) || count < 2 || count > OMP_MESSAGE_BYTES / CHUNK_BYTES || index >= count ||
			typeof byteLength !== "number" || !Number.isSafeInteger(byteLength) || byteLength < OMP_FRAME_BYTES || byteLength > OMP_MESSAGE_BYTES ||
			typeof data !== "string" || data.length > Math.ceil(CHUNK_BYTES / 3) * 4) throw Error("Invalid OMP chunk metadata");
		const bytes = Buffer.from(data, "base64");
		if (!bytes.length || bytes.length > CHUNK_BYTES || bytes.toString("base64") !== data) throw Error("Invalid OMP chunk encoding");
		if (!this.pending) {
			if (index !== 0) throw Error("OMP chunk sequence must start at zero");
			this.pending = { id: chunkId, count, length: byteLength, chunks: [], bytes: 0 };
		}
		const p = this.pending;
		if (p.id !== chunkId || p.count !== count || p.length !== byteLength || p.chunks.length !== index) throw Error("OMP chunk sequence mismatch");
		p.bytes += bytes.length;
		if (p.bytes > p.length) throw Error("OMP chunk length exceeded");
		p.chunks.push(bytes);
		if (p.chunks.length < count) return undefined;
		if (p.bytes !== p.length) throw Error("OMP chunk length mismatch");
		this.pending = undefined;
		const decoded: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(p.chunks)));
		if (!isRecord(decoded) || typeof decoded.type !== "string" || decoded.type === "rpc_chunk") throw Error("Invalid reassembled OMP frame");
		return decoded;
	}
}
