import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ToolProfile } from '../../src/config.js';
import { createServer } from '../../src/server/common.js';
import { toolRegistrationServer } from '../../src/server/toolProfile.js';

const MUTATING = /^(create|update|delete|set|batch|start|reboot|adopt|block|unblock|reconnect|rollback)/;

describe('tool exposure profiles', () => {
    const closers: Array<() => Promise<void>> = [];
    afterEach(async () => {
        await Promise.all(closers.splice(0).map((close) => close()));
    });

    async function connect(profile?: ToolProfile) {
        const api = {
            refreshApiCatalog: vi.fn().mockResolvedValue({ refreshed: true, source: 'bundled' }),
            listSites: vi.fn().mockResolvedValue([{ id: 'test-site' }]),
            getTrafficHistory: vi.fn().mockResolvedValue({ sections: { traffic: { status: 'ok' } } }),
            getWifiHistory: vi.fn().mockResolvedValue({ sections: { channels: { status: 'partial' } } }),
            diagnoseWan: vi.fn().mockResolvedValue({ sections: { status: { status: 'ok' } } }),
            updateRateLimitProfile: vi.fn(),
            rollbackNetworkChange: vi.fn(),
            getControllerCapabilities: vi.fn().mockResolvedValue({ controller: { status: 'ok', mode: 'classic' } }),
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
        expect(
            tools.every(
                (tool) =>
                    /^(get|list|search|diagnose)[A-Z]/.test(tool.name) ||
                    ['describeApiOperation', 'executeApiOperation', 'refreshApiCatalog'].includes(tool.name)
            )
        ).toBe(true);
        expect(tools.every((tool) => tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint === false)).toBe(true);
        expect(tools.filter((tool) => MUTATING.test(tool.name))).toEqual([]);
        expect(tools.some((tool) => tool.name === 'genericApiCall')).toBe(false);
        for (const name of [
            'getApSsidOverrides',
            'refreshApiCatalog',
            'getApRfScanResults',
            'getApAfcStatus',
            'getControllerCapabilities',
            'getTrafficHistory',
            'getWifiHistory',
            'diagnoseWan',
            'listDhcpReservations',
            'getSiteTopology',
            'getSiteDashboard',
            'diagnoseClient',
            'diagnoseLogs',
            'diagnoseWifi',
        ]) {
            expect(tools.some((tool) => tool.name === name)).toBe(true);
        }
        const result = await client.callTool({ name: 'listSites', arguments: {} });
        expect(result.isError).toBeFalsy();
        expect(result.content).toEqual([{ type: 'text', text: JSON.stringify([{ id: 'test-site' }], null, 2) }]);
    });

    it.each(['rebootDevice', 'deleteDhcpReservation', 'genericApiCall', 'updateRateLimitProfile', 'rollbackNetworkChange'] as const)(
        'cannot invoke excluded %s through MCP',
        async (name) => {
            const { api, client } = await connect('read-only');
            const validArguments = {
                rebootDevice: { deviceMac: 'AA-BB-CC-DD-EE-FF' },
                deleteDhcpReservation: { mac: 'AA-BB-CC-DD-EE-FF' },
                genericApiCall: { method: 'POST', path: '/sites/test-site/cmd/reboot' },
                updateRateLimitProfile: { profileId: 'profile', settings: { name: 'Changed' }, dryRun: false },
                rollbackNetworkChange: {
                    receipt: {
                        version: 1,
                        resource: 'rate-limit-profile',
                        controllerId: 'controller',
                        siteId: 'site',
                        profileId: 'profile',
                        before: { name: 'Before', upLimitEnable: false, downLimitEnable: false },
                        applied: { name: 'After', upLimitEnable: false, downLimitEnable: false },
                    },
                    dryRun: false,
                },
            };
            const result = await client.callTool({ name, arguments: validArguments[name] });
            expect(result.isError).toBe(true);
            expect(result.content).toEqual([expect.objectContaining({ text: expect.stringContaining(`Tool ${name} not found`) })]);
            expect(api[name]).not.toHaveBeenCalled();
        }
    );

    it('can invoke every new diagnostic through the read-only profile', async () => {
        const { api, client } = await connect('read-only');
        const cases = [
            ['getTrafficHistory', { siteId: 'site', maxSamples: 3 }],
            ['getWifiHistory', { siteId: 'site', apMac: 'AA-BB-CC-DD-EE-FF' }],
            ['diagnoseWan', { siteId: 'site', gatewayMac: 'AA-BB-CC-DD-EE-FF' }],
        ] as const;
        for (const [name, arguments_] of cases) {
            const result = await client.callTool({ name, arguments: arguments_ });
            expect(result.isError).toBeFalsy();
            expect(api[name]).toHaveBeenCalledExactlyOnceWith(arguments_);
        }
        expect(api.updateRateLimitProfile).not.toHaveBeenCalled();
        expect(api.rollbackNetworkChange).not.toHaveBeenCalled();
    });

    it('can collect explicit capability evidence through the read-only profile', async () => {
        const { api, client } = await connect('read-only');
        const options = { siteId: 'site', wlanId: 'wlan', ssidId: 'ssid' };
        const result = await client.callTool({ name: 'getControllerCapabilities', arguments: options });
        expect(result.isError).toBeFalsy();
        expect(api.getControllerCapabilities).toHaveBeenCalledExactlyOnceWith(options);
        expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ controller: { status: 'ok', mode: 'classic' } }, null, 2) }]);
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
