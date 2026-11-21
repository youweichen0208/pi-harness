// Chrome owns stdin/stdout. Relay individual RPCs from same-user Unix sockets.
import {createServer} from "node:net";
import {homedir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {ensurePrivateReaderDirectory} from "./page-reader-security.mjs";
const dir = join(homedir(), ".pi-harness-reader");
ensurePrivateReaderDirectory(dir);
process.umask(0o077);
const clients = new Map();
const server = createServer(socket => {
	const id = randomUUID();
	let request = "";
	socket.setTimeout(10000, () => socket.destroy());
	socket.setEncoding("utf8");
	socket.on("error", () => socket.destroy());
	socket.on("close", () => clients.delete(id));
	socket.on("data", chunk => {
		request += chunk;
		if (request.length > 8192 || clients.has(id)) return socket.destroy();
		if (!request.includes("\n")) return;
		try {
			const body = Buffer.from(JSON.stringify({...JSON.parse(request), id}));
			const header = Buffer.alloc(4);
			header.writeUInt32LE(body.length);
			clients.set(id, socket);
			process.stdout.write(Buffer.concat([header, body]));
		} catch { socket.destroy(); }
	});
});
server.listen(join(dir, process.pid + ".sock"));
let pending = Buffer.alloc(0);
process.stdin.on("data", chunk => {
	pending = Buffer.concat([pending, chunk]);
	while (pending.length >= 4) {
		const length = pending.readUInt32LE();
		if (length > 1024 * 1024) process.exit(1);
		if (pending.length < length + 4) break;
		const body = pending.subarray(4, length + 4);
		const reply = JSON.parse(body.toString());
		clients.get(reply.id)?.end(body);
		pending = pending.subarray(length + 4);
	}
});
process.stdin.on("end", () => {
	for (const client of clients.values()) client.destroy();
	server.close();
});
