import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { OperationCatalog } from '../../src/discovery/catalog.js';
import { executeDiscoveredOperation } from '../../src/discovery/execute.js';
import {
    executeMdnsWrite,
    MDNS_NETWORKS_PATH,
    MDNS_PATH,
    MDNS_PROFILES_PATH,
    readMdnsRows,
    validateMdnsReferences,
} from '../../src/discovery/mdns.js';
import type { RequestHandler } from '../../src/omadaClient/request.js';
import { ToolAccessPolicy } from '../../src/server/toolPolicy.js';

const document = JSON.parse(readFileSync(new URL('../../docs/openapi/00-all.json', import.meta.url), 'utf8'));
const catalog = new OperationCatalog(document, 'bundled');
const context = { omadacId: 'controller', siteId: 'site', readOnly: false };
const body = {
    name: 'Test mDNS',
    status: false,
    profileIds: ['profile'],
    type: 1,
    osg: { serviceNetworks: ['service'], clientNetworks: ['client'] },
};
const row = { ...body, id: 'mdns-1' };
const sibling = { ...row, id: 'other', name: 'Other' };
const grid = (data: unknown[], overrides = {}) => ({ totalRows: data.length, currentPage: 1, currentSize: 100, data, ...overrides });
function setup(states: unknown[], ack: unknown = { errorCode: 0, result: { id: 'mdns-1' } }, refs: { profiles?: unknown; networks?: unknown } = {}) {
    let count = 0;
    const request = {
        request: vi.fn((input) => {
            if (input.method === 'GET') {
                if (input.url.endsWith('/profiles/bonjour-service')) return { errorCode: 0, result: refs.profiles ?? { data: [{ id: 'profile' }] } };
                if (input.url.endsWith('/lan-networks'))
                    return { errorCode: 0, result: refs.networks ?? grid([{ id: 'service' }, { id: 'client' }]) };
                const value = states[Math.min(count++, states.length - 1)];
                if (value instanceof Error) throw value;
                return { errorCode: 0, result: value };
            }
            if (ack instanceof Error) throw ack;
            return ack;
        }),
        ensureSuccess: vi.fn((response) => {
            if (response.errorCode !== 0) throw Object.assign(new Error('Controller rejected mDNS'), { errorCode: response.errorCode });
            return response.result;
        }),
    };
    const run = (operationId = 'createMdns', settings: unknown = body, policy = context, source = catalog, dryRun = false) =>
        executeDiscoveredOperation(
            source,
            request as unknown as RequestHandler,
            {
                operationId,
                params: operationId === 'createMdns' ? {} : { mdnsId: row.id },
                ...(operationId === 'deleteMdns' ? {} : { body: settings }),
                dryRun,
            },
            policy
        );
    const writes = () => request.request.mock.calls.filter(([input]) => input.method !== 'GET');
    return { run, request, writes };
}

