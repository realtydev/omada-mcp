import { AxiosError } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type NetworkChangeReceipt, type RateLimitProfileConfig, RateLimitProfileOperations } from '../../src/omadaClient/rateLimitProfile.js';
import type { RequestHandler } from '../../src/omadaClient/request.js';
import type { SiteOperations } from '../../src/omadaClient/site.js';

const before: RateLimitProfileConfig = { name: 'Client limits', upLimitEnable: true, upLimit: 1024, downLimitEnable: false, downLimit: 2048 };
const profile = (changes: Record<string, unknown> = {}) => ({
    id: 'profile-1',
    ...before,
    site: 'site-1',
    resource: 0,
    isDefault: false,
    ...changes,
});
const receipt = (changes: Partial<NetworkChangeReceipt> = {}): NetworkChangeReceipt => ({
    version: 1,
    resource: 'rate-limit-profile',
    controllerId: 'controller',
    siteId: 'site-1',
    profileId: 'profile-1',
    before: { ...before },
    applied: { ...before, name: 'Changed' },
    ...changes,
});

describe('verified rate-limit profile updates and rollback', () => {
    let rows: unknown[];
    let request: { get: ReturnType<typeof vi.fn>; request: ReturnType<typeof vi.fn>; ensureSuccess: ReturnType<typeof vi.fn> };
    let operations: RateLimitProfileOperations;
    beforeEach(() => {
        vi.useFakeTimers();
        rows = [profile()];
        request = {
            get: vi.fn(() => Promise.resolve({ errorCode: 0, result: rows })),
            request: vi.fn(({ data }) => {
                rows = [profile(data)];
                return Promise.resolve({ errorCode: 0 });
            }),
            ensureSuccess: vi.fn((response) => {
                if (response.errorCode !== 0) throw new Error(`Omada errorCode: ${response.errorCode} - ${response.msg}`);
                return response.result;
            }),
        };
        const site = { resolveSiteId: (id?: string) => id ?? 'site-1' } as SiteOperations;
        operations = new RateLimitProfileOperations(
            request as unknown as RequestHandler,
            site,
            (path) => `/openapi/v1/controller${path}`,
            'controller'
        );
    });
    afterEach(() => vi.useRealTimers());

    it('defaults to preview and preserves every unchanged writable field', async () => {
        const result = await operations.updateRateLimitProfile('profile-1', { name: 'Changed' });
        expect(result).toMatchObject({ dryRun: true, written: false, verified: false, before, requestBody: { ...before, name: 'Changed' } });
        expect(result.changes).toEqual([{ field: 'name', before: before.name, after: 'Changed' }]);
        expect(result.rollbackReceipt).toBeUndefined();
        expect(request.request).not.toHaveBeenCalled();
        expect(request.get).toHaveBeenCalledWith('/openapi/v1/controller/sites/site-1/rate-limit-profiles');
    });

    it('writes the documented PUT body once and issues a scoped rollback receipt only after verification', async () => {
        const result = await operations.updateRateLimitProfile('profile-1', { name: 'Changed' }, 'site-1', false);
        expect(request.request).toHaveBeenCalledExactlyOnceWith(
            {
                method: 'PUT',
                url: '/openapi/v1/controller/sites/site-1/rate-limit-profile/profile-1',
                data: { ...before, name: 'Changed' },
            },
            false
        );
        expect(result).toMatchObject({
            written: true,
            verified: true,
            verification: { status: 'verified', attempts: 1 },
            rollbackReceipt: receipt(),
        });
        expect(result.requestBody).not.toHaveProperty('resource');
        expect(result.requestBody).not.toHaveProperty('isDefault');
    });

    it('updates and rolls back the live 6.3 profileId shape with omitted disabled limits', async () => {
        const disabled = { name: 'Live profile', upLimitEnable: false, downLimitEnable: false };
        const live = { profileId: 'profile-1', ...disabled, defaultProfile: false, resource: 0 };
        rows = [live];
        request.request.mockImplementation(({ data }) => {
            rows = [{ ...live, ...data }];
            return Promise.resolve({ errorCode: 0 });
        });
        const result = await operations.updateRateLimitProfile('profile-1', { name: 'Changed' }, undefined, false);
        expect(result).toMatchObject({ verified: true, before: disabled, requestBody: { ...disabled, name: 'Changed' } });
        expect(result.requestBody).not.toHaveProperty('upLimit');
        expect(result.requestBody).not.toHaveProperty('downLimit');
        expect(result.requestBody).not.toHaveProperty('defaultProfile');
        expect(result.rollbackReceipt).toMatchObject({ profileId: 'profile-1', before: disabled });
        const rollback = await operations.rollbackNetworkChange(result.rollbackReceipt!, false);
        expect(rollback).toMatchObject({ verified: true, after: disabled });
        expect(request.request).toHaveBeenCalledTimes(2);
    });

    it('accepts matching old and new identifier fields without changing the selected identity', async () => {
        rows = [profile({ profileId: 'profile-1' })];
        expect(await operations.updateRateLimitProfile('profile-1', { name: 'Changed' })).toMatchObject({ dryRun: true, profileId: 'profile-1' });
    });

    it.each(
        [
            [profile({ profileId: 'other-profile' })],
            [{ profileId: 'profile-1', ...before }, profile()],
            [{ profileId: 'profile-1', id: null, ...before }],
            [{ profileId: '', id: 'profile-1', ...before }],
        ].map((result) => ({ result }))
    )('refuses conflicting, malformed or duplicated canonical profile IDs: %j', async ({ result }) => {
        rows = result;
        await expect(operations.updateRateLimitProfile('profile-1', { name: 'Changed' }, undefined, false)).rejects.toThrow(/profile ID/);
        expect(request.request).not.toHaveBeenCalled();
    });

    it('makes unchanged updates a verified no-op even when execution is explicit', async () => {
        const result = await operations.updateRateLimitProfile('profile-1', { name: before.name }, undefined, false);
        expect(result).toMatchObject({ written: false, verified: true, changes: [], verification: { attempts: 0 } });
        expect(request.request).not.toHaveBeenCalled();
    });

    it('retains disabled zero limits and can enable a direction with a valid limit', async () => {
        rows = [profile({ upLimitEnable: false, upLimit: 0, downLimit: 0 })];
        const result = await operations.updateRateLimitProfile('profile-1', { upLimitEnable: true, upLimit: 4096 });
        expect(result.requestBody).toEqual({ name: before.name, upLimitEnable: true, upLimit: 4096, downLimitEnable: false, downLimit: 0 });
    });

    it.each([
        {},
        { unknown: true },
        { name: '' },
        { name: ' leading' },
        { name: 'trailing ' },
        { name: 'x'.repeat(65) },
        { upLimit: -1 },
        { downLimit: 1.5 },
        { upLimit: 10485761 },
        { downLimitEnable: 'yes' },
    ])('rejects invalid updates before any I/O: %j', async (settings) => {
        await expect(operations.updateRateLimitProfile('profile-1', settings as never)).rejects.toThrow();
        expect(request.get).not.toHaveBeenCalled();
        expect(request.request).not.toHaveBeenCalled();
    });

    it('rejects enabling an unset or zero direction without supplying a positive limit', async () => {
        rows = [profile({ downLimit: 0 })];
        await expect(operations.updateRateLimitProfile('profile-1', { downLimitEnable: true })).rejects.toThrow('requires');
        expect(request.request).not.toHaveBeenCalled();
    });

    it.each(['../profile', '%2e%2e', 'profile/name', 'profile?x', '.', '..', 'space id'])(
        'rejects unsafe profile identifiers before I/O: %s',
        async (id) => {
            await expect(operations.updateRateLimitProfile(id, { name: 'Changed' })).rejects.toThrow();
            expect(request.get).not.toHaveBeenCalled();
        }
    );

    it.each(
        [
            undefined,
            {},
            { data: [] },
            [null],
            [{}],
            [profile(), profile({ name: 'Duplicate' })],
            [profile({ name: undefined })],
            [profile({ upLimitEnable: undefined })],
        ].map((result) => ({ result }))
    )('rejects incomplete or duplicated evidence: %j', async ({ result }) => {
        request.get.mockResolvedValue({ errorCode: 0, result });
        await expect(operations.updateRateLimitProfile('profile-1', { name: 'Changed' })).rejects.toThrow('evidence is incomplete');
        expect(request.request).not.toHaveBeenCalled();
    });

    it('does not create a missing profile', async () => {
        rows = [];
        await expect(operations.updateRateLimitProfile('profile-1', { name: 'Changed' })).rejects.toThrow('does not exist');
        expect(request.request).not.toHaveBeenCalled();
    });

    it('preserves definite HTTP and controller errors without replaying', async () => {
        request.request.mockRejectedValue(new Error('PUT (HTTP 403) (errorCode: -1003) - denied'));
        await expect(operations.updateRateLimitProfile('profile-1', { name: 'Changed' }, undefined, false)).rejects.toThrow('HTTP 403');
        expect(request.get).toHaveBeenCalledTimes(1);
        expect(request.request).toHaveBeenCalledTimes(1);
        request.request.mockResolvedValue({ errorCode: -33733, msg: 'Already exists' });
        await expect(operations.updateRateLimitProfile('profile-1', { name: 'Changed' }, undefined, false)).rejects.toThrow('-33733');
        expect(request.request).toHaveBeenCalledTimes(2);
    });

    it('reconciles a lost response that applied without replaying the mutation', async () => {
        request.request.mockImplementation(({ data }) => {
            rows = [profile(data)];
            return Promise.reject(new AxiosError('timeout', 'ECONNABORTED'));
        });
        const result = await operations.updateRateLimitProfile('profile-1', { name: 'Changed' }, undefined, false);
        expect(result).toMatchObject({ written: true, verified: true, writeError: 'timeout', rollbackReceipt: receipt() });
        expect(request.request).toHaveBeenCalledTimes(1);
    });

    it('reports an unconfirmed lost write as unknown and never issues a rollback receipt', async () => {
        request.request.mockRejectedValue(new AxiosError('timeout', 'ECONNABORTED'));
        const promise = operations.updateRateLimitProfile('profile-1', { name: 'Changed' }, undefined, false);
        await vi.runAllTimersAsync();
        const result = await promise;
        expect(result).toMatchObject({ written: 'unknown', verified: false, verification: { status: 'mismatch', attempts: 3 } });
        expect(result.rollbackReceipt).toBeUndefined();
        expect(result.warning).toContain('Inspect current profile settings');
        expect(request.request).toHaveBeenCalledTimes(1);
    });

    it('reports readback mismatch and unknown states explicitly without replaying', async () => {
        request.request.mockResolvedValue({ errorCode: 0 });
        const mismatch = operations.updateRateLimitProfile('profile-1', { name: 'Changed' }, undefined, false);
        await vi.runAllTimersAsync();
        expect(await mismatch).toMatchObject({ verified: false, verification: { status: 'mismatch', attempts: 3 } });
        request.get.mockRejectedValueOnce(new Error('read unavailable'));
        // Restore the preflight read, then make every post-write read unavailable.
        request.get
            .mockReset()
            .mockResolvedValueOnce({ errorCode: 0, result: [profile()] })
            .mockRejectedValue(new Error('read unavailable'));
        const unknown = operations.updateRateLimitProfile('profile-1', { name: 'Changed' }, undefined, false);
        await vi.runAllTimersAsync();
        expect(await unknown).toMatchObject({ verified: false, verification: { status: 'unknown' } });
        expect(request.request).toHaveBeenCalledTimes(2);
    });

    it('previews rollback after verifying current applied state', async () => {
        rows = [profile({ name: 'Changed' })];
        const result = await operations.rollbackNetworkChange(receipt());
        expect(result).toMatchObject({ operation: 'rollback', dryRun: true, written: false, requestBody: before });
        expect(request.request).not.toHaveBeenCalled();
    });

    it('rolls back once, verifies restoration and returns an inverse receipt', async () => {
        rows = [profile({ name: 'Changed' })];
        const result = await operations.rollbackNetworkChange(receipt(), false);
        expect(result).toMatchObject({
            written: true,
            verified: true,
            after: before,
            rollbackReceipt: receipt({ before: receipt().applied, applied: before }),
        });
        expect(request.request).toHaveBeenCalledTimes(1);
        const second = await operations.rollbackNetworkChange(receipt(), false);
        expect(second).toMatchObject({ written: false, verified: true, changes: [] });
        expect(request.request).toHaveBeenCalledTimes(1);
    });

    it('refuses rollback when settings drift, including a direction not changed by the original operation', async () => {
        rows = [profile({ name: 'Changed', downLimit: 8192 })];
        await expect(operations.rollbackNetworkChange(receipt(), false)).rejects.toThrow('changed after');
        expect(request.request).not.toHaveBeenCalled();
    });

    it('rejects foreign or malformed receipts before network access', async () => {
        for (const value of [
            receipt({ controllerId: 'different' }),
            { ...receipt(), version: 2 },
            { ...receipt(), extra: true },
            { ...receipt(), resource: 'firewall' },
            receipt({ applied: { ...before, upLimit: 0 } }),
            receipt({ siteId: '../site' }),
        ]) {
            await expect(operations.rollbackNetworkChange(value as never, false)).rejects.toThrow();
        }
        expect(request.get).not.toHaveBeenCalled();
        expect(request.request).not.toHaveBeenCalled();
    });

    it('does not emit receipts when a rollback is not verified', async () => {
        rows = [profile({ name: 'Changed' })];
        request.request.mockResolvedValue({ errorCode: 0 });
        const promise = operations.rollbackNetworkChange(receipt(), false);
        await vi.runAllTimersAsync();
        const result = await promise;
        expect(result).toMatchObject({ written: true, verified: false, verification: { status: 'mismatch' } });
        expect(result.rollbackReceipt).toBeUndefined();
        expect(result.warning).toContain('Inspect current profile settings');
        expect(request.request).toHaveBeenCalledTimes(1);
    });
});
