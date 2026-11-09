import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { PACKAGE_VERSION } from '../generated/buildInfo.js';
import type { ClientRegistration, ManagedClient } from './clients.js';
import { type Runner, run } from './core.js';

export interface RefreshResult {
    client: ManagedClient;
    status: 'reload-queued' | 'restart-requested' | 'not-running' | 'action-required';
    message: string;
}

// The proxy connects to an existing control socket. Never start a second app server:
// refreshing a new process would not refresh the user's already-open client.
export function reloadCodex(
    createProxy: () => ChildProcessWithoutNullStreams = () => spawn('codex', ['app-server', 'proxy'], { stdio: 'pipe', windowsHide: true }),
    timeoutMs = 5_000
): Promise<boolean> {
    return new Promise((resolve) => {
        let child: ChildProcessWithoutNullStreams;
        try {
            child = createProxy();
        } catch {
            resolve(false);
            return;
        }
        let settled = false;
        let bytes = 0;
        let reloadSent = false;
        const lines = createInterface({ input: child.stdout });
        const finish = (success: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            lines.close();
            child.stdin.end();
            child.kill('SIGTERM');
            resolve(success);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        child.stderr.resume();
        child.on('error', () => finish(false));
        child.on('close', () => finish(false));
        child.stdin.on('error', () => finish(false));
        child.stdout.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 1_048_576) finish(false);
        });
        const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
        lines.on('line', (line) => {
            try {
                const response = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
                if (response.id !== 1 && response.id !== 2) return;
                if (response.error !== undefined) {
                    finish(false);
                    return;
                }
                if (!Object.hasOwn(response, 'result')) return;
                if (response.id === 1 && !reloadSent) {
                    reloadSent = true;
                    send({ method: 'initialized' });
                    send({ id: 2, method: 'config/mcpServer/reload' });
                } else if (response.id === 2) finish(reloadSent);
            } catch {
                finish(false);
            }
        });
        send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'omada-runtime', version: PACKAGE_VERSION }, capabilities: null } });
    });
}

export async function refreshClient(
    registration: ClientRegistration,
    execute: Runner = run,
    reload?: () => Promise<boolean>
): Promise<RefreshResult> {
    const { client } = registration;
    if (client === 'codex') {
        const reloaded = await (reload
            ? reload()
            : reloadCodex(() =>
                  spawn('codex', ['app-server', 'proxy'], {
                      stdio: 'pipe',
                      windowsHide: true,
                      env: { ...process.env, CODEX_HOME: dirname(registration.configPath) },
                  })
              ));
        if (reloaded)
            return {
                client,
                status: 'reload-queued',
                message:
                    'The running Codex app server acknowledged the MCP reload. Refresh is queued for loaded chats; verify getServerInfo inside the client.',
            };
        return {
            client,
            status: 'action-required',
            message:
                'The existing Codex control socket is unavailable. Restart Omada from MCP settings in the app, or reconnect the running CLI session. No app or session was stopped.',
        };
    }
    const name = client === 'cursor' ? 'Cursor' : 'Claude Desktop';
    if (!registration.restartOnUpdate)
        return {
            client,
            status: 'action-required',
            message: `${name} must reload its MCP connection. Reconnect Omada in the client, or use --restart-clients to opt into a graceful app restart on macOS.`,
        };
    if (process.platform !== 'darwin')
        return {
            client,
            status: 'action-required',
            message: `Automatic application restart is currently supported on macOS. Restart ${name} to load the selected build.`,
        };
    const bundle = client === 'cursor' ? 'com.todesktop.230313mzl4w4u92' : 'com.anthropic.claudefordesktop';
    const script = `if application id "${bundle}" is not running then return "not-running"
with timeout of 10 seconds
    tell application id "${bundle}" to quit
end timeout
repeat 100 times
    if application id "${bundle}" is not running then return "quit"
    delay 0.1
end repeat
error "Application did not quit; restart cancelled"`;
    try {
        const result = await execute('osascript', ['-e', script]);
        if (result === 'not-running')
            return { client, status: 'not-running', message: `${name} is closed and will load the selected build when opened.` };
        if (result !== 'quit') throw new Error('Quit was not confirmed.');
        await execute('open', ['-b', bundle]);
        return {
            client,
            status: 'restart-requested',
            message: `${name} quit gracefully and relaunch was requested. Verify getServerInfo in the reopened client; startup is not yet confirmed.`,
        };
    } catch {
        return {
            client,
            status: 'action-required',
            message: `A graceful ${name} restart could not be confirmed. No process was force-killed. Reopen or reconnect the client manually.`,
        };
    }
}
