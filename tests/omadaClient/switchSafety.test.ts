import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkOperations } from '../../src/omadaClient/network.js';
import type { RequestHandler } from '../../src/omadaClient/request.js';
import type { SiteOperations } from '../../src/omadaClient/site.js';
import { SwitchOperations } from '../../src/omadaClient/switch.js';

const MAC = 'AA-BB-CC-DD-EE-FF';
const initial = () =>
    [1, 2, 3].map((port) => ({
        port,
        name: `Port ${port}`,
        status: 1,
        lagPort: false,
        profileId: 'profile-old',
        profileOverrideEnable: true,
        poeMode: 0,
    }));

function setup() {
    const state = initial();
    const telemetry: Record<string, unknown>[] = state.map(({ port }) => ({
        switchMac: MAC,
        port,
        supportPoe: true,
        configStack: false,
        configMlagPeerLink: false,
        configMlagDad: false,
    }));
    const get = vi.fn(async () => ({ errorCode: 0, result: { mac: MAC, portList: structuredClone(state) } }));
    const request = vi.fn(async () => ({ errorCode: 0, result: {} }));
    const fetchPaginated = vi.fn(async () => structuredClone(telemetry));
    const api = new SwitchOperations(
        { get, request, fetchPaginated, ensureSuccess: (response: { result: unknown }) => response.result } as unknown as RequestHandler,
        { resolveSiteId: (siteId?: string) => siteId ?? 'site-1' } as SiteOperations,
        (path) => `/openapi/v1/controller${path}`
    );
    return { api, state, telemetry, get, request, fetchPaginated };
}

