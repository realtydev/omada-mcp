import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { OperationCatalog } from '../../src/discovery/catalog.js';
import { executeDiscoveredOperation } from '../../src/discovery/execute.js';
import { readLanDnsRows } from '../../src/discovery/lanDns.js';
import type { RequestHandler } from '../../src/omadaClient/request.js';
import { ToolAccessPolicy } from '../../src/server/toolPolicy.js';

const document = JSON.parse(readFileSync(new URL('../../docs/openapi/00-all.json', import.meta.url), 'utf8'));
const catalog = new OperationCatalog(document, 'bundled');
const context = { omadacId: 'controller', siteId: 'site', readOnly: false };
const body = { enable: false, name: 'Test DNS', domain: 'test.invalid', type: 0, ipAddresses: ['192.0.2.1'], lanNetworkIds: ['net'] };
const row = { ...body, id: 'dns-1', aliases: [], ipv6Addresses: [] };
const unrelated = { ...row, id: 'other', name: 'Other DNS', domain: 'other.invalid' };
const grid = (data: unknown[], overrides = {}) => ({ totalRows: data.length, currentPage: 1, data, ...overrides });
function setup(states: unknown[], ack: unknown = { errorCode: 0, result: { id: 'dns-1' } }) {
    let count = 0;
    const request = {
        request: vi.fn((input) => {
            if (input.method === 'GET') {
                const state = states[Math.min(count++, states.length - 1)];
                if (state instanceof Error) throw state;
                return { errorCode: 0, result: state };
            }
            if (ack instanceof Error) throw ack;
            return ack;
        }),
        ensureSuccess: vi.fn((response) => {
            if (response.errorCode !== 0) throw Object.assign(new Error('Controller rejected LAN DNS write'), { errorCode: response.errorCode });
            return response.result;
        }),
    };
    const run = (operationId = 'createLanDns', settings: unknown = body, policy = context, source = catalog) =>
        executeDiscoveredOperation(
            source,
            request as unknown as RequestHandler,
            {
                operationId,
                ...(operationId === 'deleteLanDns' ? {} : { body: settings }),
                params: operationId === 'createLanDns' ? {} : { dnsId: 'dns-1' },
                dryRun: false,
            },
            policy
        );
    const writes = () => request.request.mock.calls.filter(([input]) => input.method !== 'GET');
    return { request, run, writes };
}

