/** Fixed public messages only: raw driver errors may contain passwords, SQL or paths. */
export const databaseErrorMessages = {
	authProtocol: "Database authentication protocol is not supported by the PostgreSQL driver; GaussDB/openGauss authentication compatibility is not guaranteed. Use a vendor-supported client.",
	auth: "Database authentication failed; check credentials and server access rules",
	network: "Database connection failed; check the host, port and network",
	tls: "Database TLS verification failed; check the certificate and TLS settings",
} as const;

export function databaseErrorMessage(error: unknown, driver: string, connecting: boolean): string {
	const e = error as { code?: unknown; message?: unknown; stack?: unknown } | null;
	const code = typeof e?.code === "string" ? e.code : "";
	const message = typeof e?.message === "string" ? e.message : "";
	const stack = typeof e?.stack === "string" ? e.stack : "";
	if ((connecting && driver === "postgres" && /^SASL: SCRAM-SERVER-(?:FIRST|FINAL)-MESSAGE: (?:client password|server returned error|server signature does not match)/.test(message)) || code === "28P01" || code === "28000" || code === "ER_ACCESS_DENIED_ERROR") return databaseErrorMessages.auth;
	if (["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH"].includes(code)) return databaseErrorMessages.network;
	if (["CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID"].includes(code)) return databaseErrorMessages.tls;
	if (connecting && driver === "postgres" && (
		/^(SASL: (?:Only mechanism|Last message was not)|Unknown authenticationOk message type|Unknown authentication message)/.test(message)
		|| (error instanceof TypeError && /[/\\]pg[/\\]lib[/\\]crypto[/\\]sasl\.js:\d+/.test(stack))
	)) return databaseErrorMessages.authProtocol;
	return /^[A-Z0-9_]{2,60}$/.test(code) ? `Database error: ${code}` : "Database query failed; check connection settings and SQL";
}
