import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerBatchSetSwitchPortNameTool } from '../../src/tools/batchSetSwitchPortName.js';
import { registerBatchSetSwitchPortPoeTool } from '../../src/tools/batchSetSwitchPortPoe.js';
import { registerSetSwitchPortStatusTool } from '../../src/tools/setSwitchPortStatus.js';
import { registerUpdateSwitchPortTool } from '../../src/tools/updateSwitchPort.js';

describe('switch safety protocol boundaries', () => {
    const clients: Client[] = [];
    afterEach(async () => {
        await Promise.all(clients.splice(0).map((client) => client.close()));
    });
    async function connect() {
        const server = new McpServer({ name: 'switch-safety-test', version: '1.0' });
        const methods = {
            setSwitchPortStatus: vi.fn().mockResolvedValue({ dryRun: true, written: false }),
            batchSetSwitchPortName: vi.fn().mockResolvedValue({ dryRun: true, written: false }),
            batchSetSwitchPortPoe: vi.fn().mockResolvedValue({ dryRun: true, written: false }),
            updateSwitchPort: vi.fn().mockResolvedValue({ dryRun: true, written: false }),
        };
        registerSetSwitchPortStatusTool(server, methods as never);
        registerBatchSetSwitchPortNameTool(server, methods as never);
        registerBatchSetSwitchPortPoeTool(server, methods as never);
        registerUpdateSwitchPortTool(server, methods as never);
        const client = new Client({ name: 'switch-client', version: '1' });
        clients.push(client);
        const [a, b] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(a), client.connect(b)]);
        return { client, methods };
    }

    it('forwards preview and disruption intent separately from controller fields', async () => {
        const { client, methods } = await connect();
        const result = await client.callTool({
            name: 'setSwitchPortStatus',
            arguments: { switchMac: 'AA-BB-CC-DD-EE-FF', port: 1, status: 0, dryRun: true, allowDisruption: true },
        });
        expect(result.isError).not.toBe(true);
        expect(methods.setSwitchPortStatus).toHaveBeenCalledExactlyOnceWith('AA-BB-CC-DD-EE-FF', 1, 0, undefined, {
            dryRun: true,
            allowDisruption: true,
        });
    });

    it.each([
        { name: 'batchSetSwitchPortPoe', values: { portList: [1, 1], poeMode: 1 } },
        { name: 'batchSetSwitchPortPoe', values: { portList: Array.from({ length: 33 }, (_, i) => i + 1), poeMode: 1 } },
        {
            name: 'batchSetSwitchPortName',
            values: {
                portNameList: [
                    { port: 1, name: 'A' },
                    { port: 1, name: 'B' },
                ],
            },
        },
        { name: 'batchSetSwitchPortName', values: { portNameList: [{ port: 1, name: 'A', unexpected: true }] } },
        { name: 'updateSwitchPort', values: { portId: '1', linkSpeed: 1000 } },
        { name: 'updateSwitchPort', values: { portId: '1', poe: true, profileId: 'new' } },
    ])('rejects an invalid $name request before client invocation', async ({ name, values }) => {
        const { client, methods } = await connect();
        const result = await client.callTool({ name, arguments: { switchMac: 'AA-BB-CC-DD-EE-FF', ...values } });
        expect(result.isError).toBe(true);
        for (const method of Object.values(methods)) expect(method).not.toHaveBeenCalled();
    });
});
