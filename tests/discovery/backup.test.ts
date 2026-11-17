import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { OperationCatalog } from '../../src/discovery/catalog.js';
import { executeDiscoveredOperation } from '../../src/discovery/execute.js';
import { categoryForPath, ToolAccessPolicy } from '../../src/server/toolPolicy.js';

const catalog = new OperationCatalog(JSON.parse(readFileSync(new URL('../../docs/openapi/00-all.json', import.meta.url), 'utf8')), 'bundled');
function setup(options: { lost?: boolean; artifact?: boolean; running?: boolean; reject?: boolean; bare?: boolean; readError?: boolean } = {}) {
    let submitted = false;
    const request = {
        request: vi.fn((config) => {
            if (config.method !== 'GET') {
                if (options.reject) return { errorCode: -30309, msg: 'backup failed' };
                submitted = true;
                if (options.lost) throw new Error('lost acknowledgement');
                return { errorCode: 0, result: {} };
            }
            const result = config.url.endsWith('/result')
                ? { status: options.running ? 1 : 0 }
                : { fileList: submitted && options.artifact !== false ? [{ fileName: 'new.cfg', backupTime: 1000, size: 200 }] : [] };
            if (options.readError) return { errorCode: -1, msg: 'read denied', ...result };
            return options.bare ? result : { errorCode: 0, result };
        }),
        ensureSuccess: vi.fn((response) => {
            if (response.errorCode !== 0) throw new Error(response.msg);
            return response.result;
        }),
    };
    const run = (
        operationId = 'backupSelfServer',
        body: unknown = { retainUser: false },
        dryRun = false,
        policy = new ToolAccessPolicy('full', 'maintenance:rw')
    ) =>
        executeDiscoveredOperation(
            catalog,
            request as never,
            { operationId, body, dryRun },
            { omadacId: 'controller', siteId: 'site', readOnly: false, accessPolicy: policy }
        );
    return { request, run, writes: () => request.request.mock.calls.filter(([config]) => config.method !== 'GET') };
}
describe('bounded backup workflows and separate recovery authority', () => {
    it('previews without I/O and verifies a newly observed controller backup', async () => {
        const f = setup();
        expect(await f.run('backupSelfServer', { retainUser: false }, true)).toMatchObject({ dryRun: true, written: false });
        expect(f.request.request).not.toHaveBeenCalled();
        expect(await f.run()).toMatchObject({ written: true, verified: true, result: { backups: [{ newFiles: [{ fileName: 'new.cfg' }] }] } });
        expect(f.writes()).toHaveLength(1);
        expect(f.writes()[0][1]).toBe(false);
    });
    it('handles multi-site completion separately for each requested site', async () => {
        const f = setup();
        const result = await f.run('backupSitesSelfServer', { siteIds: ['one', 'two'] });
        expect(result).toMatchObject({ verified: true, result: { backups: [{ siteId: 'one' }, { siteId: 'two' }] } });
        expect(f.writes()).toHaveLength(1);
    });
    it.each(['backupSelfServer', 'backupSitesSelfServer'])('accepts documented bare backup reads for %s', async (operationId) => {
        const f = setup({ bare: true });
        expect(await f.run(operationId, operationId === 'backupSelfServer' ? { retainUser: false } : { siteIds: ['one'] })).toMatchObject({
            verified: true,
        });
    });
    it('does not reinterpret error envelopes or malformed bare backup responses as success', async () => {
        const f = setup({ bare: true, readError: true });
        await expect(f.run()).rejects.toThrow('read denied');
        expect(f.writes()).toHaveLength(0);
        const malformed = setup({ bare: true });
        malformed.request.request.mockReturnValueOnce({ status: '0' } as never);
        await expect(malformed.run()).rejects.toThrow();
        expect(malformed.writes()).toHaveLength(0);
    });
    it('does not confuse idle status with success or replay a lost backup response', async () => {
        expect(await setup({ artifact: false }).run()).toMatchObject({ verified: false, verification: { status: 'unknown' } });
        const lost = setup({ lost: true });
        expect(await lost.run()).toMatchObject({ written: 'unknown', verified: true });
        expect(lost.writes()).toHaveLength(1);
    });
    it('refuses concurrent jobs, unavailable read permissions, invalid targets and definitive errors', async () => {
        const active = setup({ running: true });
        await expect(active.run()).rejects.toThrow('already running');
        expect(active.writes()).toHaveLength(0);
        const denied = setup();
        await expect(denied.run('backupSelfServer', { retainUser: false }, false, new ToolAccessPolicy('full', 'maintenance:w'))).rejects.toThrow(
            'not permitted'
        );
        await expect(denied.run('backupSitesSelfServer', { siteIds: [] })).rejects.toThrow();
        expect(denied.writes()).toHaveLength(0);
        await expect(setup({ reject: true }).run()).rejects.toThrow('backup failed');
    });
    it('requires explicit recovery even in full and all:rw policies and intersects restrictions', () => {
        const path = '/openapi/v1/{omadacId}/maintenance/restore/self-server';
        expect(categoryForPath(path)).toBe('recovery');
        expect(categoryForPath('/openapi/v1/{omadacId}/sites/maintenance/multi-restore/self-server')).toBe('recovery');
        for (const p of [new ToolAccessPolicy(), new ToolAccessPolicy('full', 'all:rw'), new ToolAccessPolicy('full', 'maintenance:rw')]) {
            expect(p.allowsOperation('POST', path)).toBe(false);
            expect(() => p.assertGeneric('POST', '/maintenance/restore/self-server', 'v1')).toThrow();
        }
        const recovery = new ToolAccessPolicy('full', 'recovery:rw');
        expect(recovery.intersect(new ToolAccessPolicy()).allowsOperation('POST', path)).toBe(true);
        expect(recovery.intersect(new ToolAccessPolicy('read-only')).allowsOperation('POST', path)).toBe(false);
        expect(recovery.intersect(new ToolAccessPolicy('full', 'maintenance:rw')).allowsOperation('POST', path)).toBe(false);
    });
});
