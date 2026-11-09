import { isDeepStrictEqual } from 'node:util';
import { AxiosError } from 'axios';
import { describe, expect, it, vi } from 'vitest';

import { ApRadioOperations } from '../../src/omadaClient/apRadio.js';
import { DhcpReservationOperations } from '../../src/omadaClient/dhcpReservation.js';
import { NetworkOperations } from '../../src/omadaClient/network.js';
import {
    apRadioChangeReceiptSchema,
    NetworkChangeOperations,
    networkChangeReceiptSchema,
    ssidChangeReceiptSchema,
} from '../../src/omadaClient/networkChange.js';
import type { RequestHandler } from '../../src/omadaClient/request.js';
import type { SiteOperations } from '../../src/omadaClient/site.js';

const mac = 'AA-BB-CC-DD-EE-FF';
const site = { resolveSiteId: (id?: string) => id ?? 'site' } as SiteOperations;
const path = (p: string) => `/openapi/v1/controller${p}`;
const copy = <T>(value: T): T => structuredClone(value);
const config = { mac, netId: 'lan', status: false, ip: '192.0.2.5', description: 'before', options: [] };
function dhcp(initial: Record<string, unknown> | undefined = { ...config, id: 'original' }) {
    let state = copy(initial);
    const request = {
        fetchPaginated: vi.fn(async () => (state ? [copy(state)] : [])),
        request: vi.fn((input: { method: string; data?: Record<string, unknown> }, _retry?: boolean) => {
            if (input.method === 'DELETE') state = undefined;
            else if (input.method === 'POST') state = { ...copy(input.data), id: 'new-id' };
            else state = { ...state, ...copy(input.data) };
            return Promise.resolve({ errorCode: 0 });
        }),
        ensureSuccess: (value: { result?: unknown; errorCode: number }) => {
            if (value.errorCode !== 0) throw new Error('controller rejection');
            return value.result;
        },
    };
    const fresh = (controller = 'controller') => new DhcpReservationOperations(request as unknown as RequestHandler, site, path, controller);
    return {
        ops: fresh(),
        fresh,
        request,
        get: () => copy(state),
        set: (value: typeof state) => {
            state = copy(value);
        },
    };
}
const ssid = {
    name: 'open-test',
    band: 3,
    broadcast: true,
    enable11r: false,
    guestNetEnable: false,
    mloEnable: false,
    pmfMode: 2,
    security: 0 as const,
    vlanEnable: false,
};
function wireless(initial: Record<string, unknown> = { ...ssid }) {
    let state = copy(initial);
    const request = {
        get: vi.fn(async () => ({ errorCode: 0, result: copy(state) })),
        request: vi.fn((input: { data: Record<string, unknown> }, _retry?: boolean) => {
            state = { ...state, ...copy(input.data) };
            return Promise.resolve({ errorCode: 0 });
        }),
        ensureSuccess: (value: { result: unknown }) => value.result,
    };
    const fresh = (controller = 'controller') => new NetworkOperations(request as unknown as RequestHandler, site, path, controller);
    return {
        ops: fresh(),
        fresh,
        request,
        set: (v: typeof state) => {
            state = copy(v);
        },
        get: () => copy(state),
    };
}
const radioBand = {
    radioEnable: true,
    channelRange: [],
    channelWidth: '5',
    channel: '1',
    freq: 5180,
    txPower: 19,
    txPowerLevel: 3,
    wirelessMode: -2,
};
function radios() {
    let state = { radioSetting5g: copy(radioBand) };
    const request = {
        get: vi.fn(async (url: string) => ({
            errorCode: 0,
            result: url.endsWith('/available-channel') ? [{ radioId: 1, apChannelDetailList: [{ index: 1, channel: 36, freq: 5180 }] }] : copy(state),
        })),
        request: vi.fn((input: { data: typeof state }, _retry?: boolean) => {
            state = { ...state, ...copy(input.data) };
            return Promise.resolve({ errorCode: 0 });
        }),
        ensureSuccess: (value: { result: unknown; errorCode: number }) => {
            if (value.errorCode !== 0) throw new Error('controller rejection');
            return value.result;
        },
    };
    const fresh = (controller = 'controller') => new ApRadioOperations(request as unknown as RequestHandler, site, path, controller);
    return {
        ops: fresh(),
        fresh,
        request,
        get: () => copy(state),
        set: (v: typeof state) => {
            state = copy(v);
        },
    };
}

