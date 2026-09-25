import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApRadioOperations } from '../../src/omadaClient/apRadio.js';
import type { RequestHandler } from '../../src/omadaClient/request.js';
import type { SiteOperations } from '../../src/omadaClient/site.js';
import type { OmadaApiResponse } from '../../src/types/index.js';

const MAC = 'AA-BB-CC-DD-EE-FF';
const band5g = (overrides: Record<string, unknown> = {}) => ({
    radioEnable: true,
    channelRange: [],
    channelWidth: '5',
    channel: '1',
    txPower: 19,
    txPowerLevel: 3,
    freq: 5180,
    wirelessMode: -2,
    autoSwitchOffWifi: false,
    ...overrides,
});
const config = (bandOverrides: Record<string, unknown> = {}) => ({
    radioSetting2g: { radioEnable: true, channelWidth: '2', channel: '6', txPower: 24, txPowerLevel: 3, freq: 2437, wirelessMode: -2 },
    radioSetting5g: band5g(bandOverrides),
});
const availableChannels = [
    { radioId: 0, apChannelDetailList: [{ channel: 1, freq: 2412, index: 1 }] },
    {
        radioId: 1,
        apChannelDetailList: [
            { channel: 36, freq: 5180, index: 1 },
            { channel: 40, freq: 5200, index: 2 },
            { channel: 149, freq: 5745, index: 17 },
        ],
    },
];
const ok = (result: unknown): OmadaApiResponse<unknown> => ({ errorCode: 0, result });