describe('verified discovered LAN DNS writes', () => {
    it('creates once and verifies against a new identity without changing unrelated entries', async () => {
        const { run, writes } = setup([grid([unrelated]), grid([unrelated]), grid([unrelated, row])]);
        const r = await run();
        expect(r).toMatchObject({ written: true, verified: true, verification: { status: 'verified', resourceId: row.id, attempts: 1 } });
        expect(writes()).toHaveLength(1);
        expect(writes()[0][1]).toBe(false);
    });
    it('merges omitted writable fields on update, verifies case-insensitive DNS and unordered selections', async () => {
        const before = { ...row, aliases: ['a.test', 'b.test'], lanNetworkIds: ['net', 'net2'] };
        const after = { ...before, name: 'Changed DNS', domain: 'TEST.INVALID', aliases: ['b.test', 'a.test'], lanNetworkIds: ['net2', 'net'] };
        const { run, writes } = setup([[before], [before], [after]]);
        const r = await run('modifyLanDns', { ...body, name: after.name, lanNetworkIds: ['net', 'net2'] });
        expect(r.verified).toBe(true);
        expect(writes()[0][0].data).toMatchObject({ aliases: before.aliases, ipv6Addresses: [] });
        expect(writes()).toHaveLength(1);
    });
    it('does not write an unchanged configuration', async () => {
        const { run, writes } = setup([grid([row])]);
        expect(await run('modifyLanDns')).toMatchObject({ written: false, verified: true, verification: { attempts: 0 } });
        expect(writes()).toHaveLength(0);
    });
    it('deletes once and verifies absence', async () => {
        const { run, writes } = setup([grid([row, unrelated]), grid([row, unrelated]), grid([unrelated])]);
        expect(await run('deleteLanDns')).toMatchObject({ written: true, verified: true });
        expect(writes()).toHaveLength(1);
    });
    it('treats an already absent delete as a verified no-op', async () => {
        const { run, writes } = setup([[]]);
        expect(await run('deleteLanDns')).toMatchObject({ written: false, verified: true });
        expect(writes()).toHaveLength(0);
    });
    it('refuses missing update targets', async () => {
        const { run, writes } = setup([[]]);
        await expect(run('modifyLanDns')).rejects.toThrow('does not exist');
        expect(writes()).toHaveLength(0);
    });
    it.each([
        { ...row, id: 'other' },
        { ...row, id: 'other', name: 'Different' },
        { ...row, id: 'other', domain: 'different.invalid' },
    ])('refuses existing names or domains before create', async (existing) => {
        const { run, writes } = setup([[existing]]);
        await expect(run()).rejects.toThrow('conflicts');
        expect(writes()).toHaveLength(0);
    });
    it('refuses preflight drift without sending a mutation', async () => {
        const { run, writes } = setup([[row], [{ ...row, name: 'Concurrent edit' }]]);
        await expect(run('modifyLanDns', { ...body, name: 'Requested' })).rejects.toThrow('changed during preflight');
        expect(writes()).toHaveLength(0);
    });
    it.each(['createLanDns', 'modifyLanDns', 'deleteLanDns'])(
        'never replays an unacknowledged %s even when readback verifies desired state',
        async (operation) => {
            const before = operation === 'createLanDns' ? [] : [row];
            const desired = { ...body, name: operation === 'modifyLanDns' ? 'Changed' : body.name };
            const after = operation === 'deleteLanDns' ? [] : [{ ...row, ...desired }];
            const { run, writes } = setup([grid(before), grid(before), grid(after)], new Error('timeout'));
            expect(await run(operation, desired)).toMatchObject({ written: 'unknown', verified: true, verification: { status: 'verified' } });
            expect(writes()).toHaveLength(1);
            expect(writes()[0][1]).toBe(false);
        }
    );
    it('preserves explicit API rejection codes without polling or claiming uncertainty', async () => {
        const { run, writes, request } = setup([[], []], { errorCode: -1600, msg: 'Unsupported' });
        await expect(run()).rejects.toMatchObject({ errorCode: -1600 });
        expect(writes()).toHaveLength(1);
        expect(request.request).toHaveBeenCalledTimes(3);
    });
    it('does not reinterpret definite HTTP rejection as success', async () => {
        const rejection = Object.assign(new Error('Forbidden'), { status: 403 });
        const { run, writes } = setup([[], []], rejection);
        await expect(run()).rejects.toBe(rejection);
        expect(writes()).toHaveLength(1);
    });
    it('reconciles malformed acknowledgements using readback', async () => {
        const { run, writes } = setup([[], [], [row]], '<html>unavailable</html>');
        expect(await run()).toMatchObject({ written: 'unknown', verified: true });
        expect(writes()).toHaveLength(1);
    });
    it('reports missing readback fields as unknown rather than verified', async () => {
        const missing = { ...row, ipAddresses: undefined };
        const { run, writes } = setup([[], [], [missing]]);
        expect(await run()).toMatchObject({ written: true, verified: false, verification: { status: 'unknown', attempts: 3 } });
        expect(writes()).toHaveLength(1);
    });
    it('reports unapplied writes as mismatches without replay', async () => {
        const { run, writes } = setup([[], [], []]);
        expect(await run()).toMatchObject({ written: true, verified: false, verification: { status: 'mismatch', attempts: 3 } });
        expect(writes()).toHaveLength(1);
    });
    it('retains unknown write status when a timed-out mutation cannot be observed', async () => {
        const { run, writes } = setup([[], [], []], new Error('timeout'));
        expect(await run()).toMatchObject({ written: 'unknown', verified: false });
        expect(writes()).toHaveLength(1);
    });
    it('does not call unrelated-row changes verified', async () => {
        const { run } = setup([[unrelated], [unrelated], [{ ...unrelated, name: 'Changed by somebody' }, row]]);
        expect(await run()).toMatchObject({ verified: false, verification: { status: 'mismatch' } });
    });
    it('rejects ambiguous created identities', async () => {
        const { run } = setup([[], [], [row, { ...row, id: 'dns-2' }]]);
        expect(await run()).toMatchObject({ verified: false, verification: { status: 'unknown' } });
    });
    it('does not verify a conflicting acknowledged identity', async () => {
        const { run } = setup([[], [], [row]], { errorCode: 0, result: 'different-id' });
        expect(await run()).toMatchObject({ verified: false });
    });
    it('requires both network read and write scopes before preflight', async () => {
        const { run, request } = setup([[], [], [row]]);
        await expect(
            run('createLanDns', body, { ...context, accessPolicy: new ToolAccessPolicy('full', 'network:w') } as typeof context)
        ).rejects.toThrow('not permitted');
        await expect(run('createLanDns', body, { ...context, readOnly: true })).rejects.toThrow('Read-only');
        expect(request.request).not.toHaveBeenCalled();
    });
    it('requires a declared read operation and matching body identity before touching controller state', async () => {
        const other = structuredClone(document);
        delete other.paths['/openapi/v1/{omadacId}/sites/{siteId}/setting/lan/dns'].get;
        const { run, request } = setup([]);
        await expect(run('createLanDns', body, context, new OperationCatalog(other, 'live'))).rejects.toThrow('list operation');
        await expect(run('createLanDns', { ...body, id: 'unexpected' })).rejects.toThrow(/body ID|undocumented field/);
        await expect(run('modifyLanDns', { ...body, id: 'unexpected' })).rejects.toThrow(/body ID|undocumented field/);
        expect(request.request).not.toHaveBeenCalled();
    });
    it('keeps the no-I/O preview contract', async () => {
        const request = { request: vi.fn() };
        expect(
            await executeDiscoveredOperation(catalog, request as unknown as RequestHandler, { operationId: 'createLanDns', body }, context)
        ).toMatchObject({ dryRun: true, written: false, verified: false });
        expect(request.request).not.toHaveBeenCalled();
    });
    it('rejects newly documented fields that cannot be preserved or verified instead of silently dropping them', async () => {
        const newer = structuredClone(document);
        newer.components.schemas.LanDnsOpenApiVO.properties.futureField = { type: 'integer' };
        const { run, request } = setup([]);
        await expect(run('createLanDns', { ...body, futureField: 60 }, context, new OperationCatalog(newer, 'live'))).rejects.toThrow(
            'submitted field'
        );
        expect(request.request).not.toHaveBeenCalled();
    });
    it('reports unavailable readback as unknown and does not expose raw read errors in results', async () => {
        const { run, writes } = setup([[], [], new Error('private controller detail')]);
        const r = await run();
        expect(r).toMatchObject({ written: true, verified: false, verification: { status: 'unknown' } });
        expect(JSON.stringify(r)).not.toContain('private controller detail');
        expect(writes()).toHaveLength(1);
    });
    it('preserves and verifies an omitted custom TTL during an update', async () => {
        const before = { ...row, customTtl: true, ttl: 60 };
        const { run, writes } = setup([[before], [before], [{ ...before, name: 'Changed' }]]);
        expect(await run('modifyLanDns', { ...body, name: 'Changed' })).toMatchObject({ verified: true });
        expect(writes()[0][0].data).toMatchObject({ customTtl: true, ttl: 60 });
    });
});

