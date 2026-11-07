import { createServer } from "node:net";
import { expect, it } from "vitest";
import { databaseErrorMessage, databaseErrorMessages } from "../../server/database/errors.js";
import { executeQuery } from "../../server/database/query.js";

it("reports a premature SASL final as unsupported authentication using the real pg driver (#156)", async () => {
	const server = createServer(socket => {
		socket.once("data", () => {
			const data = Buffer.from("v=invalid\0"), packet = Buffer.alloc(9 + data.length);
			packet[0] = 82; packet.writeInt32BE(8 + data.length, 1); packet.writeInt32BE(12, 5); data.copy(packet, 9);
			socket.write(packet);
		});
		socket.on("error", () => {});
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address(); if (!address || typeof address === "string") throw Error("Missing test port");
		for (const password of ["correct-fixture", "wrong-fixture"]) {
			await expect(executeQuery({ driver: "postgres", name: "fixture", host: "127.0.0.1", port: address.port, user: "fixture", password, db_name: "fixture" }, { action: "run", id: "fixture", version: "1", operation: "query", sql: "SELECT 1" })).rejects.toThrow(/authentication.*not supported/i);
		}
	} finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
});

it("classifies safe connection errors without leaking driver text or confusing query failures with authentication", () => {
	for (const [code, expected] of [["28P01", "auth"], ["28000", "auth"], ["ER_ACCESS_DENIED_ERROR", "auth"], ["ECONNREFUSED", "network"], ["ENOTFOUND", "network"], ["CERT_HAS_EXPIRED", "tls"]] as const) {
		expect(databaseErrorMessage({ code, message: "secret-password SELECT private-data" }, "postgres", true)).toBe(databaseErrorMessages[expected]);
	}
	const sasl = new TypeError("Cannot read properties of undefined (reading 'message')");
	sasl.stack = "TypeError at Object.finalizeSession (C:\\app\\node_modules\\pg\\lib\\crypto\\sasl.js:130:15)";
	expect(databaseErrorMessage(sasl, "postgres", true)).toBe(databaseErrorMessages.authProtocol);
	for (const [driver, connecting] of [["postgres", false], ["mysql", true]] as const) expect(databaseErrorMessage(sasl, driver, connecting)).not.toBe(databaseErrorMessages.authProtocol);
	expect(databaseErrorMessage(new TypeError("secret-password"), "postgres", true)).not.toContain("secret-password");
	expect(databaseErrorMessage(new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a non-empty string"), "postgres", true)).toBe(databaseErrorMessages.auth);
	expect(databaseErrorMessage({ code: "42601", message: "SELECT private-data" }, "postgres", false)).toBe("Database error: 42601");
	expect(databaseErrorMessage(null, "postgres", true)).toBe("Database query failed; check connection settings and SQL");
});
