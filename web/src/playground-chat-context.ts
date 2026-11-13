/** UTF-8 bounded output, preserving complete Unicode code points. */
export function boundedPlaygroundOutput(text: string, limit = 65536): { text: string; truncated: boolean } {
	const bytes = new TextEncoder().encode(text);
	if (bytes.length <= limit) return { text, truncated: false };
	let end = limit;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return { text: new TextDecoder().decode(bytes.subarray(0, end)), truncated: true };
}