describe('DHCP durable receipt rollback', () => {
    it('undoes a verified creation after preview in a fresh client and repeats as a no-op', async () => {
        const h = dhcp(undefined);
        h.set(undefined);
        const created = await h.ops.createDhcpReservation(config);
        const receipt = created.rollbackReceipt!;
        expect(receipt).toMatchObject({ resource: 'dhcp-reservation', before: null, appliedId: 'new-id' });
        expect(h.request.request.mock.calls[0][1]).toBe(false);
        const preview = await h.fresh().rollbackDhcpChange(JSON.parse(JSON.stringify(receipt)));
        expect(preview).toMatchObject({ dryRun: true, written: false });
        expect(h.request.request).toHaveBeenCalledTimes(1);
        expect(await h.fresh().rollbackDhcpChange(receipt, false)).toMatchObject({ operation: 'rollback', verification: { status: 'verified' } });
        expect(h.get()).toBeUndefined();
        expect(await h.fresh().rollbackDhcpChange(receipt, false)).toMatchObject({ written: false, verification: { attempts: 0 } });
        expect(h.request.request).toHaveBeenCalledTimes(2);
    });
    it('recreates a verified deletion and accepts the restored configuration as an idempotent no-op', async () => {
        const h = dhcp();
        const deleted = await h.ops.deleteDhcpReservation(mac);
        expect(deleted.rollbackReceipt).toMatchObject({ beforeId: 'original', applied: null });
        await h.fresh().rollbackDhcpChange(deleted.rollbackReceipt!, false);
        expect(h.get()).toMatchObject({ ...config, id: 'new-id' });
        await h.fresh().rollbackDhcpChange(deleted.rollbackReceipt!, false);
        expect(h.request.request).toHaveBeenCalledTimes(2);
    });
    it('rejects drift and same-MAC replacement before any restoration write', async () => {
        const h = dhcp();
        const updated = await h.ops.updateDhcpReservation(mac, { description: 'after' });
        const receipt = updated.rollbackReceipt!;
        h.set({ ...h.get(), description: 'external' });
        await expect(h.ops.rollbackDhcpChange(receipt, false)).rejects.toThrow('changed or was replaced');
        h.set({ ...config, description: 'after', id: 'replacement' });
        await expect(h.ops.rollbackDhcpChange(receipt, false)).rejects.toThrow('changed or was replaced');
        expect(h.request.request).toHaveBeenCalledTimes(1);
    });
    it('restores a verified update without losing omitted writable siblings', async () => {
        const h = dhcp();
        const updated = await h.ops.updateDhcpReservation(mac, { description: 'after' });
        await h.fresh().rollbackDhcpChange(updated.rollbackReceipt!, false);
        expect(h.get()).toEqual({ ...config, id: 'original' });
        expect(h.request.request).toHaveBeenCalledTimes(2);
    });
    it('refuses a new drift observed during the write preflight', async () => {
        const h = dhcp();
        const updated = await h.ops.updateDhcpReservation(mac, { description: 'after' });
        h.request.fetchPaginated
            .mockResolvedValueOnce([{ ...config, description: 'after', id: 'original' }])
            .mockResolvedValueOnce([{ ...config, description: 'external', id: 'original' }]);
        await expect(h.ops.rollbackDhcpChange(updated.rollbackReceipt!, false)).rejects.toThrow('while preparing');
        expect(h.request.request).toHaveBeenCalledTimes(1);
    });
    it('never issues a receipt without stable row identity or removable-field preservation', async () => {
        const h = dhcp({ ...config, id: undefined });
        const a = await h.ops.updateDhcpReservation(mac, { description: 'after' });
        expect(a.rollbackReceipt).toBeUndefined();
        const other = dhcp({ ...config, id: 'original', description: undefined });
        const b = await other.ops.updateDhcpReservation(mac, { description: 'added' });
        expect(b.rollbackReceipt).toBeUndefined();
    });
    it('rejects a foreign controller and forged target identities', async () => {
        const h = dhcp();
        const r = (await h.ops.updateDhcpReservation(mac, { description: 'after' })).rollbackReceipt!;
        await expect(h.fresh('another').rollbackDhcpChange(r, false)).rejects.toThrow('different controller');
        expect(networkChangeReceiptSchema.safeParse({ ...r, mac: 'AA-BB-CC-DD-EE-00' }).success).toBe(false);
        expect(h.request.request).toHaveBeenCalledTimes(1);
    });
    it('reconciles a lost acknowledgement once without replaying DHCP writes', async () => {
        const h = dhcp();
        h.request.request.mockImplementationOnce((input) => {
            h.set({ ...h.get(), ...copy(input.data) });
            return Promise.reject(new AxiosError('lost', 'ETIMEDOUT'));
        });
        const r = await h.ops.updateDhcpReservation(mac, { description: 'after' });
        expect(r.verification?.status).toBe('verified');
        expect(r.written).toBe('unknown');
        expect(r.rollbackReceipt).toBeDefined();
        expect(h.request.request).toHaveBeenCalledTimes(1);
    });
});

