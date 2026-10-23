import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/** Bounded Content-Length JSON-RPC transport over the owned Java process. */
export class JavaRpc {
	private child: ChildProcessWithoutNullStreams;
	private buffer = Buffer.alloc(0);
	private nextId = 0;
	private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
	private stopped = false;
	constructor(java: string, args: string[], cwd: string, private notify: (method: string, params: any) => void) {
		this.child = spawn(java, args, { cwd, stdio: "pipe", windowsHide: true });
		this.child.stderr.on("data", () => {});
		this.child.stdin.on("error", error => this.close(error));
		this.child.on("error", error => this.close(error));
		this.child.on("exit", () => this.close(new Error("Java language service stopped")));
		this.child.stdout.on("data", chunk => {
			try {
				this.buffer = Buffer.concat([this.buffer, chunk]);
				if (this.buffer.length > 8 * 1024 * 1024) throw new Error("Java language response too large");
				for (;;) {
					const end = this.buffer.indexOf("\r\n\r\n");
					if (end < 0) break;
					const length = Number(/Content-Length:\s*(\d+)/i.exec(this.buffer.subarray(0, end).toString())?.[1]);
					if (!Number.isSafeInteger(length) || length < 0 || length > 8 * 1024 * 1024) throw new Error("Invalid Java language response");
					if (this.buffer.length < end + 4 + length) break;
					const message = JSON.parse(this.buffer.subarray(end + 4, end + 4 + length).toString());
					this.buffer = this.buffer.subarray(end + 4 + length);
					if (message.method && message.id !== undefined) {
						const result = message.method === "workspace/configuration" ? (message.params?.items ?? []).map(() => ({})) : null;
						this.send({ jsonrpc: "2.0", id: message.id, result });
					} else if (message.method) this.notify(message.method, message.params);
					else {
						const item = this.pending.get(message.id);
						if (!item) continue;
						clearTimeout(item.timer); this.pending.delete(message.id);
						if (message.error) item.reject(new Error(message.error.message)); else item.resolve(message.result);
					}
				}
			} catch (error) { this.close(error instanceof Error ? error : new Error("Invalid Java response")); }
		});
	}
	private send(message: unknown): void {
		if (this.stopped) throw new Error("Java language service unavailable");
		const text = JSON.stringify(message);
		this.child.stdin.write(`Content-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
	}
	notification(method: string, params: unknown): void { this.send({ jsonrpc: "2.0", method, params }); }
	request(method: string, params: unknown, timeout = 20_000): Promise<any> {
		const id = ++this.nextId;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id); reject(new Error(`Java language request timed out: ${method}`));
				if (!this.stopped) this.notification("$/cancelRequest", { id });
			}, timeout);
			this.pending.set(id, { resolve, reject, timer });
			try { this.send({ jsonrpc: "2.0", id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
		});
	}
	close(error = new Error("Java language service closed")): void {
		if (this.stopped) return;
		this.stopped = true;
		for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
		this.pending.clear(); this.child.kill();
		const timer = setTimeout(() => { if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL"); }, 2000);
		timer.unref();
	}
}
