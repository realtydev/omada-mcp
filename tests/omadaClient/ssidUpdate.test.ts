import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NetworkOperations } from '../../src/omadaClient/network.js';
import type { RequestHandler } from '../../src/omadaClient/request.js';
import type { SiteOperations } from '../../src/omadaClient/site.js';
import type { OmadaApiResponse } from '../../src/types/index.js';

const base = {
    ssidId: 'ssid-1',
    name: 'Existing WiFi',
    band: 3,
    broadcast: true,
    guestNetEnable: false,
    security: 3,
    pskSetting: { securityKey: 'old-password', versionPsk: 2, encryptionPsk: 3, gikRekeyPskEnable: false },
    mloEnable: false,
    pmfMode: 2,
    enable11r: false,
    vlanEnable: true,
    vlanId: 42,
    clientRateLimit: { enable: true },
    wlanSchedule: { enable: true },
};

describe('SSID preserving updates', () => {
    let network: NetworkOperations;
    const get = vi.fn();
    const request = vi.fn();
    const detail = (value: unknown) => ({ errorCode: 0, result: value });

    beforeEach(() => {
        get.mockReset().mockResolvedValue(detail(base));
        request.mockReset().mockResolvedValue({ errorCode: 0, result: {} });
        network = new NetworkOperations(
            {
                get,
                request,
                ensureSuccess: (response: OmadaApiResponse<unknown>) => {
                    if (response.errorCode !== 0) throw new Error(response.msg ?? 'API error');
                    return response.result;
                },
            } as unknown as RequestHandler,
            { resolveSiteId: (siteId?: string) => siteId ?? 'default-site' } as SiteOperations,
            (path) => `/openapi/v1/controller${path}`
        );
    });

    it('preserves required basic and security siblings and excludes settings owned by other endpoints', async () => {
        get.mockResolvedValueOnce(detail(base))
            .mockResolvedValueOnce(detail(base))
            .mockResolvedValue(detail({ ...base, name: 'New WiFi' }));

        const result = await network.updateSsid('wlan/1', 'ssid/1', { name: 'New WiFi' }, 'site/1');

        expect(request).toHaveBeenCalledExactlyOnceWith(
            {
                method: 'PATCH',
                url: '/openapi/v1/controller/sites/site%2F1/wireless-network/wlans/wlan%2F1/ssids/ssid%2F1/update-basic-config',
                data: {
                    name: 'New WiFi',
                    band: 3,
                    broadcast: true,
                    guestNetEnable: false,
                    security: 3,
                    pskSetting: base.pskSetting,
                    mloEnable: false,
                    pmfMode: 2,
                    enable11r: false,
                    vlanEnable: true,
                    vlanId: 42,
                },
            },
            false
        );
        expect(result).toMatchObject({ written: true, acknowledged: true, verification: { status: 'verified', attempts: 1 } });
        expect(JSON.stringify(result)).not.toContain('old-password');
        expect(base.name).toBe('Existing WiFi');
    });

    it('previews a partial PSK edit without writing or exposing the old or new password', async () => {
        const result = await network.updateSsid('wlan', 'ssid', { pskSetting: { securityKey: 'new-password' } }, undefined, true);

        expect(request).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            dryRun: true,
            written: false,
            changes: [{ field: 'pskSetting.securityKey', before: '[redacted]', after: '[redacted]' }],
        });
        expect(JSON.stringify(result)).not.toMatch(/old-password|new-password/);
    });

    it('merges a partial security object before applying and verifies the requested key', async () => {
        get.mockResolvedValueOnce(detail(base))
            .mockResolvedValueOnce(detail(base))
            .mockResolvedValue(detail({ ...base, pskSetting: { ...base.pskSetting, securityKey: 'new-password' } }));
        const result = await network.updateSsid('wlan', 'ssid', { pskSetting: { securityKey: 'new-password' } });
        expect(request.mock.calls[0][0].data.pskSetting).toEqual({ ...base.pskSetting, securityKey: 'new-password' });
        expect(result).toMatchObject({ verification: { status: 'verified' } });
        expect(JSON.stringify(result)).not.toContain('new-password');
    });

    it('preserves enterprise security siblings and custom VLAN mappings on partial changes', async () => {
        const enterprise = {
            ...base,
            security: 2,
            pskSetting: undefined,
            entSetting: { radiusProfileId: 'radius-1', versionEnt: 2, encryptionEnt: 3, gikRekeyEntEnable: false },
            vlanSetting: { mode: 1, customConfig: { customMode: 0, lanNetworkVlanIds: { 'lan-1': [42, 43] } } },
        };
        const wanted = {
            ...enterprise,
            entSetting: { ...enterprise.entSetting, radiusProfileId: 'radius-2' },
            vlanSetting: { mode: 1, customConfig: { customMode: 0, lanNetworkVlanIds: { 'lan-1': [43, 42], 'lan-2': [44] } } },
        };
        get.mockResolvedValueOnce(detail(enterprise)).mockResolvedValueOnce(detail(enterprise)).mockResolvedValue(detail(wanted));
        const result = await network.updateSsid('wlan', 'ssid', {
            entSetting: { radiusProfileId: 'radius-2' },
            vlanSetting: { customConfig: { lanNetworkVlanIds: { 'lan-2': [44] } } },
        });
        expect(request.mock.calls[0][0].data).toMatchObject({
            entSetting: wanted.entSetting,
            vlanSetting: { mode: 1, customConfig: { customMode: 0, lanNetworkVlanIds: { 'lan-1': [42, 43], 'lan-2': [44] } } },
        });
        expect(result).toMatchObject({ verification: { status: 'verified' } });
    });

    it('retains supported full basic configuration calls', async () => {
        const { ssidId: _id, clientRateLimit: _rate, wlanSchedule: _schedule, ...full } = base;
        const requested = { ...full, band: 7, mloEnable: true };
        get.mockResolvedValueOnce(detail(base)).mockResolvedValueOnce(detail(base)).mockResolvedValue(detail(requested));
        const result = await network.updateSsid('wlan', 'ssid', requested);
        expect(request.mock.calls[0][0].data).toEqual(requested);
        expect(result).toMatchObject({ written: true, verification: { status: 'verified' } });
    });

    it.each([
        { name: '😀'.repeat(9) },
        { name: '' },
        { security: 'wpa2-psk' },
        { band: 0 },
        { vlanId: 4095 },
        { pskSetting: { securityKey: 'short' } },
        { pskSetting: { typo: true } },
        { ssidEnable: false },
        {},
        { pskSetting: {} },
    ])('rejects invalid or unsupported input before any write: %j', async (value) => {
        await expect(network.updateSsid('wlan', 'ssid', value)).rejects.toThrow();
        expect(request).not.toHaveBeenCalled();
    });

    it('accepts an SSID name of exactly 32 UTF-8 bytes', async () => {
        await expect(network.updateSsid('wlan', 'ssid', { name: '😀'.repeat(8) }, undefined, true)).resolves.toMatchObject({ dryRun: true });
    });

    it('refuses to guess missing required siblings or preserve a masked password', async () => {
        get.mockResolvedValue(detail({ name: 'Incomplete' }));
        await expect(network.updateSsid('wlan', 'ssid', { name: 'New' })).rejects.toThrow('Cannot preserve');
        get.mockResolvedValue(detail({ ...base, pskSetting: { ...base.pskSetting, securityKey: '********' } }));
        await expect(network.updateSsid('wlan', 'ssid', { name: 'New' })).rejects.toThrow('hidden SSID password');
        expect(request).not.toHaveBeenCalled();
    });

    it('requires an explicit MLO value when the controller omits it instead of guessing false', async () => {
        const snapshot: Record<string, unknown> = { ...base };
        delete snapshot.mloEnable;
        get.mockResolvedValue(detail(snapshot));
        await expect(network.updateSsid('wlan', 'ssid', { name: 'New' }, undefined, true)).rejects.toThrow('mloEnable');
        await expect(network.updateSsid('wlan', 'ssid', { name: 'New', mloEnable: false }, undefined, true)).resolves.toMatchObject({
            dryRun: true,
            written: false,
        });
        expect(request).not.toHaveBeenCalled();
    });

    it('reports mismatch when the controller acknowledges but ignores the requested change', async () => {
        const result = await network.updateSsid('wlan', 'ssid', { name: 'Ignored' });
        expect(result).toMatchObject({
            written: true,
            acknowledged: true,
            verification: { status: 'mismatch', attempts: 3, mismatchedFields: ['name'] },
        });
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('reports collateral security and VLAN resets even when the requested rename applies', async () => {
        get.mockResolvedValueOnce(detail(base))
            .mockResolvedValueOnce(detail(base))
            .mockResolvedValue(detail({ ...base, name: 'Renamed', security: 0, vlanId: 1, pskSetting: undefined }));
        const result = await network.updateSsid('wlan', 'ssid', { name: 'Renamed' });
        expect(result).toMatchObject({
            acknowledged: true,
            verification: { status: 'mismatch', mismatchedFields: [], unexpectedChanges: expect.arrayContaining(['security', 'vlanId']) },
        });
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('does not overwrite an external edit detected by the second pre-write read', async () => {
        get.mockResolvedValueOnce(detail(base)).mockResolvedValue(detail({ ...base, vlanId: 99 }));
        await expect(network.updateSsid('wlan', 'ssid', { name: 'Renamed' })).rejects.toThrow('settings changed');
        expect(request).not.toHaveBeenCalled();
    });

    it('does not write if the pre-write snapshot cannot be confirmed', async () => {
        get.mockResolvedValueOnce(detail(base)).mockRejectedValue(new Error('server echoed old-password'));
        const operation = network.updateSsid('wlan', 'ssid', { name: 'Renamed' });
        await expect(operation).rejects.toThrow('Cannot confirm unchanged SSID');
        await expect(operation).rejects.not.toThrow('old-password');
        expect(request).not.toHaveBeenCalled();
    });

    it('ignores inactive security defaults when preserving an open SSID', async () => {
        const open = {
            ...base,
            security: 0,
            vlanEnable: false,
            vlanId: 0,
            pskSetting: { securityKey: '', versionPsk: 0 },
            entSetting: { radiusProfileId: '' },
        };
        get.mockResolvedValueOnce(detail(open))
            .mockResolvedValueOnce(detail(open))
            .mockResolvedValue(detail({ ...open, name: 'Renamed' }));
        const result = await network.updateSsid('wlan', 'ssid', { name: 'Renamed' });
        expect(request.mock.calls[0][0].data).not.toHaveProperty('pskSetting');
        expect(request.mock.calls[0][0].data).not.toHaveProperty('entSetting');
        expect(request.mock.calls[0][0].data).not.toHaveProperty('vlanId');
        expect(result).toMatchObject({ verification: { status: 'verified' } });
    });

    it('explicitly lists an inherited secret hidden during readback without exposing its value', async () => {
        get.mockResolvedValueOnce(detail(base))
            .mockResolvedValueOnce(detail(base))
            .mockResolvedValue(detail({ ...base, name: 'Renamed', pskSetting: { ...base.pskSetting, securityKey: '********' } }));
        const result = await network.updateSsid('wlan', 'ssid', { name: 'Renamed' });
        expect(result).toMatchObject({ verification: { status: 'verified', unverifiedPreservedFields: ['pskSetting.securityKey'] } });
        expect(JSON.stringify(result)).not.toContain('old-password');
    });

    it('reports unknown when readback fails without exposing controller errors or secrets', async () => {
        get.mockResolvedValueOnce(detail(base)).mockResolvedValueOnce(detail(base)).mockRejectedValue(new Error('server echoed old-password'));
        const result = await network.updateSsid('wlan', 'ssid', { name: 'New' });
        expect(result).toMatchObject({ acknowledged: true, verification: { status: 'unknown', attempts: 3 } });
        expect(JSON.stringify(result)).not.toContain('old-password');
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('does not replay a lost acknowledgement and reports uncertainty even if desired state is observed', async () => {
        request.mockRejectedValue(new Error('lost acknowledgement containing new-password'));
        get.mockResolvedValueOnce(detail(base))
            .mockResolvedValueOnce(detail(base))
            .mockResolvedValue(detail({ ...base, name: 'New' }));
        const result = await network.updateSsid('wlan', 'ssid', { name: 'New' });
        expect(result).toMatchObject({ written: 'unknown', acknowledged: false, verification: { status: 'verified' } });
        expect(request).toHaveBeenCalledTimes(1);
        expect(request.mock.calls[0][1]).toBe(false);
        expect(JSON.stringify(result)).not.toContain('new-password');
    });

    it('treats a hidden password in readback as unverifiable rather than a successful write', async () => {
        get.mockResolvedValueOnce(detail(base))
            .mockResolvedValueOnce(detail(base))
            .mockResolvedValue(detail({ ...base, pskSetting: { ...base.pskSetting, securityKey: '********' } }));
        const result = await network.updateSsid('wlan', 'ssid', { pskSetting: { securityKey: 'new-password' } });
        expect(result).toMatchObject({ verification: { status: 'unknown' } });
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('does not claim a write when the requested state is already present', async () => {
        const result = await network.updateSsid('wlan', 'ssid', { name: base.name });
        expect(result).toMatchObject({ written: false, changes: [], verification: { status: 'verified', attempts: 0 } });
        expect(request).not.toHaveBeenCalled();
    });

    it('propagates an acknowledged controller rejection and never resubmits it', async () => {
        request.mockResolvedValue({ errorCode: -33219, msg: 'SSID exists' });
        await expect(network.updateSsid('wlan', 'ssid', { name: 'Duplicate' })).rejects.toThrow('errorCode: -33219');
        expect(request).toHaveBeenCalledTimes(1);
        expect(get).toHaveBeenCalledTimes(2);
    });

    it('never echoes a submitted secret from a negative controller envelope', async () => {
        request.mockResolvedValue({ errorCode: -33217, msg: 'Invalid key new-password' });
        const operation = network.updateSsid('wlan', 'ssid', { pskSetting: { securityKey: 'new-password' } });
        await expect(operation).rejects.toThrow('errorCode: -33217');
        await expect(operation).rejects.not.toThrow('new-password');
        expect(request).toHaveBeenCalledTimes(1);
    });

    it.each([
        { pskSetting: { gikRekeyPskEnable: true, intervalPskType: 0, rekeyPskInterval: 1 } },
        { pskSetting: { gikRekeyPskEnable: true, intervalPskType: 2, rekeyPskInterval: 25 } },
        { pskSetting: { gikRekeyPskEnable: true } },
        { security: 2, entSetting: { radiusProfileId: 'r', versionEnt: 4, encryptionEnt: 1, gikRekeyEntEnable: false } },
        { security: 2, band: 4, entSetting: { radiusProfileId: 'r', versionEnt: 4, encryptionEnt: 3, gikRekeyEntEnable: false } },
        { security: 2, band: 7, mloEnable: true, entSetting: { radiusProfileId: 'r', versionEnt: 4, encryptionEnt: 3, gikRekeyEntEnable: false } },
        { vlanSetting: { customConfig: { customMode: 0 } } },
    ])('rejects incomplete or invalid active settings before writing: %j', async (value) => {
        await expect(network.updateSsid('wlan', 'ssid', value)).rejects.toThrow('Cannot preserve');
        expect(request).not.toHaveBeenCalled();
    });
});