describe('verified discovered mDNS rule management', () => {
    it('previews without any reads or mutations', async () => {
        const { run, request } = setup([]);
        expect(await run('createMdns', body, context, catalog, true)).toMatchObject({ dryRun: true, written: false, verified: false });
        expect(request.request).not.toHaveBeenCalled();
    });
    it('creates once after complete reference inventories and verifies a unique identity and siblings', async () => {
        const { run, writes, request } = setup([[sibling], [sibling], [sibling, row]]);
        expect(await run()).toMatchObject({
            written: true,
            verified: true,
            verification: { resourceId: row.id },
            rollbackReceipt: { resource: 'mdns-rule', before: null, appliedId: row.id },
        });
        expect(writes()).toHaveLength(1);
        expect(writes()[0][1]).toBe(false);
        expect(request.request.mock.calls.some(([input]) => input.url.endsWith('/profiles/bonjour-service'))).toBe(true);
        expect(request.request.mock.calls.some(([input]) => input.url.endsWith('/lan-networks'))).toBe(true);
    });
    it('preserves omitted mode and nested configuration on updates', async () => {
        const changed = { ...row, name: 'Changed' };
        const { run, writes } = setup([[row], [row], [changed]]);
        const r = await run('modifyMdns', { name: changed.name, status: false, profileIds: ['profile'] });
        expect(r).toMatchObject({ verified: true, rollbackReceipt: { beforeId: row.id, appliedId: row.id } });
        expect(writes()[0][0].data).toEqual({ ...body, name: changed.name });
    });
    it('treats equivalent unordered selections as no-op without reference reads', async () => {
        const before = { ...row, profileIds: ['profile', 'other'], osg: { ...body.osg, serviceNetworks: ['a', 'b'] } };
        const { run, writes, request } = setup([[before]]);
        expect(
            await run('modifyMdns', {
                ...body,
                profileIds: ['other', 'profile'],
                osg: { ...before.osg, serviceNetworks: ['b', 'a'] },
            })
        ).toMatchObject({ written: false, verified: true });
        expect(writes()).toHaveLength(0);
        expect(request.request).toHaveBeenCalledOnce();
    });
    it('deletes once without depending on still-existing reference profiles and networks', async () => {
        const { run, writes } = setup([[row, sibling], [row, sibling], [sibling]], undefined, { profiles: null, networks: null });
        expect(await run('deleteMdns')).toMatchObject({ written: true, verified: true, rollbackReceipt: { beforeId: row.id, applied: null } });
        expect(writes()).toHaveLength(1);
    });
    it('returns an absent delete as a verified no-op', async () => {
        const { run, writes } = setup([[]]);
        expect(await run('deleteMdns')).toMatchObject({ written: false, verified: true });
        expect(writes()).toHaveLength(0);
    });
    it('refuses missing update targets and name conflicts before writing', async () => {
        const missing = setup([[]]);
        await expect(missing.run('modifyMdns')).rejects.toThrow('does not exist');
        expect(missing.writes()).toHaveLength(0);
        const conflict = setup([[{ ...row, id: 'other' }]]);
        await expect(conflict.run()).rejects.toThrow('conflicts');
        expect(conflict.writes()).toHaveLength(0);
    });
    it('refuses rule drift after reference validation', async () => {
        const { run, writes } = setup([[row], [{ ...row, name: 'Changed externally' }]]);
        await expect(run('modifyMdns', { ...body, name: 'Requested' })).rejects.toThrow('changed during preflight');
        expect(writes()).toHaveLength(0);
    });
    it.each(['createMdns', 'modifyMdns', 'deleteMdns'])('does not replay an unacknowledged %s or issue a receipt', async (operation) => {
        const desired = { ...body, name: operation === 'modifyMdns' ? 'Changed' : body.name };
        const before = operation === 'createMdns' ? [] : [row],
            after = operation === 'deleteMdns' ? [] : [{ ...row, ...desired }];
        const { run, writes } = setup([before, before, after], new Error('timeout'));
        const result = await run(operation, desired);
        expect(result).toMatchObject({ written: 'unknown', verified: true });
        expect(result.rollbackReceipt).toBeUndefined();
        expect(writes()).toHaveLength(1);
        expect(writes()[0][1]).toBe(false);
    });
    it('preserves explicit HTTP and API rejections without readback', async () => {
        const rejected = setup([[], []], { errorCode: -1600 });
        await expect(rejected.run()).rejects.toMatchObject({ errorCode: -1600 });
        expect(rejected.writes()).toHaveLength(1);
        const forbidden = setup([[], []], Object.assign(new Error('Forbidden'), { status: 403 }));
        await expect(forbidden.run()).rejects.toMatchObject({ status: 403 });
        expect(forbidden.writes()).toHaveLength(1);
    });
    it('does not verify mismatches, ambiguous created identities or sibling changes', async () => {
        for (const after of [[], [row, { ...row, id: 'other' }], [row, { ...sibling, name: 'Changed externally' }]]) {
            const { run, writes } = setup([[], [], after]);
            expect(await run()).toMatchObject({ written: true, verified: false });
            expect(writes()).toHaveLength(1);
        }
    });
    it('does not verify a conflicting acknowledgement ID', async () => {
        const { run } = setup([[], [], [row]], { errorCode: 0, result: 'different' });
        expect(await run()).toMatchObject({ verified: false });
    });
    it('reports unavailable readback without exposing raw read errors', async () => {
        const { run } = setup([[], [], new Error('private detail')]);
        const r = await run();
        expect(r).toMatchObject({ verified: false, verification: { status: 'unknown' } });
        expect(JSON.stringify(r)).not.toContain('private detail');
    });
    it('requires network read/write authority and list contract before preflight', async () => {
        const { run, request } = setup([]);
        await expect(
            run('createMdns', body, { ...context, accessPolicy: new ToolAccessPolicy('full', 'network:w') } as typeof context)
        ).rejects.toThrow('not permitted');
        await expect(run('createMdns', body, { ...context, readOnly: true })).rejects.toThrow('Read-only');
        const changed = structuredClone(document);
        delete changed.paths[MDNS_PATH].get;
        await expect(run('createMdns', body, context, new OperationCatalog(changed, 'live'))).rejects.toThrow('list operation');
        expect(request.request).not.toHaveBeenCalled();
    });
    it('validates full AP VLAN configuration despite the vendor legacy regex', async () => {
        const { run, request } = setup([]);
        expect(
            await run(
                'createMdns',
                { name: body.name, status: body.status, profileIds: body.profileIds, type: 0, ap: { serviceVlan: '20', clientVlan: '1,10-12' } },
                context,
                catalog,
                true
            )
        ).toMatchObject({ written: false });
        expect(request.request).not.toHaveBeenCalled();
    });
    it('compares equivalent VLAN ranges without expanding their members', async () => {
        const before = {
            id: row.id,
            name: body.name,
            status: false,
            profileIds: body.profileIds,
            type: 0,
            ap: { serviceVlan: '20', clientVlan: '1,2-4' },
        };
        const { run, writes } = setup([[before]]);
        const { id: _id, ...settings } = before;
        expect(await run('modifyMdns', { ...settings, ap: { ...settings.ap, clientVlan: '1-4' } })).toMatchObject({ written: false, verified: true });
        expect(writes()).toHaveLength(0);
    });
    it('rejects repeated maximum VLAN ranges before any I/O or canonical expansion', async () => {
        const settings = {
            name: body.name,
            status: false,
            profileIds: body.profileIds,
            type: 0,
            ap: { serviceVlan: '20', clientVlan: Array(1000).fill('1-4094').join(',') },
        };
        const { run, request } = setup([]);
        await expect(run('createMdns', settings, context, catalog, true)).rejects.toThrow();
        expect(request.request).not.toHaveBeenCalled();
        await expect(readMdnsRows(async () => [{ ...settings, id: row.id }])).rejects.toThrow('configuration');
    });
    it.each([
        { ...body, type: undefined },
        { ...body, profileIds: [] },
        { ...body, profileIds: ['profile', 'profile'] },
        { ...body, type: 0 },
        { ...body, osg: { serviceNetworks: [], clientNetworks: ['client'] } },
        { ...body, type: 0, osg: undefined, ap: { serviceVlan: '4095', clientVlan: '1' } },
        { ...body, type: 0, osg: undefined, ap: { serviceVlan: '1', clientVlan: '|' } },
        { ...body, type: 0, osg: undefined, ap: { serviceVlan: '1', clientVlan: '4-2' } },
        { ...body, type: 0, osg: undefined, ap: { serviceVlan: '1', clientVlan: '1,1-2' } },
        { ...body, future: 'ignored' },
    ])('rejects malformed or unsupported submitted configuration without I/O', async (settings) => {
        const { run, request } = setup([]);
        await expect(run('createMdns', settings, context, catalog, true)).rejects.toThrow();
        expect(request.request).not.toHaveBeenCalled();
    });
    it('keeps unknown vendor regexes fail-closed', async () => {
        const changed = structuredClone(document);
        changed.components.schemas.ApMdnsRuleOpenApiVO.properties.clientVlan.pattern = '[invalid';
        const { run, request } = setup([]);
        await expect(run('createMdns', body, context, new OperationCatalog(changed, 'live'), true)).rejects.toThrow();
        expect(request.request).not.toHaveBeenCalled();
    });
    it('rejects future writable fields rather than silently discarding them', async () => {
        const changed = structuredClone(document);
        changed.components.schemas.CreateMdnsRuleOpenApiVO.properties.futureField = { type: 'integer' };
        const { run, request } = setup([]);
        await expect(run('createMdns', { ...body, futureField: 1 }, context, new OperationCatalog(changed, 'live'))).rejects.toThrow();
        expect(request.request).not.toHaveBeenCalled();
    });
    it.each([
        { profiles: { data: [] } },
        { networks: grid([]) },
        { profiles: { data: [{ id: 'profile' }, { id: 'profile' }] } },
        { networks: grid([{ id: 'service' }], { totalRows: 2 }) },
    ])('refuses missing or incomplete referenced resources before mutation', async (refs) => {
        const { run, writes } = setup([[]], undefined, refs);
        await expect(run()).rejects.toThrow();
        expect(writes()).toHaveLength(0);
    });
    it('requires a reference validator on direct changed helper calls', async () => {
        const request = { request: vi.fn() };
        await expect(
            executeMdnsWrite(
                request as never,
                'POST',
                '/rule',
                undefined,
                body,
                async () => [],
                () => undefined
            )
        ).rejects.toThrow('reference validation');
        expect(request.request).not.toHaveBeenCalled();
    });
    it('does not issue a delete receipt when prior state cannot pass the restoration create contract', async () => {
        const changed = structuredClone(document);
        changed.components.schemas.CreateMdnsRuleOpenApiVO.properties.name.maxLength = 3;
        const { run } = setup([[row], [row], []]);
        const result = await run('deleteMdns', undefined, context, new OperationCatalog(changed, 'live'));
        expect(result).toMatchObject({ written: true, verified: true, rollbackUnavailable: expect.stringContaining('create contract') });
        expect(result.rollbackReceipt).toBeUndefined();
    });
});