describe('sanitized DHCP transport errors', () => {
    it('reconciles a request-handler error that no longer has Axios identity', async () => {
        const h = dhcp();
        h.request.request.mockImplementationOnce((input) => {
            h.set({ ...h.get(), ...copy(input.data) });
            return Promise.reject(Object.assign(new Error('connection lost'), { code: 'ECONNRESET' }));
        });
        const result = await h.ops.updateDhcpReservation(mac, { description: 'after' });
        expect(result.verification?.status).toBe('verified');
        expect(result.written).toBe('unknown');
        expect(result.rollbackReceipt).toBeDefined();
        expect(h.request.request).toHaveBeenCalledTimes(1);
    });
    it('keeps safe HTTP rejection status definite after request redaction', async () => {
        const h = dhcp();
        h.request.request.mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { status: 403 }));
        await expect(h.ops.updateDhcpReservation(mac, { description: 'after' })).rejects.toThrow('Forbidden');
        expect(h.request.fetchPaginated).toHaveBeenCalledTimes(1);
    });
});

describe('secret-free SSID receipt rollback', () => {
    it('restores a verified open SSID edit through the preserving write workflow', async () => {
        const h = wireless();
        const updated = (await h.ops.updateSsid('wlan', 'ssid', { name: 'after' })) as { rollbackReceipt: unknown };
        expect(networkChangeReceiptSchema.safeParse(updated.rollbackReceipt).success).toBe(true);
        const receipt = ssidChangeReceiptSchema.parse(updated.rollbackReceipt);
        const preview = await h.fresh().rollbackSsidChange(receipt);
        expect(preview).toMatchObject({ dryRun: true, written: false });
        await h.fresh().rollbackSsidChange(receipt, false);
        expect(h.get()).toEqual(ssid);
        await h.ops.rollbackSsidChange(receipt, false);
        expect(h.request.request).toHaveBeenCalledTimes(2);
    });
    it('keeps personal passwords out of receipts and explains the unsupported rollback', async () => {
        const personal = {
            ...ssid,
            security: 3,
            pskSetting: { securityKey: 'old-secret', versionPsk: 2, encryptionPsk: 3, gikRekeyPskEnable: false },
        };
        const h = wireless(personal);
        const result = await h.ops.updateSsid('wlan', 'ssid', { name: 'after' });
        expect(result).toMatchObject({ verification: { status: 'verified' }, rollbackUnavailable: expect.stringContaining('secret-free') });
        expect(result).not.toHaveProperty('rollbackReceipt');
        expect(JSON.stringify(result)).not.toContain('old-secret');
    });
    it('rejects secrets or password-bearing modes even in forged receipts', () => {
        const base = {
            version: 1,
            resource: 'ssid-basic',
            controllerId: 'controller',
            siteId: 'site',
            wlanId: 'wlan',
            ssidId: 'ssid',
            before: ssid,
            applied: { ...ssid, name: 'after' },
        };
        expect(ssidChangeReceiptSchema.safeParse({ ...base, before: { ...ssid, pskSetting: { securityKey: 'secret' } } }).success).toBe(false);
        expect(ssidChangeReceiptSchema.safeParse({ ...base, before: { ...ssid, security: 3 } }).success).toBe(false);
    });
    it('rejects drift and foreign-controller restoration', async () => {
        const h = wireless();
        const r = ssidChangeReceiptSchema.parse(
            ((await h.ops.updateSsid('wlan', 'ssid', { name: 'after' })) as { rollbackReceipt: unknown }).rollbackReceipt
        );
        h.set({ ...h.get(), broadcast: false });
        await expect(h.ops.rollbackSsidChange(r, false)).rejects.toThrow('changed after');
        await expect(h.fresh('foreign').rollbackSsidChange(r, false)).rejects.toThrow('different controller');
        expect(h.request.request).toHaveBeenCalledTimes(1);
    });
    it('does not receipt missing old fields that cannot be restored', async () => {
        const h = wireless({ ...ssid, mloEnable: undefined });
        const result = await h.ops.updateSsid('wlan', 'ssid', { mloEnable: false, name: 'after' });
        expect(result).not.toHaveProperty('rollbackReceipt');
    });
});

