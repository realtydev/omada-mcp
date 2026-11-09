import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApSsidOverrideOperations } from '../../src/omadaClient/apSsidOverride.js';
import type { InternalRequestHandler } from '../../src/omadaClient/internalRequest.js';
import type { RequestHandler } from '../../src/omadaClient/request.js';
import type { SiteOperations } from '../../src/omadaClient/site.js';

const mac = 'AA-BB-CC-DD-EE-FF';
const initial = () => [
    {
        index: 1,
        globalSsid: 'Guest',
        ssid: 'Guest',
        enable: false,
        vlanEnable: false,
        ssidEnable: true,
        security: 3,
        psk: 'Inherited-secret-42',
        ssidConfigurable: true,
    },
    {
        index: 2,
        globalSsid: 'Other',
        ssid: 'Private override',
        enable: true,
        vlanEnable: true,
        vlanId: 42,
        ssidEnable: true,
        security: 3,
        psk: 'Other-secret-42',
        ssidConfigurable: true,
    },
];
const ensureSuccess = (response: { errorCode: number; result?: unknown }) => {
    if (response.errorCode) throw new Error('Controller rejected override');
    return response.result;
};
describe('AP SSID override preservation', () => {
    let config: ReturnType<typeof initial>;
    let request: { get: ReturnType<typeof vi.fn>; request: ReturnType<typeof vi.fn>; ensureSuccess: typeof ensureSuccess };
    let internal: { get: ReturnType<typeof vi.fn>; ensureSuccess: typeof ensureSuccess };
    let ops: ApSsidOverrideOperations;
    beforeEach(() => {
        config = initial();
        request = {
            get: vi.fn(async () => ({
                errorCode: 0,
                result: {
                    apGroupId: 'group',
                    ssidOverrides: config.map((e) => ({
                        ssidEntryId: e.index,
                        ssidId: `ssid-${e.index}`,
                        ssidName: e.ssid,
                        security: e.security,
                        ssidPassword: 'Never-return-this',
                        ssidEnable: e.ssidEnable,
                        band: [0, 1],
                    })),
                },
            })),
            request: vi.fn(({ data }) => {
                for (const entry of data.ssidOverrides) {
                    const index = config.findIndex((e) => e.index === entry.ssidEntryId);
                    config[index] = {
                        ...config[index],
                        enable: entry.overrideSsidEnable,
                        vlanEnable: entry.overrideVlanEnable,
                        ssidEnable: entry.ssidEnable,
                        ...(entry.overrideSsidName !== undefined ? { ssid: entry.overrideSsidName } : {}),
                        ...(entry.overrideSsidPassword !== undefined ? { psk: entry.overrideSsidPassword } : {}),
                        ...(entry.vlanId !== undefined ? { vlanId: entry.vlanId } : {}),
                        ...(entry.vlanPoolIds !== undefined ? { vlanPoolIds: entry.vlanPoolIds } : {}),
                    };
                }
                return Promise.resolve({ errorCode: 0 });
            }),
            ensureSuccess,
        };
        internal = { get: vi.fn(async () => ({ errorCode: 0, result: { wlanId: 'wlan', ssidOverrides: structuredClone(config) } })), ensureSuccess };
        ops = new ApSsidOverrideOperations(
            request as unknown as RequestHandler,
            { resolveSiteId: (site?: string) => site ?? 'site' } as SiteOperations,
            (path, version) => `/openapi/${version}/controller${path}`
        );
        ops.setInternalRequest(internal as unknown as InternalRequestHandler);
    });
    it('returns effective/configured state with every public and configured password removed', async () => {
        const result = await ops.getApSsidOverrides(mac);
        expect(result).toMatchObject({
            configurationSource: 'internal-web-api',
            ssidOverrides: [
                { ssidEntryId: 1 },
                { configured: { overrideSsidEnable: true, overrideVlanEnable: true, vlanId: 42, overrideSsidPassword: '[redacted]' } },
            ],
        });
        for (const secret of ['Other-secret-42', 'Inherited-secret-42', 'Never-return-this']) expect(JSON.stringify(result)).not.toContain(secret);
    });
    it('defaults to a preview and never exposes sibling or selected passwords', async () => {
        const result = await ops.updateApSsidOverride(mac, 1, { ssidEnable: false });
        expect(result).toMatchObject({
            dryRun: true,
            written: false,
            verified: false,
            changes: [{ field: 'ssidEnable', before: true, after: false }],
        });
        expect(request.request).not.toHaveBeenCalled();
        expect(JSON.stringify(result)).not.toContain('secret-42');
    });
    it('writes the complete documented v2 body once, preserving an active sibling password and VLAN', async () => {
        const other = structuredClone(config[1]);
        const result = await ops.updateApSsidOverride('aabbccddeeff', 1, { ssidEnable: false }, 'site', false);
        expect(request.request).toHaveBeenCalledExactlyOnceWith(
            {
                method: 'PATCH',
                url: `/openapi/v2/controller/sites/site/aps/${mac}/override`,
                data: {
                    ssidOverrides: [
                        { ssidEntryId: 1, overrideSsidEnable: false, overrideVlanEnable: false, ssidEnable: false },
                        {
                            ssidEntryId: 2,
                            overrideSsidEnable: true,
                            overrideVlanEnable: true,
                            ssidEnable: true,
                            overrideSsidName: 'Private override',
                            overrideSsidPassword: 'Other-secret-42',
                            vlanId: 42,
                        },
                    ],
                },
            },
            false
        );
        expect(config[1]).toEqual(other);
        expect(result).toMatchObject({
            written: true,
            verified: true,
            verification: { status: 'verified', attempts: 1 },
            verificationScope: 'configured_ap_ssid_overrides',
        });
    });
    it('supports typed SSID name/password and VLAN overrides while redacting returned changes', async () => {
        const result = await ops.updateApSsidOverride(
            mac,
            1,
            { overrideSsidEnable: true, overrideSsidName: 'New guest', overrideSsidPassword: 'New-secret-42', overrideVlanEnable: true, vlanId: 12 },
            undefined,
            false
        );
        expect(result).toMatchObject({ verified: true, desired: { overrideSsidName: 'New guest', overrideSsidPassword: '[redacted]', vlanId: 12 } });
        expect(config[0]).toMatchObject({ enable: true, ssid: 'New guest', psk: 'New-secret-42', vlanEnable: true, vlanId: 12 });
        expect(JSON.stringify(result)).not.toContain('New-secret-42');
    });
    it('allows an explicit password when the selected active password is hidden', async () => {
        config[1].psk = '********';
        expect(await ops.updateApSsidOverride(mac, 2, { overrideSsidPassword: 'Replacement-42' }, undefined, false)).toMatchObject({
            verified: true,
        });
    });
    it.each([
        ['4094', true],
        ['4094,42', false],
    ])('checks VLAN pool echo %s without accepting a changed pool', async (pool, verified) => {
        const write = request.request.getMockImplementation()!;
        request.request.mockImplementation(async (args) => {
            await write(args);
            Object.assign(config[0], { vlanPoolIds: pool });
            return { errorCode: 0 };
        });
        expect(await ops.updateApSsidOverride(mac, 1, { overrideVlanEnable: true, vlanId: 4094 }, undefined, false)).toMatchObject({
            written: true,
            verified,
        });
        expect(request.request).toHaveBeenCalledTimes(1);
    });
    it('applies an explicit VLAN pool and preserves it in subsequent sibling updates', async () => {
        expect(await ops.updateApSsidOverride(mac, 1, { overrideVlanEnable: true, vlanPoolIds: '12,42' }, undefined, false)).toMatchObject({
            verified: true,
        });
        await ops.updateApSsidOverride(mac, 2, { ssidEnable: false }, undefined, false);
        expect(request.request.mock.calls[1][0].data.ssidOverrides[0]).toMatchObject({ overrideVlanEnable: true, vlanPoolIds: '12,42' });
    });
    it('does not guess a hidden active sibling password', async () => {
        config[1].psk = '********';
        await expect(ops.updateApSsidOverride(mac, 1, { ssidEnable: false }, undefined, false)).rejects.toThrow('actual overrideSsidPassword');
        expect(request.request).not.toHaveBeenCalled();
    });
    it('verifies no-ops without sending a PATCH', async () => {
        expect(await ops.updateApSsidOverride(mac, 1, { ssidEnable: true }, undefined, false)).toMatchObject({
            written: false,
            verified: true,
            changes: [],
        });
        expect(request.request).not.toHaveBeenCalled();
    });
    it('retains useful effective reads without web credentials but blocks mutations', async () => {
        const readOnly = new ApSsidOverrideOperations(
            request as unknown as RequestHandler,
            { resolveSiteId: () => 'site' } as unknown as SiteOperations,
            (p) => p
        );
        expect(await readOnly.getApSsidOverrides(mac)).toMatchObject({ configurationSource: 'unavailable' });
        await expect(readOnly.updateApSsidOverride(mac, 1, { ssidEnable: false }, undefined, false)).rejects.toThrow('web API credentials');
        expect(request.request).not.toHaveBeenCalled();
    });
    it('rejects changed configuration before applying', async () => {
        internal.get
            .mockImplementationOnce(async () => ({ errorCode: 0, result: { wlanId: 'wlan', ssidOverrides: structuredClone(config) } }))
            .mockImplementationOnce(() => {
                config[1].ssidEnable = false;
                return Promise.resolve({ errorCode: 0, result: { wlanId: 'wlan', ssidOverrides: structuredClone(config) } });
            });
        await expect(ops.updateApSsidOverride(mac, 1, { ssidEnable: false }, undefined, false)).rejects.toThrow('changed during preflight');
        expect(request.request).not.toHaveBeenCalled();
    });
    it('reconciles an applied write after a lost response without replay', async () => {
        const write = request.request.getMockImplementation()!;
        request.request.mockImplementation(async (args) => {
            await write(args);
            throw new Error('response lost');
        });
        expect(await ops.updateApSsidOverride(mac, 1, { ssidEnable: false }, undefined, false)).toMatchObject({
            written: 'unknown',
            verified: true,
            acknowledgement: 'unknown',
        });
        expect(request.request).toHaveBeenCalledTimes(1);
    });
    it('reports an uncertain unapplied write without replay', async () => {
        request.request.mockRejectedValue(new Error('connection lost'));
        expect(await ops.updateApSsidOverride(mac, 1, { ssidEnable: false }, undefined, false)).toMatchObject({
            written: 'unknown',
            verified: false,
            verification: { status: 'mismatch' },
        });
        expect(request.request).toHaveBeenCalledTimes(1);
    });
    it('detects unexpected changes to a sibling after a successful target change', async () => {
        const write = request.request.getMockImplementation()!;
        request.request.mockImplementation(async (args) => {
            await write(args);
            config[1].vlanId = 99;
            return { errorCode: 0 };
        });
        expect(await ops.updateApSsidOverride(mac, 1, { ssidEnable: false }, undefined, false)).toMatchObject({
            written: true,
            verified: false,
            verification: { status: 'mismatch' },
        });
    });
    it('propagates an explicit controller rejection without treating it as an uncertain write', async () => {
        request.request.mockResolvedValue({ errorCode: -1001 });
        await expect(ops.updateApSsidOverride(mac, 1, { ssidEnable: false }, undefined, false)).rejects.toThrow('Controller rejected');
        expect(request.request).toHaveBeenCalledTimes(1);
    });
    it.each([
        [
            'missing flags',
            () => {
                delete (config[0] as Partial<(typeof config)[0]>).enable;
            },
        ],
        [
            'duplicate IDs',
            () => {
                config[1].index = 1;
            },
        ],
        [
            'unknown capability',
            () => {
                config[0].ssidConfigurable = false;
            },
        ],
    ])('blocks incomplete preservation evidence: %s', async (_label, amend) => {
        amend();
        await expect(ops.updateApSsidOverride(mac, 1, { ssidEnable: false }, undefined, false)).rejects.toThrow();
        expect(request.request).not.toHaveBeenCalled();
    });
    it.each([
        {},
        { extra: true },
        { overrideSsidName: '界'.repeat(11) },
        { overrideSsidPassword: 'short' },
        { vlanId: 4095 },
        { overrideSsidEnable: true, overrideSsidName: '' },
    ])('rejects invalid typed settings %j', async (settings) => {
        await expect(ops.updateApSsidOverride(mac, 1, settings as never)).rejects.toThrow();
        expect(request.request).not.toHaveBeenCalled();
    });
    it.each([{ overrideSsidName: 'No effect' }, { vlanId: 15 }, { overrideVlanEnable: true }])(
        'rejects inactive or incomplete overrides %j',
        async (settings) => {
            await expect(ops.updateApSsidOverride(mac, 1, settings)).rejects.toThrow();
            expect(request.request).not.toHaveBeenCalled();
        }
    );
    it('rejects missing targets and invalid addresses', async () => {
        await expect(ops.updateApSsidOverride(mac, 99, { ssidEnable: false })).rejects.toThrow('does not exist');
        await expect(ops.updateApSsidOverride('../bad', 1, { ssidEnable: false })).rejects.toThrow();
        expect(request.request).not.toHaveBeenCalled();
    });
});