describe('LAN DNS collection contract regressions', () => {
    it.each([[row], grid([row]), grid([row], { totalRows: undefined })])(
        'preserves an array or paginated row without coercing missing data to empty',
        async (value) => {
            let page = 0;
            const rows = await readLanDnsRows(async () => (page++ ? grid([], { currentPage: 2, totalRows: undefined }) : value));
            expect(rows).toEqual([row]);
        }
    );
    it.each([
        null,
        {},
        { data: null },
        grid([row, row]),
        grid([{ ...row, id: undefined }]),
        grid([{ ...row, dnsId: 'conflict' }]),
        grid([row], { totalRows: 0 }),
        grid([], { totalRows: 1 }),
        grid([], { currentPage: 2 }),
        grid([row], { totalRows: 1001 }),
    ])('rejects malformed, duplicated or incomplete evidence %j', async (value) => {
        await expect(readLanDnsRows(async () => value)).rejects.toThrow();
    });
    it('accepts a consistent dnsId alias and normalizes its identity', async () => {
        const { id, ...rest } = row;
        expect(await readLanDnsRows(async () => [{ ...rest, dnsId: id }])).toEqual([row]);
    });
    it('collects all declared pages before proving completeness', async () => {
        expect(await readLanDnsRows(async (page) => grid([page === 1 ? row : unrelated], { totalRows: 2, currentPage: page }))).toEqual([
            row,
            unrelated,
        ]);
    });
    it('rejects repeated pages and changed total counts', async () => {
        await expect(readLanDnsRows(async () => ({ data: [row] }))).rejects.toThrow('repeated');
        await expect(
            readLanDnsRows(async (page) => ({ data: [{ ...row, id: `dns-${page}` }], currentPage: page, totalRows: page === 1 ? 3 : 4 }))
        ).rejects.toThrow('count');
    });
    it('caps pages and bare-array records', async () => {
        await expect(readLanDnsRows(async (page) => ({ data: [{ ...row, id: `dns-${page}` }] }))).rejects.toThrow('10-page');
        await expect(readLanDnsRows(async () => Array.from({ length: 1001 }, (_, i) => ({ ...row, id: `dns-${i}` })))).rejects.toThrow('1000-record');
    });
});