describe('bounded mDNS collection and references', () => {
    it.each([[row], grid([row]), { data: [row] }])('accepts complete supported envelopes', async (value) => {
        expect(await readMdnsRows(async (page) => (page === 1 ? value : { data: [], currentPage: page }))).toEqual([row]);
    });
    it.each([
        null,
        {},
        grid([row, row]),
        grid([{ ...row, id: undefined }]),
        grid([{ ...row, mdnsId: 'different' }]),
        grid([row], { totalRows: 0 }),
        grid([], { totalRows: 1 }),
        grid([], { currentPage: 2 }),
        grid([row], { currentSize: 50 }),
        grid([row], { totalRows: 1001 }),
        grid([{ ...row, osg: { serviceNetworks: [], clientNetworks: ['client'] } }]),
    ])('refuses incomplete/malformed evidence', async (value) => {
        await expect(readMdnsRows(async () => value)).rejects.toThrow();
    });
    it('supports consistent mdnsId aliases while excluding read-only metadata', async () => {
        const { id, ...rest } = row;
        expect(await readMdnsRows(async () => [{ ...rest, mdnsId: id, profileNames: ['private metadata'] }])).toEqual([row]);
    });
    it('collects paginated inventories and refuses repeats or count drift', async () => {
        expect(await readMdnsRows(async (page) => grid([page === 1 ? row : sibling], { totalRows: 2, currentPage: page }))).toEqual([row, sibling]);
        await expect(readMdnsRows(async () => ({ data: [row] }))).rejects.toThrow('repeated');
        await expect(
            readMdnsRows(async (page) => grid([{ ...row, id: String(page) }], { totalRows: page === 1 ? 3 : 4, currentPage: page }))
        ).rejects.toThrow('count');
    });
    it('caps page count and bare-array records', async () => {
        await expect(readMdnsRows(async (page) => ({ data: [{ ...row, id: String(page) }] }))).rejects.toThrow('10-page');
        await expect(readMdnsRows(async () => Array.from({ length: 1001 }, (_, i) => ({ ...row, id: String(i) })))).rejects.toThrow('1000-record');
    });
    it('reads all reference network pages and only one profile list', async () => {
        const profiles = vi.fn(async () => ({ data: [{ id: 'profile' }] }));
        const networks = vi.fn(async (page) => grid([{ id: page === 1 ? 'service' : 'client' }], { totalRows: 2, currentPage: page }));
        await validateMdnsReferences(body, profiles, networks);
        expect(profiles).toHaveBeenCalledOnce();
        expect(networks).toHaveBeenCalledTimes(2);
    });
    it('does not read network references for AP VLAN mode', async () => {
        const networks = vi.fn();
        await validateMdnsReferences(
            { ...body, type: 0, osg: undefined, ap: { serviceVlan: '20', clientVlan: '1-4' } },
            async () => ({ data: [{ id: 'profile' }] }),
            networks
        );
        expect(networks).not.toHaveBeenCalled();
    });
    it.each([MDNS_PROFILES_PATH, MDNS_NETWORKS_PATH])('requires documented reference operation %s', async (path) => {
        const changed = structuredClone(document);
        delete changed.paths[path].get;
        const { run, writes } = setup([[]]);
        await expect(run('createMdns', body, context, new OperationCatalog(changed, 'live'))).rejects.toThrow('reference list');
        expect(writes()).toHaveLength(0);
    });
});
