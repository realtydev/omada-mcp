import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { reloadCodex } from '../../src/runtime/clientRefresh.js';

// Optional installed-binary acceptance; regular tests exercise real WebSocket sockets without Codex.
// This owns an isolated process and profile, never the app-server serving Desktop chats.
it.skipIf(!process.env.OMADA_TEST_CODEX_BINARY || process.platform === 'win32')(
    'reloads the installed Codex app-server over its real control socket',
    async () => {
        const home = await mkdtemp(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'om-native-'));
        const socketPath = join(home, 'control.sock');
        const child = spawn(process.env.OMADA_TEST_CODEX_BINARY ?? 'codex', ['app-server', '--listen', `unix://${socketPath}`], {
            env: { ...process.env, CODEX_HOME: home },
            stdio: ['ignore', 'ignore', 'ignore'],
        });
        let startupError: Error | undefined;
        child.on('error', (error) => {
            startupError = error;
        });
        const closed = once(child, 'close').catch(() => undefined);
        try {
            let ready = false;
            for (let attempt = 0; attempt < 100; attempt++) {
                if (startupError) throw startupError;
                if (child.exitCode !== null) throw new Error('Isolated Codex app-server exited before listening.');
                if (
                    await stat(socketPath).then(
                        (entry) => entry.isSocket(),
                        () => false
                    )
                ) {
                    ready = true;
                    break;
                }
                await delay(50);
            }
            expect(ready).toBe(true);
            expect(await reloadCodex({ socketPath })).toEqual({ reloaded: true, socketPath });
        } finally {
            if (child.exitCode === null && child.signalCode === null) {
                child.kill('SIGTERM');
                const exited = await Promise.race([closed.then(() => true), delay(1_000).then(() => false)]);
                if (!exited) child.kill('SIGKILL');
            }
            await closed;
            await rm(home, { recursive: true, force: true });
        }
    },
    15_000
);
