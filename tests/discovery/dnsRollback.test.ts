import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { OperationCatalog } from '../../src/discovery/catalog.js';
import { DnsRollbackOperations } from '../../src/discovery/dnsRollback.js';
import { executeDiscoveredOperation } from '../../src/discovery/execute.js';
import type { RequestHandler } from '../../src/omadaClient/request.js';
import { ToolAccessPolicy } from '../../src/server/toolPolicy.js';
import { dnsChangeReceiptSchema, sameDnsConfig } from '../../src/utils/dns-change-schema.js';

const catalog = new OperationCatalog(JSON.parse(readFileSync(new URL('../../docs/openapi/00-all.json', import.meta.url), 'utf8')), 'bundled');
const dns = { enable: false, name: 'Test DNS', domain: 'test.invalid', type: 0, ipAddresses: ['192.0.2.1'], lanNetworkIds: ['net'] };
const mdns = {
    status: false,
    name: 'Test mDNS',
    type: 1,
    profileIds: ['profile'],
    osg: { serviceNetworks: ['service'], clientNetworks: ['client'] },
};
function fixture(kind: 'lan-dns' | 'mdns-rule', initial: Record<string, unknown>[] = [], policy?: ToolAccessPolicy, source = catalog) {
    let rows = structuredClone(initial),
        sequence = 0,
        loseAck = false;
    const request = {
        request: vi.fn((input: { method: string; url: string; data?: Record<string, unknown> }, retry?: boolean) => {
            if (input.method === 'GET' && input.url.endsWith('/profiles/bonjour-service'))
                return { errorCode: 0, result: { data: [{ id: 'profile' }] } };
            if (input.method === 'GET' && input.url.endsWith('/lan-networks'))
                return { errorCode: 0, result: { data: [{ id: 'service' }, { id: 'client' }], totalRows: 2, currentPage: 1, currentSize: 100 } };
            if (input.method === 'GET')
                return { errorCode: 0, result: { data: structuredClone(rows), totalRows: rows.length, currentPage: 1, currentSize: 100 } };
            const id = decodeURIComponent(input.url.split('/').at(-1)!);
            let resourceId = id;
            if (input.method === 'POST') {
                resourceId = 'new-' + ++sequence;
                rows.push({ ...structuredClone(input.data), id: resourceId });
            }
            if (input.method === 'PATCH') rows = rows.map((row) => (row.id === id ? { ...row, ...structuredClone(input.data) } : row));
            if (input.method === 'DELETE') rows = rows.filter((row) => row.id !== id);
            if (loseAck) throw new Error('Lost acknowledgement');
            return { errorCode: 0, result: { id: resourceId } };
        }),
        ensureSuccess: (response: { errorCode: number; result: unknown }) => {
            if (response.errorCode !== 0) throw Object.assign(new Error('Rejected'), { errorCode: response.errorCode });
            return response.result;
        },
    };
    const context = { omadacId: 'controller', siteId: 'site', readOnly: false, accessPolicy: policy };
    const execute = (options: Parameters<typeof executeDiscoveredOperation>[2]) =>
        executeDiscoveredOperation(source, request as unknown as RequestHandler, options, context);
    const service = { getCatalog: () => Promise.resolve(source), executeApiOperation: execute };
    const rollback = new DnsRollbackOperations(request as unknown as RequestHandler, service, 'controller');
    const prefix = kind === 'lan-dns' ? 'LanDns' : 'Mdns';
    const run = (method: 'create' | 'modify' | 'delete', body?: unknown, id = 'original') =>
        execute({
            operationId: method + prefix,
            params: method === 'create' ? {} : { [kind === 'lan-dns' ? 'dnsId' : 'mdnsId']: id },
            ...(body ? { body } : {}),
            dryRun: false,
        });
    return {
        request,
        rollback,
        run,
        rows: () => structuredClone(rows),
        set: (value: Record<string, unknown>[]) => {
            rows = structuredClone(value);
        },
        lost: () => {
            loseAck = true;
        },
        writes: () => request.request.mock.calls.filter(([input]) => input.method !== 'GET'),
    };
}

