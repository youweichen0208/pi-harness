import { describe, expect, it } from "vitest";
import { OmpFrameDecoder, OMP_MESSAGE_BYTES } from "../../server/omp/framing.js";

function chunks() {
	const bytes = Buffer.from(JSON.stringify({ type: "response", id: "large", success: true, content: "汉字🙂".repeat(150000) }));
	const count = Math.ceil(bytes.length / 262144);
	return Array.from({ length: count }, (_, index) => ({ type: "rpc_chunk", chunkId: "chunk", index, count, byteLength: bytes.length, data: bytes.subarray(index * 262144, (index + 1) * 262144).toString("base64") }));
}
describe("OMP v2 framing", () => {
	it("reassembles UTF-8 split within characters without dropping history", () => {
		const decoder = new OmpFrameDecoder(), parts = chunks();
		for (const part of parts.slice(0, -1)) expect(decoder.push(part)).toBeUndefined();
		expect(decoder.push(parts.at(-1))).toMatchObject({ type: "response", content: "汉字🙂".repeat(150000) });
	});
	it("rejects interleaved, duplicate and incomplete sequences", () => {
		const parts = chunks();
		for (const other of [parts[0], { type: "agent_end" }, { ...parts[1], chunkId: "different" }]) {
			const decoder = new OmpFrameDecoder(); decoder.push(parts[0]);
			expect(() => decoder.push(other)).toThrow();
		}
		expect(() => new OmpFrameDecoder().push(parts[1])).toThrow();
	});
	it("bounds declared lengths and validates base64", () => {
		const first = chunks()[0];
		for (const bad of [{ byteLength: OMP_MESSAGE_BYTES + 1 }, { count: 1000000 }, { data: "%%%" }, { index: -1 }]) {
			expect(() => new OmpFrameDecoder().push({ ...first, ...bad })).toThrow();
		}
	});
});