describe('ApRadioOperations', () => {
    let mockRequest: RequestHandler;
    let ops: ApRadioOperations;
    const configPath = `/openapi/v1/test-omadac/sites/site-1/aps/${MAC}/radio-config`;
    const channelPath = `/openapi/v1/test-omadac/sites/site-1/aps/${MAC}/available-channel`;

    /** radio-config GETs return the queued states in order (the last repeats); available-channel returns the fixture. */
    const queueConfigs = (...states: unknown[]) => {
        let call = 0;
        vi.mocked(mockRequest.get).mockImplementation((path: string) => {
            if (path === channelPath) {
                return Promise.resolve(ok(availableChannels));
            }
            return Promise.resolve(ok(states[Math.min(call++, states.length - 1)]));
        });
    };
    const patchBody = () => vi.mocked(mockRequest.request).mock.calls[0][0].data;

    beforeEach(() => {
        vi.useFakeTimers();
        mockRequest = {
            get: vi.fn(),
            request: vi.fn().mockResolvedValue(ok(null)),
            ensureSuccess: vi.fn((response: OmadaApiResponse<unknown>) => {
                if (response.errorCode === 0) {
                    return response.result ?? {};
                }
                throw new Error(response.msg ?? 'API Error');
            }),
        } as unknown as RequestHandler;
        const site = { resolveSiteId: vi.fn((siteId?: string) => siteId ?? 'default-site') } as unknown as SiteOperations;
        ops = new ApRadioOperations(mockRequest, site, (path: string) => `/openapi/v1/test-omadac${path}`);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('input validation', () => {
        it('should reject an empty settings object before any request', async () => {
            await expect(ops.setApRadio(MAC, '5g', {}, 'site-1')).rejects.toThrow('At least one radio setting');
            expect(mockRequest.get).not.toHaveBeenCalled();
        });

        it('should reject txPower combined with a non-custom level before any request', async () => {
            await expect(ops.setApRadio(MAC, '5g', { txPower: 23, txPowerLevel: 2 }, 'site-1')).rejects.toThrow('txPowerLevel 3');
            expect(mockRequest.get).not.toHaveBeenCalled();
        });

        it('should reject a band the AP does not have', async () => {
            queueConfigs(config());

            await expect(ops.setApRadio(MAC, '6g', { radioEnable: false }, 'site-1')).rejects.toThrow(
                'has no 6g radio (radio-config has: radioSetting2g, radioSetting5g)'
            );
            expect(mockRequest.request).not.toHaveBeenCalled();
        });

        it('should reject a channel index that is not available and list the valid ones', async () => {
            queueConfigs(config());

            await expect(ops.setApRadio(MAC, '5g', { channel: 36 }, 'site-1')).rejects.toThrow(
                'Channel index 36 is not available on the 5g radio of AA-BB-CC-DD-EE-FF. `channel` is the channel INDEX, not the channel number. Available: 1 (channel 36, 5180 MHz), 2 (channel 40, 5200 MHz), 17 (channel 149, 5745 MHz).'
            );
            expect(mockRequest.request).not.toHaveBeenCalled();
        });
    });

    describe('dryRun and no-op', () => {
        it('should return the diff and the complete request body without writing on dryRun', async () => {
            queueConfigs(config());

            const result = await ops.setApRadio(MAC, '5g', { txPower: 23 }, 'site-1', true);

            expect(mockRequest.request).not.toHaveBeenCalled();
            expect(result).toEqual({
                dryRun: true,
                written: false,
                band: '5g',
                changes: [{ field: 'txPower', before: 19, after: 23 }],
                requestBody: {
                    radioSetting5g: {
                        radioEnable: true,
                        channelRange: [],
                        channelWidth: '5',
                        channel: '1',
                        txPower: 23,
                        txPowerLevel: 3,
                        freq: 5180,
                        wirelessMode: -2,
                    },
                },
            });
        });

        it('should not write when every requested value is already set', async () => {
            queueConfigs(config());

            const result = await ops.setApRadio(MAC, '5g', { txPower: 19 }, 'site-1');

            expect(mockRequest.request).not.toHaveBeenCalled();
            expect(result).toEqual({ dryRun: false, written: false, band: '5g', changes: [] });
        });
    });

    describe('write', () => {
        it('should PATCH the complete band (without autoSwitchOffWifi) with only the requested fields changed, then verify', async () => {
            queueConfigs(config(), config({ txPower: 23 }));

            const result = await ops.setApRadio(MAC, '5g', { txPower: 23 }, 'site-1');

            expect(mockRequest.request).toHaveBeenCalledWith({
                method: 'PATCH',
                url: configPath,
                data: {
                    radioSetting5g: {
                        radioEnable: true,
                        channelRange: [],
                        channelWidth: '5',
                        channel: '1',
                        txPower: 23,
                        txPowerLevel: 3,
                        freq: 5180,
                        wirelessMode: -2,
                    },
                },
            });
            expect(result).toEqual({
                dryRun: false,
                written: true,
                band: '5g',
                changes: [{ field: 'txPower', before: 19, after: 23 }],
                verification: { ok: true, unexpectedChanges: [] },
            });
        });

        it('should set freq from the available-channel list when the channel index changes', async () => {
            queueConfigs(config(), config({ channel: '2', freq: 5200 }));

            const result = await ops.setApRadio(MAC, '5g', { channel: 2 }, 'site-1');

            expect(patchBody()).toEqual({ radioSetting5g: expect.objectContaining({ channel: '2', freq: 5200 }) });
            expect(result.verification).toEqual({ ok: true, unexpectedChanges: [] });
        });

        it('should drop freq from the body for auto channel (0) so it cannot pull the channel back', async () => {
            queueConfigs(config(), config({ channel: '0' }));

            await ops.setApRadio(MAC, '5g', { channel: 0 }, 'site-1');

            const band = (patchBody() as { radioSetting5g: Record<string, unknown> }).radioSetting5g;
            expect(band.channel).toBe('0');
            expect(band).not.toHaveProperty('freq');
            expect(mockRequest.get).not.toHaveBeenCalledWith(channelPath);
        });

        it('should convert channelWidth to the string code and imply txPowerLevel 3 with txPower', async () => {
            queueConfigs(config({ txPowerLevel: 0 }), config({ channelWidth: '3', txPower: 20, txPowerLevel: 3 }));

            const result = await ops.setApRadio(MAC, '5g', { channelWidth: 3, txPower: 20 }, 'site-1');

            expect(patchBody()).toEqual({ radioSetting5g: expect.objectContaining({ channelWidth: '3', txPower: 20, txPowerLevel: 3 }) });
            expect(result.changes.map((c) => c.field)).toEqual(['channelWidth', 'txPowerLevel', 'txPower']);
        });

        it('should report the value read back after the write as `after`', async () => {
            queueConfigs(config(), config({ txPower: 23 }));

            const result = await ops.setApRadio(MAC, '5g', { txPower: 23 }, 'site-1');

            expect(result.changes[0]).toEqual({ field: 'txPower', before: 19, after: 23 });
        });
    });

    describe('verification', () => {
        it('should fail loudly with the kept value when the controller answers success but does not apply', async () => {
            queueConfigs(config());

            const pending = ops.setApRadio(MAC, '5g', { txPower: 23 }, 'site-1');
            const assertion = expect(pending).rejects.toThrow(
                'accepted the 5g radio-config PATCH for AA-BB-CC-DD-EE-FF (errorCode 0) but did not apply: txPower: requested 23, controller kept 19'
            );
            await vi.runAllTimersAsync();
            await assertion;

            expect(mockRequest.request).toHaveBeenCalledTimes(1);
            expect(mockRequest.get).toHaveBeenCalledTimes(4); // initial read + 3 verification reads
        });

        it('should accept a value that only shows up on a later re-read', async () => {
            queueConfigs(config(), config(), config({ txPower: 23 }));

            const pending = ops.setApRadio(MAC, '5g', { txPower: 23 }, 'site-1');
            await vi.runAllTimersAsync();
            const result = await pending;

            expect(result.verification?.ok).toBe(true);
        });

        it('should flag other band fields and other bands that changed as unexpected', async () => {
            const changedOther = { ...config({ txPower: 23, wirelessMode: 16 }), radioSetting2g: { ...config().radioSetting2g, txPower: 20 } };
            queueConfigs(config(), changedOther);

            const result = await ops.setApRadio(MAC, '5g', { txPower: 23 }, 'site-1');

            expect(result.verification).toEqual({ ok: false, unexpectedChanges: ['radioSetting5g.wirelessMode', 'radioSetting2g'] });
        });

        it('should propagate a controller error from the PATCH and not re-read', async () => {
            queueConfigs(config());
            vi.mocked(mockRequest.request).mockResolvedValue({ errorCode: -39303, msg: 'AP does not exist.' });

            await expect(ops.setApRadio(MAC, '5g', { txPower: 23 }, 'site-1')).rejects.toThrow('AP does not exist.');
            expect(mockRequest.get).toHaveBeenCalledTimes(1);
        });
    });
});
