import { SessionManager } from '@oh-my-pi/pi-coding-agent';
import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
const { dataDir, cwd: requestedCwd, messages, kind, title } = JSON.parse(await Bun.stdin.text());
const cwd = realpathSync(requestedCwd), directory = join(dataDir, 'omp/sessions', kind, createHash('sha256').update(cwd).digest('hex').slice(0, 24));
mkdirSync(directory, { recursive: true });
const manager = SessionManager.create(cwd, directory);
try {
	await manager.ensureOnDisk();
	for (const message of messages) manager.appendMessage(message);
	if (title) await manager.setSessionName(title, 'user');
	await manager.flush();
	process.stdout.write(JSON.stringify({ sessionFile: realpathSync(manager.getSessionFile()), sessionId: manager.getSessionId() }));
} finally { await manager.close(); }
