import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { refreshClient, reloadCodex } from '../../src/runtime/clientRefresh.js';

let home: string;
let socketPath: string;
let server: Server | undefined;
let webSockets: WebSocketServer | undefined;
let methods: string[];

beforeEach(async () => {
    home = await mkdtemp(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'om-ws-'));
    socketPath = join(home, 'control.sock');
    methods = [];
});
afterEach(async () => {
    for (const socket of webSockets?.clients ?? []) socket.terminate();
    if (webSockets) await new Promise<void>((resolve) => webSockets?.close(() => resolve()));
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    webSockets = undefined;
    await rm(home, { recursive: true, force: true });
});

async function listen(handler: (socket: WebSocket, request: { id?: number; method: string }) => void) {
    server = createServer((_req, res) => res.writeHead(426).end());
    webSockets = new WebSocketServer({ server, perMessageDeflate: false });
    webSockets.on('connection', (socket, request) => {
        expect(request.headers.upgrade).toBe('websocket');
        socket.on('error', () => undefined);
        socket.on('message', (data, binary) => {
            expect(binary).toBe(false);
            const message = JSON.parse(data.toString());
            methods.push(message.method);
            handler(socket, message);
        });
    });
    await new Promise<void>((resolve, reject) => {
        server?.once('error', reject);
        server?.listen(socketPath, resolve);
    });
}
function acknowledge(socket: WebSocket, request: { id?: number }) {
    if (request.id !== undefined) socket.send(JSON.stringify({ id: request.id, result: {} }));
}

describe.skipIf(process.platform === 'win32')('Codex reload over a real Unix WebSocket', () => {
    it('upgrades HTTP, sends framed initialization and waits for the matching reload acknowledgment', async () => {
        await listen((socket, request) => {
            if (request.method === 'initialize') {
                // Notifications, premature acknowledgments and duplicate initialization replies cannot complete a reload.
                socket.send(JSON.stringify({ method: 'notice', params: {} }));
                socket.send(JSON.stringify({ id: 2, result: {} }));
                acknowledge(socket, request);
                acknowledge(socket, request);
            } else acknowledge(socket, request);
        });
        expect(await reloadCodex({ socketPath })).toEqual({ reloaded: true, socketPath });
        expect(methods).toEqual(['initialize', 'initialized', 'config/mcpServer/reload']);
    });

    it('uses the registered client profile for the default socket location', async () => {
        await mkdir(join(home, 'app-server-control'));
        socketPath = join(home, 'app-server-control', 'app-server-control.sock');
        await listen(acknowledge);
        const execute = vi.fn();
        const result = await refreshClient({ client: 'codex', configPath: join(home, 'config.toml'), restartOnUpdate: false }, execute);
        expect(result).toMatchObject({ client: 'codex', status: 'reload-queued', socketPath });
        expect(result.message).toContain('tool list and getServerInfo');
        expect(execute).not.toHaveBeenCalled();
    });

    it('honors an explicit literal socket path with spaces and colons', async () => {
        socketPath = join(home, 'control : space.sock');
        await listen(acknowledge);
        const result = await refreshClient({ client: 'codex', configPath: '/different/config.toml', restartOnUpdate: true }, vi.fn(), socketPath);
        expect(result).toMatchObject({ status: 'reload-queued', socketPath });
    });

    it.each(['initialize', 'config/mcpServer/reload'])('reports rejection at %s without claiming refresh', async (rejected) => {
        await listen((socket, request) => {
            if (request.method === rejected) socket.send(JSON.stringify({ id: request.id, error: { code: -32601, message: 'rejected' } }));
            else acknowledge(socket, request);
        });
        expect(await reloadCodex({ socketPath })).toMatchObject({ reloaded: false, reason: 'reload_rejected' });
        if (rejected === 'initialize') expect(methods).toEqual(['initialize']);
    });

    it.each(['not-json', 'null', '[]', '{"id":1}', '{"id":1,"result":null}'])('rejects malformed protocol data %s', async (message) => {
        await listen((socket) => socket.send(message));
        expect(await reloadCodex({ socketPath })).toMatchObject({ reloaded: false, reason: 'protocol_error' });
    });

    it('rejects binary JSON frames', async () => {
        await listen((socket) => socket.send(Buffer.from('{"id":1,"result":{}}')));
        expect(await reloadCodex({ socketPath })).toMatchObject({ reloaded: false, reason: 'protocol_error' });
    });

    it('bounds individual response frames', async () => {
        await listen((socket) => socket.send('x'.repeat(1_048_577)));
        expect(await reloadCodex({ socketPath })).toMatchObject({ reloaded: false, reason: 'response_limit' });
    });

    it('bounds aggregate traffic across otherwise valid notifications', async () => {
        await listen((socket) => {
            const notice = JSON.stringify({ method: 'notice', params: { text: 'x'.repeat(600_000) } });
            socket.send(notice);
            socket.send(notice);
        });
        expect(await reloadCodex({ socketPath })).toMatchObject({ reloaded: false, reason: 'response_limit' });
    });

    it('does not accept connection close as an acknowledgment', async () => {
        await listen((socket, request) => {
            if (request.method === 'config/mcpServer/reload') socket.close();
            else acknowledge(socket, request);
        });
        expect(await reloadCodex({ socketPath })).toMatchObject({ reloaded: false, reason: 'connection_closed' });
    });

    it('bounds an unresponsive connection and leaves the server usable', async () => {
        await listen((socket, request) => {
            if (methods.length > 1) acknowledge(socket, request);
        });
        expect(await reloadCodex({ socketPath, timeoutMs: 100 })).toMatchObject({ reloaded: false, reason: 'timeout' });
        expect(await reloadCodex({ socketPath })).toMatchObject({ reloaded: true });
    });

    it('reports a missing socket and rejects non-filesystem endpoints', async () => {
        expect(await reloadCodex({ socketPath })).toMatchObject({ reloaded: false, socketPath, reason: 'socket_missing' });
        for (const path of ['relative.sock', 'ws://localhost:1234', '/tmp/invalid\0.sock']) {
            expect(await reloadCodex({ socketPath: path })).toMatchObject({ reloaded: false, reason: 'invalid_socket_path' });
        }
    });
});
