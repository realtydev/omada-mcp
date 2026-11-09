import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ToolProfile } from '../../src/config.js';
import { createServer } from '../../src/server/common.js';
import { toolRegistrationServer } from '../../src/server/toolProfile.js';

const MUTATING = /^(create|update|delete|set|batch|start|reboot|adopt|block|unblock|reconnect)/;

describe('tool exposure profiles', () => {
    const closers: Array<() => Promise<void>> = [];
    afterEach(async () => {
        await Promise.all(closers.splice(0).map((close) => close()));
    });

    async function connect(profile?: ToolProfile) {
        const api = {
            listSites: vi.fn().mockResolvedValue([{ id: 'test-site' }]),
            rebootDevice: vi.fn(),
            genericApiCall: vi.fn(),
            deleteDhcpReservation: vi.fn(),
        };
        const server = createServer(api as never, profile ? { toolProfile: profile } : undefined);
        const client = new Client({ name: 'tool-profile-test', version: '0.0.0' });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        closers.push(
            () => client.close(),
            () => server.close()
        );
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
        return { api, server, client };
    }

    it('keeps the existing full catalogue and write schemas unchanged by default', async () => {
        const { client: implicit } = await connect();
        const { client: explicit } = await connect('full');
        const { tools: implicitTools } = await implicit.listTools();
        const { tools: explicitTools } = await explicit.listTools();
        expect(implicitTools).toEqual(explicitTools);
        expect(implicitTools.length).toBeGreaterThan(80);
        expect(implicitTools.some((tool) => tool.name === 'genericApiCall')).toBe(true);
        expect(implicitTools.find((tool) => tool.name === 'rebootDevice')?.inputSchema.additionalProperties).toBe(false);
    });

    it('lists only safe read operations and includes the new network diagnostics', async () => {
        const { client } = await connect('read-only');
        const { tools } = await client.listTools();
        expect(tools.length).toBeGreaterThan(30);
        expect(tools.every((tool) => /^(get|list|search|diagnose)[A-Z]/.test(tool.name))).toBe(true);
        expect(tools.every((tool) => tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint === false)).toBe(true);
        expect(tools.filter((tool) => MUTATING.test(tool.name))).toEqual([]);
        expect(tools.some((tool) => tool.name === 'genericApiCall')).toBe(false);
        for (const name of [
            'getApRfScanResults',
            'getApAfcStatus',
            'listDhcpReservations',
            'getSiteTopology',
            'getSiteDashboard',
            'diagnoseClient',
            'diagnoseLogs',
        ]) {
            expect(tools.some((tool) => tool.name === name)).toBe(true);
        }
        const result = await client.callTool({ name: 'listSites', arguments: {} });
        expect(result.isError).toBeFalsy();
        expect(result.content).toEqual([{ type: 'text', text: JSON.stringify([{ id: 'test-site' }], null, 2) }]);
    });

    it.each(['rebootDevice', 'deleteDhcpReservation', 'genericApiCall'] as const)('cannot invoke excluded %s through MCP', async (name) => {
        const { api, client } = await connect('read-only');
        const validArguments = {
            rebootDevice: { deviceMac: 'AA-BB-CC-DD-EE-FF' },
            deleteDhcpReservation: { mac: 'AA-BB-CC-DD-EE-FF' },
            genericApiCall: { method: 'POST', path: '/sites/test-site/cmd/reboot' },
        };
        const result = await client.callTool({ name, arguments: validArguments[name] });
        expect(result.isError).toBe(true);
        expect(result.content).toEqual([expect.objectContaining({ text: expect.stringContaining(`Tool ${name} not found`) })]);
        expect(api[name]).not.toHaveBeenCalled();
    });

    it('fails closed on unknown naming families and destructive reads while retaining SDK this', () => {
        let originalThis: unknown;
        const registered: Array<{ name: string; config: { annotations?: unknown } }> = [];
        const original = {
            registerTool(name: string, config: { annotations?: unknown }) {
                originalThis = this;
                registered.push({ name, config });
            },
        };
        const server = original as unknown as McpServer;
        expect(toolRegistrationServer(server, 'full')).toBe(server);
        const filtered = toolRegistrationServer(server, 'read-only');
        filtered.registerTool('unknownOperation', { annotations: { readOnlyHint: true } }, vi.fn());
        filtered.registerTool('getDestructiveOperation', { annotations: { destructiveHint: true } }, vi.fn());
        filtered.registerTool('genericApiCall', {}, vi.fn());
        expect(registered).toEqual([]);
        filtered.registerTool('getStatus', {}, vi.fn());
        expect(originalThis).toBe(original);
        expect(registered).toEqual([{ name: 'getStatus', config: { annotations: { readOnlyHint: true, destructiveHint: false } } }]);
    });
});