describe('AP radio durable receipt rollback', () => {
    it('previews and restores a verified radio change, with a repeat no-op', async () => {
        const h = radios();
        const updated = await h.ops.setApRadio(mac, '5g', { txPower: 20 });
        const receipt = updated.rollbackReceipt!;
        expect(receipt.resource).toBe('ap-radio');
        expect(h.request.request.mock.calls[0][1]).toBe(false);
        expect(await h.fresh().rollbackApRadioChange(receipt)).toMatchObject({ dryRun: true, written: false });
        expect(h.request.request).toHaveBeenCalledTimes(1);
        expect(await h.fresh().rollbackApRadioChange(receipt, false)).toMatchObject({ verified: true, verification: { status: 'verified' } });
        expect(h.get()).toEqual({ radioSetting5g: radioBand });
        await h.ops.rollbackApRadioChange(receipt, false);
        expect(h.request.request).toHaveBeenCalledTimes(2);
    });
    it('rejects drift to the target or another band before changing radios', async () => {
        const h = radios();
        const r = (await h.ops.setApRadio(mac, '5g', { txPower: 20 })).rollbackReceipt!;
        h.set({ radioSetting5g: { ...h.get().radioSetting5g, channelWidth: '7' } });
        await expect(h.ops.rollbackApRadioChange(r, false)).rejects.toThrow('changed after');
        expect(h.request.request).toHaveBeenCalledTimes(1);
    });
    it('reconciles an uncertain radio mutation without replay', async () => {
        const h = radios();
        h.request.request.mockImplementationOnce((input) => {
            h.set({ ...h.get(), ...copy(input.data) });
            return Promise.reject(new AxiosError('lost', 'ETIMEDOUT'));
        });
        const r = await h.ops.setApRadio(mac, '5g', { txPower: 20 });
        expect(r).toMatchObject({ written: 'unknown', verification: { ok: true } });
        expect(r.rollbackReceipt).toBeDefined();
        expect(h.request.request).toHaveBeenCalledTimes(1);
    });
    it('rejects non-single-band receipt changes and missing original shape', () => {
        const base = {
            version: 1,
            resource: 'ap-radio',
            controllerId: 'controller',
            siteId: 'site',
            apMac: mac,
            band: '5g',
            before: { radioSetting5g: radioBand },
            applied: { radioSetting5g: { ...radioBand, txPower: 20 } },
        };
        expect(apRadioChangeReceiptSchema.safeParse(base).success).toBe(true);
        expect(apRadioChangeReceiptSchema.safeParse({ ...base, applied: { ...base.applied, radioSetting2g: { radioEnable: false } } }).success).toBe(
            false
        );
    });
});