describe.each([
    ['lan-dns', dns],
    ['mdns-rule', mdns],
] as const)('%s receipt restoration', (kind, configuration) => {
    it('issues a create receipt, previews without mutation, deletes exactly its row and repeats as a no-op', async () => {
        const f = fixture(kind);
        const created = await f.run('create', configuration);
        expect(created.rollbackReceipt).toBeDefined();
        const receipt = dnsChangeReceiptSchema.parse(created.rollbackReceipt);
        expect(receipt).toMatchObject({ resource: kind, before: null, appliedId: 'new-1' });
        expect(await f.rollback.rollbackDnsChange(receipt)).toMatchObject({ dryRun: true, written: false });
        expect(f.writes()).toHaveLength(1);
        expect(await f.rollback.rollbackDnsChange(receipt, false)).toMatchObject({ written: true, verified: true });
        expect(f.rows()).toEqual([]);
        expect(f.writes()).toHaveLength(2);
        expect(await f.rollback.rollbackDnsChange(receipt, false)).toMatchObject({ written: false, verified: true });
        expect(f.writes()).toHaveLength(2);
        expect(f.writes().every(([, retry]) => retry === false)).toBe(true);
    });
    it('restores a preserving update and refuses drift or same-name replacement', async () => {
        const initial = { ...configuration, id: 'original' },
            f = fixture(kind, [initial]);
        const result = await f.run('modify', { ...configuration, name: 'Changed' });
        const receipt = dnsChangeReceiptSchema.parse(result.rollbackReceipt);
        const applied = f.rows();
        f.set([{ ...applied[0], name: 'Intervening' }]);
        await expect(f.rollback.rollbackDnsChange(receipt, false)).rejects.toThrow('changed or was replaced');
        f.set([{ ...applied[0], id: 'replacement' }]);
        await expect(f.rollback.rollbackDnsChange(receipt, false)).rejects.toThrow('changed or was replaced');
        f.set(applied);
        expect(await f.rollback.rollbackDnsChange(receipt, false)).toMatchObject({ verified: true, written: true });
        expect(sameDnsConfig(f.rows()[0], initial)).toBe(true);
        expect(await f.rollback.rollbackDnsChange(receipt, false)).toMatchObject({ verified: true, written: false });
        expect(f.writes()).toHaveLength(2);
    });
    it('recreates a deletion with a new identity, preserves siblings and refuses conflicting replacements', async () => {
        const initial = { ...configuration, id: 'original' },
            sibling = { ...configuration, id: 'sibling', name: 'Other', ...(kind === 'lan-dns' ? { domain: 'other.invalid' } : {}) };
        const f = fixture(kind, [initial, sibling]);
        const result = await f.run('delete');
        const receipt = dnsChangeReceiptSchema.parse(result.rollbackReceipt);
        f.set([
            { ...initial, id: 'replacement', name: configuration.name, ...(kind === 'lan-dns' ? { domain: 'changed.invalid' } : { status: true }) },
            sibling,
        ]);
        await expect(f.rollback.rollbackDnsChange(receipt, false)).rejects.toThrow('replaced or conflicts');
        f.set([sibling]);
        expect(await f.rollback.rollbackDnsChange(receipt, false)).toMatchObject({ verified: true, written: true });
        expect(f.rows()).toContainEqual(sibling);
        expect(f.rows().find((r) => r.id !== 'sibling')?.id).toBe('new-1');
        expect(await f.rollback.rollbackDnsChange(receipt, false)).toMatchObject({ written: false, verified: true });
    });
    it('does not issue receipts when an acknowledgement is lost or verification cannot establish the outcome', async () => {
        const f = fixture(kind);
        f.lost();
        const result = await f.run('create', configuration);
        expect(result).toMatchObject({ written: 'unknown', verified: true });
        expect(result.rollbackReceipt).toBeUndefined();
        expect(f.writes()).toHaveLength(1);
    });
    it('rechecks the applied snapshot when drift occurs after rollback planning', async () => {
        const f = fixture(kind, [{ ...configuration, id: 'original' }]);
        const updated = await f.run('modify', { ...configuration, name: 'Changed' });
        const receipt = dnsChangeReceiptSchema.parse(updated.rollbackReceipt);
        const original = f.request.request.getMockImplementation()!;
        let reads = 0;
        f.request.request.mockImplementation((...args) => {
            if (args[0].method === 'GET' && ++reads === 2) f.set([{ ...f.rows()[0], name: 'Concurrent edit' }]);
            return original(...args);
        });
        await expect(f.rollback.rollbackDnsChange(receipt, false)).rejects.toThrow(/changed|drift/i);
        expect(f.writes()).toHaveLength(1);
    });
    it('does not issue a receipt when readback cannot verify an acknowledged mutation', async () => {
        const f = fixture(kind);
        const original = f.request.request.getMockImplementation()!;
        f.request.request.mockImplementation((...args) =>
            args[0].method === 'POST' ? { errorCode: 0, result: { id: 'new-1' } } : original(...args)
        );
        const result = await f.run('create', configuration);
        expect(result).toMatchObject({ written: true, verified: false });
        expect(result.rollbackReceipt).toBeUndefined();
        expect(f.writes()).toHaveLength(1);
    });
    it('binds receipts to a controller and requires network read/write authority', async () => {
        const f = fixture(kind);
        const result = await f.run('create', configuration);
        const receipt = dnsChangeReceiptSchema.parse(result.rollbackReceipt);
        await expect(f.rollback.rollbackDnsChange({ ...receipt, controllerId: 'foreign' }, false)).rejects.toThrow('different controller');
        expect(f.writes()).toHaveLength(1);
        const readonly = fixture(kind, f.rows(), new ToolAccessPolicy('full', 'network:r'));
        await expect(readonly.rollback.rollbackDnsChange(receipt, false)).rejects.toThrow('policy');
        expect(readonly.writes()).toHaveLength(0);
        const writeonly = fixture(kind, f.rows(), new ToolAccessPolicy('full', 'network:w'));
        await expect(writeonly.rollback.rollbackDnsChange(receipt, false)).rejects.toThrow('policy');
        expect(writeonly.writes()).toHaveLength(0);
    });
    it('refuses malformed receipts and untrusted fields before controller I/O', async () => {
        const f = fixture(kind);
        const result = await f.run('create', configuration);
        const receipt = dnsChangeReceiptSchema.parse(result.rollbackReceipt);
        f.request.request.mockClear();
        for (const bad of [
            { ...receipt, appliedId: null },
            { ...receipt, before: null, applied: null },
            { ...receipt, applied: { ...receipt.applied, unknown: 'x' } },
            { ...receipt, siteId: '../site' },
        ])
            await expect(f.rollback.rollbackDnsChange(bad as never, false)).rejects.toThrow();
        expect(f.request.request).not.toHaveBeenCalled();
    });
});

