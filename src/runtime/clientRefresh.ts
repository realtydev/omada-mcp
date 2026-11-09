import { connect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import WebSocket from 'ws';
import { PACKAGE_VERSION } from '../generated/buildInfo.js';
import type { ClientRegistration, ManagedClient } from './clients.js';
import { type Runner, run } from './core.js';

export type ReloadFailure =
    | 'invalid_socket_path'
    | 'socket_missing'
    | 'socket_unavailable'
    | 'socket_forbidden'
    | 'connection_failed'
    | 'protocol_error'
    | 'response_limit'
    | 'reload_rejected'
    | 'connection_closed'
    | 'timeout';
export interface CodexReloadResult {
    reloaded: boolean;
    socketPath: string;
    reason?: ReloadFailure;
}
export interface RefreshResult {
    client: ManagedClient;
    status: 'reload-queued' | 'restart-requested' | 'not-running' | 'action-required';
    message: string;
    socketPath?: string;
    reason?: ReloadFailure;
}
export interface ClientRefreshOptions {
    restart?: boolean;
    codexSocketPath?: string;
}

export function isCodexSocketPath(path: string): boolean {
    return isAbsolute(path) && !Array.from(path).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}

// Connect only to an existing app-server. A new process cannot refresh Desktop's loaded chats.
export function reloadCodex(options: { socketPath?: string; codexHome?: string; timeoutMs?: number } = {}): Promise<CodexReloadResult> {
    const socketPath =
        options.socketPath ??
        join(options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'app-server-control', 'app-server-control.sock');
    if (!isCodexSocketPath(socketPath)) return Promise.resolve({ reloaded: false, socketPath, reason: 'invalid_socket_path' });
    const timeoutMs = options.timeoutMs ?? 5_000;
    return new Promise((resolve) => {
        let socket: WebSocket | undefined;
        let settled = false;
        let bytes = 0;
        let expectedId = 1;
        const finish = (reason?: ReloadFailure) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket?.terminate();
            resolve({ reloaded: reason === undefined, socketPath, ...(reason ? { reason } : {}) });
        };
        const timer = setTimeout(() => finish('timeout'), timeoutMs);
        try {
            // The custom connection prevents DNS/TCP fallback and preserves literal socket paths.
            socket = new WebSocket('ws://localhost/', {
                createConnection: () => connect({ path: socketPath }),
                handshakeTimeout: timeoutMs,
                maxPayload: 1_048_576,
                perMessageDeflate: false,
                followRedirects: false,
            });
        } catch {
            finish('connection_failed');
            return;
        }
        const send = (message: unknown) =>
            socket?.send(JSON.stringify(message), (error) => {
                if (error) finish('connection_failed');
            });
        socket.on('error', (error: NodeJS.ErrnoException) => {
            const reason =
                error.code === 'ENOENT'
                    ? 'socket_missing'
                    : error.code === 'ECONNREFUSED'
                      ? 'socket_unavailable'
                      : error.code === 'EACCES' || error.code === 'EPERM'
                        ? 'socket_forbidden'
                        : error.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'
                          ? 'response_limit'
                          : 'connection_failed';
            finish(reason);
        });
        socket.on('close', () => finish('connection_closed'));
        socket.on('open', () =>
            send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'omada-runtime', version: PACKAGE_VERSION }, capabilities: null } })
        );
        socket.on('message', (data, isBinary) => {
            if (settled) return;
            const frame = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
            bytes += frame.length;
            if (bytes > 1_048_576) {
                finish('response_limit');
                return;
            }
            if (isBinary) {
                finish('protocol_error');
                return;
            }
            try {
                const response: unknown = JSON.parse(frame.toString());
                if (response === null || typeof response !== 'object' || Array.isArray(response)) {
                    finish('protocol_error');
                    return;
                }
                if (!('id' in response) || response.id !== expectedId) return;
                if ('error' in response) {
                    finish('reload_rejected');
                    return;
                }
                if (!('result' in response) || response.result === null || typeof response.result !== 'object' || Array.isArray(response.result)) {
                    finish('protocol_error');
                    return;
                }
                if (expectedId === 1) {
                    expectedId = 2;
                    send({ method: 'initialized', params: {} });
                    send({ id: 2, method: 'config/mcpServer/reload' });
                } else finish();
            } catch {
                finish('protocol_error');
            }
        });
    });
}

export async function refreshClient(registration: ClientRegistration, execute: Runner = run, codexSocketPath?: string): Promise<RefreshResult> {
    const { client } = registration;
    if (client === 'codex') {
        const { reloaded, ...detail } = await reloadCodex({ socketPath: codexSocketPath, codexHome: dirname(registration.configPath) });
        if (reloaded)
            return {
                client,
                status: 'reload-queued',
                ...detail,
                message:
                    'The existing Codex app server acknowledged the MCP reload. Refresh is queued for its loaded chats; verify the tool list and getServerInfo inside each client.',
            };
        return {
            client,
            status: 'action-required',
            ...detail,
            message:
                'Could not reload the existing Codex app server. Check the socketPath and reason; use --codex-socket for a known existing control socket. Desktop may expose no public control socket. No app or session was stopped.',
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