describe('unverified restoration and complete snapshots', () => {
    it('never receipts an SSID acknowledgement without matching read-back', async () => {
        const h = wireless();
        h.request.request.mockResolvedValueOnce({ errorCode: 0 });
        const result = await h.ops.updateSsid('wlan', 'ssid', { name: 'after' });
        expect(result).toMatchObject({ verification: { status: 'mismatch' } });
        expect(result).not.toHaveProperty('rollbackReceipt');
        expect(h.request.request).toHaveBeenCalledTimes(1);
    });
    it('receipts enterprise settings without personal security data', async () => {
        const enterprise = {
            ...ssid,
            security: 2,
            entSetting: { radiusProfileId: 'radius', versionEnt: 2, encryptionEnt: 3, gikRekeyEntEnable: false },
        };
        const h = wireless(enterprise);
        const result = (await h.ops.updateSsid('wlan', 'ssid', { name: 'after' })) as { rollbackReceipt: unknown };
        expect(ssidChangeReceiptSchema.safeParse(result.rollbackReceipt).success).toBe(true);
        const receipt = ssidChangeReceiptSchema.parse(result.rollbackReceipt);
        await h.ops.rollbackSsidChange(receipt, false);
        expect(h.get()).toEqual(enterprise);
    });
    it('does not claim a DHCP update identity survived replacement', async () => {
        const h = dhcp();
        h.request.request.mockImplementationOnce((input) => {
            h.set({ ...config, ...copy(input.data), id: 'replacement' });
            return Promise.resolve({ errorCode: 0 });
        });
        const result = await h.ops.updateDhcpReservation(mac, { description: 'after' });
        expect(result.verification?.status).toBe('verified');
        expect(result.rollbackReceipt).toBeUndefined();
    });
    it('returns an unverified radio restoration without issuing another receipt or replaying', async () => {
        const h = radios(),
            receipt = (await h.ops.setApRadio(mac, '5g', { txPower: 20 })).rollbackReceipt!;
        h.request.request.mockRejectedValueOnce(new AxiosError('lost', 'ETIMEDOUT'));
        const result = await h.ops.rollbackApRadioChange(receipt, false);
        expect(result).toMatchObject({ written: 'unknown', verified: false, verification: { status: 'mismatch' } });
        expect(result).not.toHaveProperty('rollbackReceipt');
        expect(h.request.request).toHaveBeenCalledTimes(2);
    });
    it('propagates a definite controller rejection during radio restoration without retry', async () => {
        const h = radios(),
            receipt = (await h.ops.setApRadio(mac, '5g', { txPower: 20 })).rollbackReceipt!;
        h.request.request.mockResolvedValueOnce({ errorCode: -1 });
        await expect(h.ops.rollbackApRadioChange(receipt, false)).rejects.toThrow('controller rejection');
        expect(h.request.request).toHaveBeenCalledTimes(2);
    });
    it('fails closed on incomplete enabled-radio evidence instead of issuing a partial receipt', async () => {
        const h = radios();
        h.set({ radioSetting5g: { ...radioBand, wirelessMode: undefined } as unknown as typeof radioBand });
        const result = await h.ops.setApRadio(mac, '5g', { txPower: 20 });
        expect(result.verification?.ok).toBe(true);
        expect(result.rollbackReceipt).toBeUndefined();
    });
});

describe('versioned receipt dispatch', () => {
    it('preserves existing version-1 rate-limit receipts and dispatches each resource explicitly', async () => {
        const rate = { rollbackNetworkChange: vi.fn().mockResolvedValue({ written: false }) },
            network = { rollbackSsidChange: vi.fn() },
            reservations = { rollbackDhcpChange: vi.fn() },
            radio = { rollbackApRadioChange: vi.fn() };
        const ops = new NetworkChangeOperations('controller', rate, network, reservations, radio);
        const config = { name: 'test', upLimitEnable: false, downLimitEnable: false };
        const receipt = {
            version: 1 as const,
            resource: 'rate-limit-profile' as const,
            controllerId: 'controller',
            siteId: 'site',
            profileId: 'profile',
            before: config,
            applied: { ...config, name: 'after' },
        };
        expect(isDeepStrictEqual(networkChangeReceiptSchema.parse(receipt), receipt)).toBe(true);
        await ops.rollbackNetworkChange(receipt);
        expect(rate.rollbackNetworkChange).toHaveBeenCalledWith(receipt, true);
        await expect(ops.rollbackNetworkChange({ ...receipt, controllerId: 'foreign' }, false)).rejects.toThrow('different controller');
        expect(rate.rollbackNetworkChange).toHaveBeenCalledTimes(1);
    });
});
