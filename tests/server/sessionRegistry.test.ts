import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionRegistry } from '../../src/server/sessionRegistry.js';

function state() {
    return {
        transport: {
            close: vi.fn().mockResolvedValue(undefined),
            send: vi.fn().mockResolvedValue(undefined),
            onclose: vi.fn(),
            onmessage: vi.fn(),
        },
        server: { close: vi.fn().mockResolvedValue(undefined) },
    };
}

describe('bounded HTTP sessions', () => {
    const registries: Array<SessionRegistry<ReturnType<typeof state>>> = [];
    const registry = (max = 1, idle = 1000) => {
        const sessions = new SessionRegistry<ReturnType<typeof state>>(max, idle);
        registries.push(sessions);
        return sessions;
    };
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(async () => {
        await Promise.all(registries.splice(0).map((sessions) => sessions.close()));
        vi.useRealTimers();
    });

    it('reserves capacity before asynchronous connections finish and releases failed admissions', () => {
        const sessions = registry();
        const release = sessions.reserve();
        expect(release).toBeTypeOf('function');
        expect(sessions.reserve()).toBeUndefined();
        release?.();
        release?.();
        expect(sessions.reserve()).toBeTypeOf('function');
    });

    it('expires idle sessions and releases both transport and server, preserving protocol onclose', async () => {
        const sessions = registry();
        const session = state();
        const protocolOnClose = session.transport.onclose;
        sessions.add('s1', session);
        await vi.advanceTimersByTimeAsync(1000);
        expect(sessions.get('s1')).toBeUndefined();
        expect(session.server.close).toHaveBeenCalledTimes(1);
        expect(session.transport.close).toHaveBeenCalledTimes(1);
        session.transport.onclose();
        expect(protocolOnClose).toHaveBeenCalledTimes(1);
        expect(sessions.reserve()).toBeTypeOf('function');
    });

    it('refreshes idle time on real requests but does not make persistent streams immortal', async () => {
        const sessions = registry();
        const session = state();
        sessions.add('s1', session);
        await vi.advanceTimersByTimeAsync(800);
        expect(sessions.get('s1')).toBe(session);
        await vi.advanceTimersByTimeAsync(800);
        expect(session.server.close).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(400);
        expect(session.server.close).toHaveBeenCalledTimes(1);
    });

    it('does not expire an active HTTP handler, and starts a fresh idle window when it ends', async () => {
        const sessions = registry();
        const session = state();
        sessions.add('s1', session);
        let finish: (() => void) | undefined;
        const pending = sessions.handle(
            's1',
            () =>
                new Promise<void>((resolve) => {
                    finish = resolve;
                })
        );
        await vi.advanceTimersByTimeAsync(3000);
        expect(session.server.close).not.toHaveBeenCalled();
        finish?.();
        await pending;
        await vi.advanceTimersByTimeAsync(1000);
        expect(session.server.close).toHaveBeenCalledTimes(1);
    });

    it('keeps SSE tools alive after POST acknowledgement until the matching JSON-RPC response', async () => {
        const sessions = registry();
        const session = state();
        sessions.add('s1', session);
        session.transport.onmessage({ jsonrpc: '2.0', method: 'tools/call', id: 1 } as JSONRPCMessage);
        await vi.advanceTimersByTimeAsync(3000);
        expect(session.server.close).not.toHaveBeenCalled();
        await session.transport.send({ jsonrpc: '2.0', id: 1, result: {} });
        await vi.advanceTimersByTimeAsync(1000);
        expect(session.server.close).toHaveBeenCalledTimes(1);
    });

    it('expires a cancelled tool request when the SDK suppresses its response', async () => {
        const sessions = registry();
        const session = state();
        sessions.add('s1', session);
        session.transport.onmessage({ jsonrpc: '2.0', method: 'tools/call', id: 'cancel-me' } as JSONRPCMessage);
        await vi.advanceTimersByTimeAsync(2000);
        expect(session.server.close).not.toHaveBeenCalled();
        session.transport.onmessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'cancel-me' } } as JSONRPCMessage);
        await vi.advanceTimersByTimeAsync(1000);
        expect(session.server.close).toHaveBeenCalledTimes(1);
    });

    it('keeps an active HTTP handler protected even after its JSON-RPC request is cancelled', async () => {
        const sessions = registry();
        const session = state();
        sessions.add('s1', session);
        let finish: (() => void) | undefined;
        const pending = sessions.handle(
            's1',
            () =>
                new Promise<void>((resolve) => {
                    finish = resolve;
                })
        );
        session.transport.onmessage({ jsonrpc: '2.0', method: 'tools/call', id: 1 } as JSONRPCMessage);
        session.transport.onmessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } } as JSONRPCMessage);
        await vi.advanceTimersByTimeAsync(3000);
        expect(session.server.close).not.toHaveBeenCalled();
        finish?.();
        await pending;
        await vi.advanceTimersByTimeAsync(1000);
        expect(session.server.close).toHaveBeenCalledTimes(1);
    });

    it('closes all sessions, clears the timer and rejects pending admissions after shutdown', async () => {
        const sessions = registry();
        const session = state();
        const release = sessions.reserve();
        await sessions.close();
        sessions.add('late', session);
        release?.();
        await Promise.resolve();
        expect(session.transport.close).toHaveBeenCalledTimes(1);
        expect(sessions.reserve()).toBeUndefined();
        expect(vi.getTimerCount()).toBe(0);
    });
});
