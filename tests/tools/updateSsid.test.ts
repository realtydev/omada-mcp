import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerUpdateSsidTool } from '../../src/tools/updateSsid.js';

describe('updateSsid protocol boundary', () => {
    const connections: { client: Client; server: McpServer }[] = [];
    afterEach(async () => {
        await Promise.all(connections.splice(0).flatMap(({ client, server }) => [client.close(), server.close()]));
    });

    async function connect() {
        const server = new McpServer({ name: 'ssid-test', version: '1.0.0' });
        const updateSsid = vi.fn().mockResolvedValue({ dryRun: false, written: true, verification: { status: 'verified' } });
        registerUpdateSsidTool(server, { updateSsid } as never);
        const client = new Client({ name: 'ssid-test-client', version: '1.0.0' });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
        connections.push({ client, server });
        return { client, updateSsid };
    }

    it('passes partial settings through with preview explicitly enabled', async () => {
        const { client, updateSsid } = await connect();
        const result = await client.callTool({
            name: 'updateSsid',
            arguments: { wlanId: 'wlan', ssidId: 'ssid', ssid: { name: 'New' }, dryRun: true },
        });
        expect(result.isError).toBeFalsy();
        expect(updateSsid).toHaveBeenCalledExactlyOnceWith('wlan', 'ssid', { name: 'New' }, undefined, true);
    });

    it('keeps apply as the default for existing callers', async () => {
        const { client, updateSsid } = await connect();
        const result = await client.callTool({ name: 'updateSsid', arguments: { wlanId: 'wlan', ssidId: 'ssid', ssid: { band: 3 } } });
        expect(result.isError).toBeFalsy();
        expect(updateSsid).toHaveBeenCalledExactlyOnceWith('wlan', 'ssid', { band: 3 }, undefined);
    });

    it.each([
        { ssid: { name: 'New' }, typo: true },
        { ssid: { ssidEnable: false } },
        { ssid: { pskSetting: { securityKey: 'short' } } },
        { ssid: { pskSetting: { typo: true } } },
        { ssid: { name: 'é'.repeat(17) } },
    ])('rejects unknown or invalid fields before invoking the controller: %j', async (args) => {
        const { client, updateSsid } = await connect();
        const result = await client.callTool({ name: 'updateSsid', arguments: { wlanId: 'wlan', ssidId: 'ssid', ...args } });
        expect(result.isError).toBe(true);
        expect(updateSsid).not.toHaveBeenCalled();
    });
});
