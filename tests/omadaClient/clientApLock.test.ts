import { describe, expect, it, vi } from 'vitest';
import { ActionOperations } from '../../src/omadaClient/action.js';

const clientMac = 'AA-BB-CC-DD-EE-FF';
const apMac = 'AA-BB-CC-DD-EE-01';
const enabled = { enable: true, aps: [apMac] };
function setup(
    options: {
        current?: boolean;
        wireless?: boolean;
        blocked?: boolean;
        support?: boolean;
        connected?: boolean;
        drift?: boolean;
        lost?: boolean;
        reject?: boolean;
        apply?: boolean;
        missing?: boolean;
        wrongClient?: boolean;
    } = {}
) {
    let lock = { enable: options.current ?? false, aps: options.current ? [apMac] : [] },
        reads = 0;
    const request = {
        get: vi.fn((url) => {
            if (url.endsWith('/lockToAp/aps'))
                return Promise.resolve({
                    errorCode: 0,
                    result: [{ mac: apMac, supportLockToAp: options.support ?? true, statusCategory: options.connected === false ? 0 : 1 }],
                });
            reads++;
            return Promise.resolve({
                errorCode: 0,
                result: {
                    mac: options.wrongClient ? apMac : clientMac,
                    wireless: options.wireless ?? true,
                    blocked: options.blocked ?? false,
                    ...(options.missing
                        ? {}
                        : {
                              clientLockToApSetting: {
                                  enable: options.drift && reads === 2 ? !lock.enable : lock.enable,
                                  aps: lock.aps.map((mac) => ({ mac, name: 'AP' })),
                              },
                          }),
                },
            });
        }),
        request: vi.fn((config, _retry) => {
            if (options.reject) return Promise.resolve({ errorCode: -41021, msg: 'limit reached' });
            if (options.apply !== false) lock = config.data;
            if (options.lost) return Promise.reject(new Error('lost response'));
            return Promise.resolve({ errorCode: 0, result: {} });
        }),
        ensureSuccess: (response: { errorCode: number; msg?: string; result: unknown }) => {
            if (response.errorCode !== 0) throw Object.assign(new Error(response.msg), { errorCode: response.errorCode });
            return response.result;
        },
    };
    const action = new ActionOperations(
        request as never,
        { resolveSiteId: (id?: string) => id ?? 'site' } as never,
        (path, version = 'v1') => `/openapi/${version}/controller${path}`
    );
    return { request, action };
}

describe('guarded client AP locks', () => {
    it('previews normalized MACs and validates eligible APs without a mutation', async () => {
        const f = setup();
        expect(await f.action.setClientApLock('aa:bb:cc:dd:ee:ff', { enable: true, aps: ['aabbccddee01'] })).toMatchObject({
            dryRun: true,
            written: false,
            desired: enabled,
            before: { enable: false },
        });
        expect(f.request.get).toHaveBeenCalledWith('/openapi/v2/controller/sites/site/lockToAp/aps');
        expect(f.request.request).not.toHaveBeenCalled();
    });
    it('writes the documented payload once and verifies reported configuration', async () => {
        const f = setup();
        expect(await f.action.setClientApLock(clientMac, enabled, 'site/1', false)).toMatchObject({
            written: true,
            verified: true,
            verification: { status: 'verified' },
        });
        expect(f.request.request).toHaveBeenCalledExactlyOnceWith(
            { method: 'POST', url: '/openapi/v1/controller/sites/site%2F1/clients/AA-BB-CC-DD-EE-FF/lock-to-ap', data: enabled },
            false
        );
    });
    it('unlocks without requiring the previously locked AP to be online', async () => {
        const f = setup({ current: true, blocked: true, connected: false });
        expect(await f.action.setClientApLock(clientMac, { enable: false }, undefined, false)).toMatchObject({ written: true, verified: true });
        expect(f.request.get.mock.calls.every(([url]) => !url.endsWith('/lockToAp/aps'))).toBe(true);
        expect(f.request.request.mock.calls[0][0].data).toEqual({ enable: false, aps: [] });
    });
    it('detects no-ops without a write', async () => {
        const f = setup({ current: true });
        expect(await f.action.setClientApLock(clientMac, enabled, undefined, false)).toMatchObject({
            changed: false,
            written: false,
            verified: true,
        });
        expect(f.request.request).not.toHaveBeenCalled();
    });
    it.each([
        { wireless: false },
        { blocked: true },
        { support: false },
        { connected: false },
        { drift: true },
        { missing: true },
        { wrongClient: true },
    ])('rejects unsafe or missing evidence %j', async (options) => {
        const f = setup(options);
        await expect(f.action.setClientApLock(clientMac, enabled, undefined, false)).rejects.toThrow();
        expect(f.request.request).not.toHaveBeenCalled();
    });
    it('rejects invalid settings before reading the controller', async () => {
        const f = setup();
        for (const settings of [
            { enable: true },
            { enable: true, aps: ['bad'] },
            { enable: true, aps: [apMac, 'aa:bb:cc:dd:ee:01'] },
            { enable: false, aps: [apMac] },
        ])
            await expect(f.action.setClientApLock(clientMac, settings)).rejects.toThrow();
        expect(f.request.get).not.toHaveBeenCalled();
    });
    it('retains lost-acknowledgement uncertainty without replay', async () => {
        const f = setup({ lost: true });
        expect(await f.action.setClientApLock(clientMac, enabled, undefined, false)).toMatchObject({ written: 'unknown', verified: true });
        expect(f.request.request).toHaveBeenCalledOnce();
    });
    it('reports mismatch and propagates definitive controller rejection', async () => {
        expect(await setup({ apply: false }).action.setClientApLock(clientMac, enabled, undefined, false)).toMatchObject({
            verified: false,
            verification: { status: 'mismatch' },
        });
        const f = setup({ reject: true });
        await expect(f.action.setClientApLock(clientMac, enabled, undefined, false)).rejects.toMatchObject({ errorCode: -41021 });
        expect(f.request.request).toHaveBeenCalledOnce();
    });
});
