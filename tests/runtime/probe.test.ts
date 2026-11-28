import { beforeEach, describe, expect, it, vi } from 'vitest';
import { probe } from '../../src/runtime/core.js';

const client = vi.hoisted(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn(),
    callTool: vi.fn(),
}));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: class {
        constructor() {
            return client;
        }
    },
}));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
    StreamableHTTPClientTransport: class {
        close = vi.fn().mockResolvedValue(undefined);
    },
}));

describe('runtime probes across catalog modes', () => {
    const info = { packageVersion: '0.14.0', gitCommit: 'abcdef0', buildTime: '2026-11-16T12:00:00Z' };
    const state = { mode: 'docker' as const, current: { version: info.packageVersion }, url: 'http://127.0.0.1:3000/mcp' };
    beforeEach(() => {
        vi.clearAllMocks();
        client.callTool.mockImplementation(({ name, arguments: args }) =>
            Promise.resolve({
                content: [{ type: 'text', text: JSON.stringify((name === 'callTool' ? args.name : name) === 'getServerInfo' ? info : []) }],
            })
        );
    });
    it.each([false, true])('verifies build identity and doctor reads with compact=%s', async (compact) => {
        client.listTools.mockResolvedValue({
            tools: (compact ? ['searchTools', 'describeTool', 'getServerCapabilities', 'callTool'] : ['getServerInfo', 'listSites']).map((name) => ({
                name,
            })),
        });
        expect(await probe(state, state.current, true)).toEqual(info);
        const calls = client.callTool.mock.calls.map(([request]) => request);
        expect(calls).toEqual(
            ['getServerInfo', 'listSites'].map((name) =>
                compact ? { name: 'callTool', arguments: { name, arguments: {} } } : { name, arguments: {} }
            )
        );
        expect(client.close).toHaveBeenCalledOnce();
    });
    it.each([false, true])('checks the MSP customer list without a default customer with compact=%s', async (compact) => {
        const mspInfo = { ...info, mspCustomerRequired: true };
        client.listTools.mockResolvedValue({ tools: [{ name: compact ? 'callTool' : 'getServerInfo' }] });
        client.callTool.mockResolvedValueOnce({ content: [{ type: 'text', text: JSON.stringify(mspInfo) }] });
        expect(await probe(state, state.current, true)).toEqual(mspInfo);
        expect(client.callTool).toHaveBeenLastCalledWith(
            compact ? { name: 'callTool', arguments: { name: 'listMspCustomers', arguments: {} } } : { name: 'listMspCustomers', arguments: {} },
            undefined,
            { timeout: 35_000 }
        );
    });
    it('does not hide failed compact calls', async () => {
        client.listTools.mockResolvedValue({ tools: [{ name: 'callTool' }] });
        client.callTool.mockResolvedValue({ isError: true, content: [] });
        await expect(probe(state)).rejects.toThrow('Cannot verify');
        expect(client.close).toHaveBeenCalledOnce();
    });
});
