import { expect, it } from "vitest";
import { publicAddress, previewMetadata } from "../../server/link-preview.js";
import { imageBytes } from "../../server/note-assets.js";
it("only permits public unicast destinations, including mapped and transition IPv6", () => {
	for (const ip of ["127.0.0.1", "0.0.0.0", "10.1.2.3", "172.16.1.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "198.18.0.1", "224.0.0.1", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2001:db8::1", "2001::1", "2001:0000::1", "3fff::1", "2002:7f00:1::"]) expect(publicAddress(ip), ip).toBe(false);
	for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) expect(publicAddress(ip), ip).toBe(true);
});
it("extracts bounded card metadata independent of attribute order and escapes", () => {
	const preview = previewMetadata(`<title>Fallback</title><meta content='Title &amp; 中文' property='og:title'><meta name="description" content="&#x4e2d; &#25991;"><meta property="og:image" content="/cover.png">`, "https://example.com/a");
	expect(preview).toEqual({ url: "https://example.com/a", title: "Title & 中文", description: "中 文", imageUrl: "/cover.png" });
	expect(previewMetadata(`<meta property="og:title" content="${'a'.repeat(600)}">`,"https://example.com").title).toHaveLength(500);
});
it("validates image content rather than the claimed file extension", () => {
	expect(() => imageBytes(Buffer.from('<svg onload="alert(1)"></svg>').toString('base64'))).toThrow();
	expect(() => imageBytes('a'.repeat(6990510))).toThrow();
	expect(imageBytes('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZioAAAAASUVORK5CYII=').mime).toBe('image/png');
});
