/** Isolated real PostgreSQL TLS fixture. Requires Docker and openssl. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeQuery } from "../dist/server/database/query.js";
import { portUp } from "./lib/port-utils.mjs";
const folder = mkdtempSync(join(tmpdir(), "pi-db-tls-")), name = `pi-db-tls-${process.pid}`, port = 9280;
assert.equal(await portUp(port), false);
const docker = args => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
try {
	execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(folder, "server.key"), "-out", join(folder, "server.crt"), "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
	docker(["run", "--rm", "-d", "--name", name, "-e", "POSTGRES_PASSWORD=pi_test_only", "-p", `127.0.0.1:${port}:5432`, "postgres:17-alpine"]);
	for (let i=0;i<100;i++){ try { docker(["exec",name,"pg_isready","-U","postgres"]); break; } catch { await new Promise(r=>setTimeout(r,200)); } }
	docker(["cp", join(folder,"server.crt"), `${name}:/var/lib/postgresql/data/server.crt`]);
	docker(["cp", join(folder,"server.key"), `${name}:/var/lib/postgresql/data/server.key`]);
	docker(["exec", name, "chown", "postgres:postgres", "/var/lib/postgresql/data/server.key", "/var/lib/postgresql/data/server.crt"]);
	docker(["exec", name, "chmod", "600", "/var/lib/postgresql/data/server.key"]);
	docker(["exec", name, "psql", "-U", "postgres", "-c", "ALTER SYSTEM SET ssl = on"]);
	docker(["exec", name, "psql", "-U", "postgres", "-c", "SELECT pg_reload_conf()"]);
	const config = { name: "TLS fixture", driver: "postgres", host: "127.0.0.1", port, user: "postgres", password: "pi_test_only", db_name: "postgres", tls: { enabled: true, ca: readFileSync(join(folder,"server.crt"),"utf8") } };
	const op = { action: "run", id: "tls", version: "", operation: "query", sql: "select 1 as n" };
	assert.equal((await executeQuery(config,op)).rows[0][0],1);
	await assert.rejects(executeQuery({...config,tls:{enabled:true}},op));
	console.log("PASS database TLS: valid CA accepted, untrusted certificate rejected");
} finally { try { docker(["rm","-f",name]); } catch {} rmSync(folder,{recursive:true,force:true}); }
