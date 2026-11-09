import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createServer } from '../../src/server/common.js';

describe('read diagnostics over MCP', () => {
    const diagnostics = {
        getApRfScanResults: { status: 0, channel2g: [], channel5g: [], currentChan5g: '36' },
        getApAfcStatus: { status: true, expirationTimeSec: 1800000000, lastResponse: true },
        getApAvailableChannels: [{ radioId: 1, apChannelDetailList: [{ channel: 36, freq: 5180, index: 1 }] }],
    };
    const closeConnections: Array<() => Promise<void>> = [];
    afterEach(async () => {
        await Promise.all(closeConnections.splice(0).map((close) => close()));
    });

    async function connect() {
        const stub = {
            getApRfScanResults: vi.fn().mockResolvedValue(diagnostics.getApRfScanResults),
            getApAfcStatus: vi.fn().mockResolvedValue(diagnostics.getApAfcStatus),
            getApAvailableChannels: vi.fn().mockResolvedValue(diagnostics.getApAvailableChannels),
            listSwitchPorts: vi.fn().mockResolvedValue([{ port: 1, power: 4.2 }]),
        };
        const server = createServer(stub as never);
        const client = new Client({ name: 'read-diagnostics-test', version: '0.0.0' });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        closeConnections.push(
            () => client.close(),
            () => server.close()
        );
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
        return { client, stub };
    }

    it.each(['getApRfScanResults', 'getApAfcStatus', 'getApAvailableChannels'] as const)(
        '%s advertises a read operation, validates the AP and returns telemetry',
        async (name) => {
            const { client, stub } = await connect();
            const { tools } = await client.listTools();
            expect(tools.find((tool) => tool.name === name)?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });

            const invalid = await client.callTool({ name, arguments: { apMac: '' } });
            expect(invalid.isError).toBe(true);
            expect(stub[name]).not.toHaveBeenCalled();

            const result = await client.callTool({ name, arguments: { apMac: 'AA-BB-CC-DD-EE-FF', siteId: 'site-1' } });
            expect(result.isError).toBeFalsy();
            expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(diagnostics[name], null, 2) }]);
            expect(stub[name]).toHaveBeenCalledWith('AA-BB-CC-DD-EE-FF', 'site-1');
        }
    );

    it('allows unfiltered switch telemetry and passes through optional filters', async () => {
        const { client, stub } = await connect();
        const unfiltered = await client.callTool({ name: 'listSwitchPorts', arguments: {} });
        expect(unfiltered.isError).toBeFalsy();
        expect(stub.listSwitchPorts).toHaveBeenLastCalledWith(undefined, undefined);
        await client.callTool({ name: 'listSwitchPorts', arguments: { switchMac: 'aa-bb-cc-dd-ee-ff', siteId: 'site-1' } });
        expect(stub.listSwitchPorts).toHaveBeenLastCalledWith('aa-bb-cc-dd-ee-ff', 'site-1');
    });

    it('surfaces device compatibility errors through the protocol', async () => {
        const { client, stub } = await connect();
        stub.getApAfcStatus.mockRejectedValue(new Error('AFC is not supported by this AP'));
        const result = await client.callTool({ name: 'getApAfcStatus', arguments: { apMac: 'AA-BB-CC-DD-EE-FF' } });
        expect(result.isError).toBe(true);
        expect(result.content).toEqual([expect.objectContaining({ text: expect.stringContaining('AFC is not supported') })]);
    });
});