describe('switch port safety', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());
    const finish = async <T>(operation: Promise<T>): Promise<T> => {
        const result = operation.then(
            (value) => ({ value }),
            (error: unknown) => ({ error })
        );
        await vi.runAllTimersAsync();
        const settled = await result;
        if ('error' in settled) throw settled.error;
        return settled.value;
    };

    it.each([[1, 1], [1, 99], [], Array.from({ length: 33 }, (_, i) => i + 1), [0], [1.5]])(
        'invalid batch %j cannot write any ports',
        async (ports) => {
            const { api, request } = setup();
            await expect(api.batchSetSwitchPortStatus(MAC, ports, 0)).rejects.toThrow();
            expect(request).not.toHaveBeenCalled();
        }
    );

    it('previews every target with explicit unknown topology and no mutation', async () => {
        const { api, request } = setup();
        const result = await api.batchSetSwitchPortName(
            MAC,
            [
                { port: 1, name: 'A' },
                { port: 2, name: 'B' },
            ],
            undefined,
            { dryRun: true }
        );
        expect(result).toMatchObject({
            dryRun: true,
            written: false,
            canApply: true,
            ports: [{ port: 1, risk: { uplink: 'unknown' } }, { port: 2 }],
        });
        expect(result.ports[0].changes).toEqual([{ field: 'name', before: 'Port 1', after: 'A' }]);
        expect(request).not.toHaveBeenCalled();
    });

    it('skips a no-op using configured administrative status, regardless of link state', async () => {
        const { api, state, request } = setup();
        Object.assign(state[0], { portStatus: { linkStatus: 0 } });
        const result = await api.setSwitchPortStatus(MAC, 1, 1);
        expect(result).toMatchObject({ written: false, ports: [{ verification: { status: 'verified', attempts: 0 } }] });
        expect(request).not.toHaveBeenCalled();
    });

    it('does not infer administrative state from telemetry when config status is missing', async () => {
        const { api, state, request } = setup();
        Reflect.deleteProperty(state[0], 'status');
        Object.assign(state[0], { portStatus: { linkStatus: 1 } });
        const result = await finish(api.setSwitchPortStatus(MAC, 1, 1));
        expect(request).toHaveBeenCalledTimes(1);
        expect(result.ports[0].verification.status).toBe('unknown');
    });

    it('requires caller intent for observed LAG disruption but allows harmless renaming', async () => {
        const { api, state, request } = setup();
        state[0].lagPort = true;
        const preview = await api.setSwitchPortProfile(MAC, 1, 'profile-new', undefined, { dryRun: true });
        expect(preview.canApply).toBe(false);
        await expect(api.setSwitchPortProfile(MAC, 1, 'profile-new')).rejects.toThrow('allowDisruption');
        expect(request).not.toHaveBeenCalled();
        request.mockImplementationOnce(() => {
            state[0].name = 'New';
            return Promise.resolve({ errorCode: 0, result: {} });
        });
        expect((await api.setSwitchPortName(MAC, 1, 'New')).ports[0].verification.status).toBe('verified');
    });

    it('uses explicit stack and MLAG metadata, never names or operation labels', async () => {
        const { api, state, telemetry, request } = setup();
        state[0].name = 'Core uplink';
        telemetry[0].operation = 'AGGREGATING';
        expect((await api.setSwitchPortProfile(MAC, 1, 'new', undefined, { dryRun: true })).canApply).toBe(true);
        telemetry[0].configStack = true;
        await expect(api.setSwitchPortProfile(MAC, 1, 'new')).rejects.toThrow('allowDisruption');
        telemetry[0].configStack = false;
        telemetry[0].configMlagPeerLink = true;
        await expect(api.setSwitchPortProfile(MAC, 1, 'new')).rejects.toThrow('allowDisruption');
        expect(request).not.toHaveBeenCalled();
    });

    it('supports an explicit disruption intent without replaying or toggling other settings', async () => {
        const { api, state, request } = setup();
        state[0].lagPort = true;
        request.mockImplementationOnce(() => {
            state[0].profileId = 'new';
            return Promise.resolve({ errorCode: 0, result: {} });
        });
        const result = await api.setSwitchPortProfile(MAC, 1, 'new', undefined, { allowDisruption: true });
        expect(result.ports[0].verification.status).toBe('verified');
        expect(request).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ data: { profileId: 'new' } }), false);
    });

    it('reports refreshed topology flags when caller intent permits a newly observed risk', async () => {
        const { api, state, telemetry, fetchPaginated, request } = setup();
        fetchPaginated.mockResolvedValueOnce(structuredClone(telemetry));
        telemetry[0].configStack = true;
        request.mockImplementationOnce(() => {
            state[0].profileId = 'new';
            return Promise.resolve({ errorCode: 0, result: {} });
        });
        const result = await api.setSwitchPortProfile(MAC, 1, 'new', undefined, { allowDisruption: true });
        expect(result.ports[0].risk.stack).toBe(true);
    });

    it.each([false, undefined])('PoE support=%s blocks the whole batch even when poeMode looks enabled', async (support) => {
        const { api, state, telemetry, request } = setup();
        state[1].poeMode = 1;
        telemetry[1].supportPoe = support;
        await expect(api.batchSetSwitchPortPoe(MAC, [1, 2], 1)).rejects.toThrow('PoE');
        expect(request).not.toHaveBeenCalled();
    });

    it('does not treat telemetry omission as proof of missing ports or PoE support', async () => {
        const { api, telemetry, request } = setup();
        telemetry.length = 0;
        expect((await api.setSwitchPortName(MAC, 1, 'New', undefined, { dryRun: true })).canApply).toBe(true);
        await expect(api.setSwitchPortPoe(MAC, 1, 1)).rejects.toThrow('could not be established');
        expect(request).not.toHaveBeenCalled();
    });

    it('requires an already verified profile override and never enables it automatically', async () => {
        const { api, state, request } = setup();
        state[0].profileOverrideEnable = false;
        await expect(api.setSwitchPortPoe(MAC, 1, 1)).rejects.toThrow('profileOverrideEnable=true');
        expect(request).not.toHaveBeenCalled();
    });

    it.each([false, undefined])('a matching PoE mode with support=%s cannot claim verified support', async (support) => {
        const { api, state, telemetry, request } = setup();
        state[0].poeMode = 1;
        telemetry[0].supportPoe = support;
        const preview = await api.setSwitchPortPoe(MAC, 1, 1, undefined, { dryRun: true });
        expect(preview).toMatchObject({ canApply: false, written: false, ports: [{ verification: { status: 'not-run' } }] });
        await expect(api.setSwitchPortPoe(MAC, 1, 1)).rejects.toThrow('PoE');
        expect(request).not.toHaveBeenCalled();
    });

    it('requires override for PoE intent even when the stored mode already matches', async () => {
        const { api, state, request } = setup();
        state[0].poeMode = 1;
        state[0].profileOverrideEnable = false;
        const preview = await api.setSwitchPortPoe(MAC, 1, 1, undefined, { dryRun: true });
        expect(preview).toMatchObject({ canApply: false, ports: [{ verification: { status: 'not-run' } }] });
        await expect(api.setSwitchPortPoe(MAC, 1, 1)).rejects.toThrow('profileOverrideEnable=true');
        expect(request).not.toHaveBeenCalled();
    });

    it('refuses detected drift before the single batch mutation', async () => {
        const { api, get, state, request } = setup();
        get.mockResolvedValueOnce({ errorCode: 0, result: { mac: MAC, portList: structuredClone(state) } });
        state[1].profileId = 'changed-externally';
        await expect(
            api.batchSetSwitchPortName(MAC, [
                { port: 1, name: 'A' },
                { port: 2, name: 'B' },
            ])
        ).rejects.toThrow('changed during preflight');
        expect(request).not.toHaveBeenCalled();
    });

    it('returns per-port partial application evidence after one batch acknowledgement', async () => {
        const { api, state, request } = setup();
        request.mockImplementationOnce(() => {
            state[0].name = 'A';
            return Promise.resolve({ errorCode: 0, result: {} });
        });
        const result = await finish(
            api.batchSetSwitchPortName(MAC, [
                { port: 1, name: 'A' },
                { port: 2, name: 'B' },
            ])
        );
        expect(result).toMatchObject({ written: true, ports: [{ verification: { status: 'verified' } }, { verification: { status: 'mismatch' } }] });
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('reconciles a lost acknowledgement without replaying the batch', async () => {
        const { api, state, request } = setup();
        request.mockImplementationOnce(() => {
            state[0].name = 'A';
            return Promise.reject(new Error('lost response'));
        });
        const result = await api.batchSetSwitchPortName(MAC, [{ port: 1, name: 'A' }]);
        expect(result).toMatchObject({ written: 'unknown', acknowledged: false, ports: [{ verification: { status: 'verified' } }] });
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('reports unavailable verification after mutation without claiming success', async () => {
        const { api, get, state, request } = setup();
        const response = { errorCode: 0, result: { mac: MAC, portList: structuredClone(state) } };
        get.mockResolvedValueOnce(response).mockResolvedValueOnce(response).mockRejectedValue(new Error('read failed'));
        const result = await finish(api.setSwitchPortName(MAC, 1, 'A'));
        expect(result.ports[0].verification.status).toBe('unknown');
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('counts failed reads in per-port verification attempts', async () => {
        const { api, get, state, request } = setup();
        const response = { errorCode: 0, result: { mac: MAC, portList: structuredClone(state) } };
        get.mockResolvedValueOnce(response).mockResolvedValueOnce(response).mockRejectedValueOnce(new Error('temporary read failure'));
        request.mockImplementationOnce(() => {
            state[0].name = 'A';
            return Promise.resolve({ errorCode: 0, result: {} });
        });
        const result = await finish(api.setSwitchPortName(MAC, 1, 'A'));
        expect(result.ports[0].verification).toMatchObject({ status: 'verified', attempts: 2 });
    });

    it('detects collateral settings changes while verifying a narrow write', async () => {
        const { api, state, request } = setup();
        request.mockImplementationOnce(() => {
            state[0].name = 'A';
            state[0].status = 0;
            return Promise.resolve({ errorCode: 0, result: {} });
        });
        const result = await finish(api.setSwitchPortName(MAC, 1, 'A'));
        expect(result.ports[0].verification).toMatchObject({ status: 'mismatch', unexpectedChanges: ['status'] });
    });

    it('uses normalized MAC and port identities and rejects duplicate readback identities', async () => {
        const { api, state } = setup();
        Object.assign(state[0], { port: '1' });
        expect((await api.setSwitchPortName('aa:bb:cc:dd:ee:ff', 1, 'A', undefined, { dryRun: true })).ports[0].port).toBe(1);
        Object.assign(state[1], { port: '1' });
        await expect(api.setSwitchPortName(MAC, 1, 'A')).rejects.toThrow('duplicate port');
    });

    it('rejects unsupported generic fields or combined updates before reading or writing', async () => {
        const { api, get, request } = setup();
        await expect(api.updateSwitchPort(MAC, '1', { linkSpeed: 1000 })).rejects.toThrow('no verified Open API contract');
        await expect(api.updateSwitchPort(MAC, '1', { profileId: 'new', poe: true })).rejects.toThrow('one profileId or poe');
        expect(get).not.toHaveBeenCalled();
        expect(request).not.toHaveBeenCalled();
    });

    it('keeps the legacy network entry point from sending an undocumented generic PATCH', async () => {
        const request = vi.fn();
        const network = new NetworkOperations(
            { request } as unknown as RequestHandler,
            { resolveSiteId: () => 'site' } as SiteOperations,
            (path) => path
        );
        await expect(network.updateSwitchPort(MAC, '1', { linkSpeed: 1000 })).rejects.toThrow('not a verified Open API operation');
        expect(request).not.toHaveBeenCalled();
    });

    it('delegates a supported generic setting to its narrow guarded endpoint', async () => {
        const { api, state, request } = setup();
        request.mockImplementationOnce(() => {
            state[0].profileId = 'new';
            return Promise.resolve({ errorCode: 0, result: {} });
        });
        expect((await api.updateSwitchPort(MAC, '1', { profileId: 'new' })).ports[0].verification.status).toBe('verified');
        expect(request).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ method: 'PUT', url: expect.stringContaining('/ports/1/profile'), data: { profileId: 'new' } }),
            false
        );
    });
});