describe('LAN DNS rollback eligibility', () => {
    it('does not issue a delete receipt when a future creation contract cannot restore its reported configuration', async () => {
        const document = JSON.parse(JSON.stringify(catalog.document));
        document.components.schemas.LanDnsOpenApiVO.properties.dnsServers.items.maxLength = 3;
        const source = new OperationCatalog(document, 'live');
        const f = fixture(
            'lan-dns',
            [{ enable: false, name: dns.name, domain: dns.domain, type: 2, dnsServers: ['192.0.2.53'], id: 'original' }],
            undefined,
            source
        );
        const result = await f.run('delete');
        expect(result).toMatchObject({ written: true, verified: true });
        expect(result.rollbackReceipt).toBeUndefined();
        expect(result.rollbackUnavailable).toBeDefined();
    });

    it('does not promise to remove an optional field introduced by a PATCH', async () => {
        const f = fixture('lan-dns', [{ ...dns, id: 'original' }]);
        const result = await f.run('modify', { ...dns, customTtl: true, ttl: 60 });
        expect(result).toMatchObject({ written: true, verified: true });
        expect(result.rollbackReceipt).toBeUndefined();
        expect(result.rollbackUnavailable).toContain('field presence');
    });
});

describe('Forward DNS mode-specific configuration', () => {
    const forward = { enable: false, name: 'Forward DNS', domain: 'forward.invalid', type: 2, dnsServers: ['192.0.2.53'] };
    it('verifies omitted LAN selection and restores each CRUD action without inventing empty selections', async () => {
        const f = fixture('lan-dns');
        const created = await f.run('create', forward);
        const createReceipt = dnsChangeReceiptSchema.parse(created.rollbackReceipt);
        expect(createReceipt.applied).not.toHaveProperty('lanNetworkIds');
        const changed = await f.run('modify', { ...forward, name: 'Changed forward' }, 'new-1');
        const updateReceipt = dnsChangeReceiptSchema.parse(changed.rollbackReceipt);
        expect(await f.rollback.rollbackDnsChange(updateReceipt, false)).toMatchObject({ written: true, verified: true });
        const removed = await f.run('delete', undefined, 'new-1');
        const deleteReceipt = dnsChangeReceiptSchema.parse(removed.rollbackReceipt);
        expect(await f.rollback.rollbackDnsChange(deleteReceipt, false)).toMatchObject({ written: true, verified: true });
        expect(f.rows()[0]).not.toHaveProperty('lanNetworkIds');
        expect(await f.rollback.rollbackDnsChange(deleteReceipt, false)).toMatchObject({ written: false, verified: true });
    });
    it.each([[], ['net']])('rejects a requested LAN selection for forwarding before controller requests: %j', async (lanNetworkIds) => {
        const f = fixture('lan-dns');
        await expect(f.run('create', { ...forward, lanNetworkIds })).rejects.toThrow();
        expect(f.request.request).not.toHaveBeenCalled();
    });
    it.each([0, 1])('retains required LAN selection for type %s', async (type) => {
        const f = fixture('lan-dns');
        await expect(
            f.run('create', { ...forward, type, ...(type === 0 ? { ipAddresses: ['192.0.2.1'] } : { cname: 'target.invalid' }) })
        ).rejects.toThrow('LAN selection');
        expect(f.request.request).not.toHaveBeenCalled();
    });
    it.each([0, 1, 2])('refuses changing the existing record kind %s before mutation', async (type) => {
        const current =
            type === 2 ? { ...forward, id: 'original' } : { ...dns, type, ...(type === 1 ? { cname: 'target.invalid' } : {}), id: 'original' };
        const desired = type === 2 ? { ...dns } : { ...forward };
        const f = fixture('lan-dns', [current]);
        await expect(f.run('modify', desired)).rejects.toThrow('record-type changes');
        expect(f.writes()).toHaveLength(0);
    });
});
