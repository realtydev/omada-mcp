import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentConfig } from '../../src/config.js';
import { loadConfigFromEnv } from '../../src/config.js';
import { createServer } from '../../src/server/common.js';
import { ToolAccessPolicy } from '../../src/server/toolPolicy.js';

describe('preview-first tools and compact dispatch', () => {
    const close: Array<() => Promise<void>> = [];
    afterEach(async () => {
        await Promise.all(close.splice(0).map((fn) => fn()));
    });
    async function connect(options: Pick<EnvironmentConfig, 'catalogMode' | 'toolProfile' | 'toolCategories'> = {}, base = new ToolAccessPolicy()) {
        const api = {
            getToolAccessPolicy: () => base,
            listSites: vi.fn().mockResolvedValue([{ id: 'site' }]),
            rebootDevice: vi.fn().mockResolvedValue({ accepted: true }),
            updateClient: vi.fn().mockResolvedValue({ dryRun: true, written: false }),
            setApRadio: vi.fn().mockResolvedValue({ verification: { status: 'verified' } }),
            genericApiCall: vi.fn().mockResolvedValue({ ok: true }),
            executeApiOperation: vi.fn().mockResolvedValue({ result: [] }),
        };
        const server = createServer(api as never, options);
        const client = new Client({ name: 'catalog-test', version: '1' });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        close.push(
            () => client.close(),
            () => server.close()
        );
        await Promise.all([server.connect(st), client.connect(ct)]);
        const call = (name: string, args: Record<string, unknown> = {}) =>
            client.callTool(
                options.catalogMode === 'compact' ? { name: 'callTool', arguments: { name, arguments: args } } : { name, arguments: args }
            );
        return { client, api, call };
    }
    it('validates compact configuration and preserves standard mode by default', () => {
        const env = { OMADA_BASE_URL: 'https://controller', OMADA_CLIENT_ID: 'id', OMADA_CLIENT_SECRET: 'secret', OMADA_OMADAC_ID: 'id' };
        expect(loadConfigFromEnv(env).catalogMode).toBe('standard');
        expect(loadConfigFromEnv({ ...env, MCP_CATALOG_MODE: 'compact' }).catalogMode).toBe('compact');
        expect(() => loadConfigFromEnv({ ...env, MCP_CATALOG_MODE: 'typo' })).toThrow();
    });
    it.each(['standard', 'compact'] as const)('preserves native validation, previews and explicit writes in %s mode', async (catalogMode) => {
        const { call, api } = await connect({ catalogMode });
        expect((await call('updateClient', { clientMac: 'AA-BB-CC-DD-EE-FF' })).isError).toBe(true);
        expect(api.updateClient).not.toHaveBeenCalled();
        await call('updateClient', { clientMac: 'AA-BB-CC-DD-EE-FF', name: 'Camera' });
        expect(api.updateClient).toHaveBeenCalledWith('AA-BB-CC-DD-EE-FF', { name: 'Camera' }, undefined, true);
        const args = { apMac: 'AA-BB-CC-DD-EE-FF', band: '5g', channelWidth: 5 };
        await call('setApRadio', args);
        expect(api.setApRadio).toHaveBeenLastCalledWith(args.apMac, args.band, { channelWidth: 5 }, undefined, true);
        const applied = await call('setApRadio', { ...args, dryRun: false });
        expect(api.setApRadio).toHaveBeenLastCalledWith(args.apMac, args.band, { channelWidth: 5 }, undefined, false);
        expect(JSON.stringify(applied)).toContain('verified');
        expect((await call('setApRadio', { ...args, unexpected: true })).isError).toBe(true);
        expect((await call('rebootDevice', { deviceMac: args.apMac, dryRun: 'false' })).isError).toBe(true);
    });
    it.each(['standard', 'compact'] as const)('never invokes a legacy write during its schema-only preview in %s mode', async (catalogMode) => {
        const { call, api } = await connect({ catalogMode });
        for (const dryRun of [undefined, true]) {
            const preview = await call('rebootDevice', { deviceMac: 'AA-BB-CC-DD-EE-FF', ...(dryRun === undefined ? {} : { dryRun }) });
            expect(preview.isError).toBeFalsy();
            expect(JSON.stringify(preview)).toContain('Schema-only preview');
        }
        expect(api.rebootDevice).not.toHaveBeenCalled();
        await call('rebootDevice', { deviceMac: 'AA-BB-CC-DD-EE-FF', dryRun: false });
        expect(api.rebootDevice).toHaveBeenCalledExactlyOnceWith('AA-BB-CC-DD-EE-FF', undefined);
        await call('genericApiCall', { method: 'POST', path: '/sites/site/example', body: { password: 'hidden-value' } }).then((result) => {
            expect(JSON.stringify(result)).not.toContain('hidden-value');
        });
        expect(api.genericApiCall).not.toHaveBeenCalled();
        await call('genericApiCall', { method: 'GET', path: '/sites' });
        expect(api.genericApiCall).toHaveBeenCalledExactlyOnceWith('GET', '/sites', 'v1', undefined, undefined);
        await call('executeApiOperation', { operationId: 'getSites' });
        expect(api.executeApiOperation).toHaveBeenCalledWith({ operationId: 'getSites' }, expect.anything());
    });
    it('advertises only four compact tools and describes the actual guarded schema', async () => {
        const { client, call, api } = await connect({ catalogMode: 'compact' });
        expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['searchTools', 'describeTool', 'getServerCapabilities', 'callTool']);
        const described = await client.callTool({ name: 'describeTool', arguments: { name: 'rebootDevice' } });
        const data = JSON.parse((described.content as Array<{ text: string }>)[0].text);
        expect(data.inputSchema.properties.dryRun.default).toBe(true);
        expect(data.inputSchema.additionalProperties).toBe(false);
        await call('listSites');
        expect(api.listSites).toHaveBeenCalledOnce();
        expect((await call('callTool')).isError).toBe(true);
        expect((await client.callTool({ name: 'listSites', arguments: {} })).isError).toBe(true);
    });
    it('hides forbidden tools from search, describe and dispatch, including configured client restrictions', async () => {
        const { client, call, api } = await connect({ catalogMode: 'compact', toolProfile: 'full' }, new ToolAccessPolicy('read-only'));
        const search = await client.callTool({ name: 'searchTools', arguments: { query: 'rebootDevice' } });
        expect(JSON.parse((search.content as Array<{ text: string }>)[0].text).total).toBe(0);
        expect((await client.callTool({ name: 'describeTool', arguments: { name: 'rebootDevice' } })).isError).toBe(true);
        expect((await call('rebootDevice', { deviceMac: 'AA-BB-CC-DD-EE-FF', dryRun: false })).isError).toBe(true);
        expect(api.rebootDevice).not.toHaveBeenCalled();
        expect((await client.listTools()).tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
        const scoped = await connect({ catalogMode: 'compact', toolCategories: 'wireless:rw' });
        expect((await scoped.call('genericApiCall', { method: 'POST', path: '/sites/s/rate-limit-profiles', dryRun: false })).isError).toBe(true);
        expect(scoped.api.genericApiCall).not.toHaveBeenCalled();
    });
});
