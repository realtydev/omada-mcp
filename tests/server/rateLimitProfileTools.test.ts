import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerRollbackNetworkChangeTool } from '../../src/tools/rollbackNetworkChange.js';
import { registerUpdateRateLimitProfileTool } from '../../src/tools/updateRateLimitProfile.js';

const config = { name: 'Limits', upLimitEnable: false, downLimitEnable: false };
const receipt = {
    version: 1,
    resource: 'rate-limit-profile',
    controllerId: 'controller',
    siteId: 'site-1',
    profileId: 'profile-1',
    before: config,
    applied: { ...config, name: 'Changed' },
};

describe('rate-limit update and rollback MCP tools', () => {
    const closers: Array<() => Promise<void>> = [];
    afterEach(async () => {
        await Promise.all(closers.splice(0).map((close) => close()));
    });
    async function setup() {
        const api = {
            updateRateLimitProfile: vi.fn().mockResolvedValue({ dryRun: true, written: false }),
            rollbackNetworkChange: vi.fn().mockResolvedValue({ dryRun: true, written: false }),
        };
        const server = new McpServer({ name: 'rate-profile-test', version: '1.0.0' });
        registerUpdateRateLimitProfileTool(server, api as never);
        registerRollbackNetworkChangeTool(server, api as never);
        const client = new Client({ name: 'rate-profile-client', version: '1.0.0' });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        closers.push(
            () => client.close(),
            () => server.close()
        );
        await Promise.all([server.connect(st), client.connect(ct)]);
        return { api, client };
    }
    it('advertises strict destructive tools and defaults updates to previews', async () => {
        const { api, client } = await setup();
        const { tools } = await client.listTools();
        expect(tools).toHaveLength(2);
        expect(tools.every((tool) => tool.annotations?.destructiveHint === true && tool.inputSchema.additionalProperties === false)).toBe(true);
        const result = await client.callTool({
            name: 'updateRateLimitProfile',
            arguments: { profileId: 'profile-1', settings: { name: 'Changed' } },
        });
        expect(result.isError).toBeFalsy();
        expect(api.updateRateLimitProfile).toHaveBeenCalledWith('profile-1', { name: 'Changed' }, undefined, true);
    });
    it('only explicitly executes when dryRun:false is provided', async () => {
        const { api, client } = await setup();
        await client.callTool({
            name: 'updateRateLimitProfile',
            arguments: { siteId: 'site-1', profileId: 'profile-1', settings: { upLimitEnable: true, upLimit: 512 }, dryRun: false },
        });
        expect(api.updateRateLimitProfile).toHaveBeenCalledWith('profile-1', { upLimitEnable: true, upLimit: 512 }, 'site-1', false);
    });
    it('rejects unknown settings and empty patches before calling the facade', async () => {
        const { api, client } = await setup();
        for (const settings of [{}, { name: 'Changed', extra: true }, { upLimit: -1 }]) {
            expect((await client.callTool({ name: 'updateRateLimitProfile', arguments: { profileId: 'profile-1', settings } })).isError).toBe(true);
        }
        expect(api.updateRateLimitProfile).not.toHaveBeenCalled();
    });
    it('defaults complete versioned rollback receipts to a preview', async () => {
        const { api, client } = await setup();
        const result = await client.callTool({ name: 'rollbackNetworkChange', arguments: { receipt } });
        expect(result.isError).toBeFalsy();
        expect(api.rollbackNetworkChange).toHaveBeenCalledWith(receipt, true);
    });
    it('rejects unsupported or amended receipt shapes before calling the facade', async () => {
        const { api, client } = await setup();
        for (const invalid of [
            { ...receipt, version: 2 },
            { ...receipt, resource: 'firewall' },
            { ...receipt, extra: true },
            { ...receipt, before: { ...config, password: 'not-allowed' } },
        ]) {
            expect((await client.callTool({ name: 'rollbackNetworkChange', arguments: { receipt: invalid, dryRun: false } })).isError).toBe(true);
        }
        expect(api.rollbackNetworkChange).not.toHaveBeenCalled();
    });
});
