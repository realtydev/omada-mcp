import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ActionOperations } from '../../src/omadaClient/action.js';
import type { RequestHandler } from '../../src/omadaClient/request.js';
import type { SiteOperations } from '../../src/omadaClient/site.js';
import type { OmadaApiResponse } from '../../src/types/index.js';

describe('ActionOperations', () => {
    let actionOps: ActionOperations;
    let mockRequest: RequestHandler;
    let mockSite: SiteOperations;
    let mockBuildPath: (path: string, version?: string) => string;

    beforeEach(() => {
        mockRequest = {
            get: vi.fn(),
            post: vi.fn(),
            put: vi.fn(),
            request: vi.fn(),
            ensureSuccess: vi.fn((response: OmadaApiResponse<unknown>) => {
                if (response.errorCode === 0) {
                    return response.result;
                }
                throw new Error(response.msg ?? 'API Error');
            }),
        } as unknown as RequestHandler;

        mockSite = {
            resolveSiteId: vi.fn((siteId?: string) => siteId ?? 'default-site'),
        } as unknown as SiteOperations;

        mockBuildPath = vi.fn((path: string, version = 'v1') => `/openapi/${version}/test-omadac${path}`);

        actionOps = new ActionOperations(mockRequest, mockSite, mockBuildPath);
    });

    it('adopts a single device through start-adopt with optional device credentials', async () => {
        vi.mocked(mockRequest.post).mockResolvedValue({ errorCode: 0, result: { accepted: true } });
        await actionOps.adoptDevice('aa/bb', 'site/1', { username: 'admin', password: 'device-password' });
        expect(mockRequest.post).toHaveBeenCalledWith('/openapi/v1/test-omadac/sites/site%2F1/devices/aa%2Fbb/start-adopt', {
            username: 'admin',
            password: 'device-password',
        });
    });

    it('rejects invalid device credentials without sending a request', async () => {
        await expect(actionOps.adoptDevice('mac', undefined, { password: '' })).rejects.toThrow('1 to 64');
        expect(mockRequest.post).not.toHaveBeenCalled();
    });

    it('starts online firmware upgrade with no fabricated request body', async () => {
        vi.mocked(mockRequest.post).mockResolvedValue({ errorCode: 0, result: {} });
        await actionOps.startFirmwareUpgrade('mac', 'site');
        expect(mockRequest.post).toHaveBeenCalledWith('/openapi/v1/test-omadac/sites/site/devices/mac/start-online-upgrade', undefined);
    });

    it('rejects unsupported per-device LED settings without substituting a site-wide action', async () => {
        await expect(actionOps.setDeviceLed('mac', 0, 'site')).rejects.toThrow('Per-device LED settings are not supported');
        expect(mockRequest.post).not.toHaveBeenCalled();
        expect(mockRequest.put).not.toHaveBeenCalled();
    });

    it.each([true, false])('locates one device with enable=%s', async (enable) => {
        vi.mocked(mockRequest.post).mockResolvedValue({ errorCode: 0, result: {} });
        await actionOps.locateDevice('aa/bb', enable, 'site/1');
        expect(mockRequest.post).toHaveBeenCalledWith('/openapi/v1/test-omadac/sites/site%2F1/devices/aa%2Fbb/locate', { locateEnable: enable });
        expect(mockRequest.put).not.toHaveBeenCalled();
    });

    it.each([true, false])('sets the site-wide LED policy with enable=%s', async (enable) => {
        vi.mocked(mockRequest.put).mockResolvedValue({ errorCode: 0, result: {} });
        await actionOps.setSiteLed(enable, 'site/1');
        expect(mockRequest.put).toHaveBeenCalledWith('/openapi/v1/test-omadac/sites/site%2F1/led', { enable });
        expect(mockRequest.post).not.toHaveBeenCalled();
    });

    describe('updateClient', () => {
        const rateLimit = { enable: true, upEnable: true, upLimit: 10, upUnit: 2, downEnable: true, downLimit: 100, downUnit: 2 };
        const ipSetting = { useFixedAddr: false, netId: 'lan-1', serverMac: 'AA-BB-CC-DD-EE-FF', serverType: 'gateway' };

        beforeEach(() => {
            vi.mocked(mockRequest.get).mockResolvedValue({ errorCode: 0, result: { rateLimit, ipSetting } });
            vi.mocked(mockRequest.request).mockResolvedValue({ errorCode: 0, result: {} });
        });

        it.each([{ name: 'valid', unsupported: true }, { name: 'valid', fixedIp: '999.1.2.3' }, { name: 'valid', upLimit: 1025 }, {}])(
            'validates all fields before any reads or writes: %j',
            async (data) => {
                await expect(actionOps.updateClient('mac', data)).rejects.toThrow();
                expect(mockRequest.request).not.toHaveBeenCalled();
                expect(mockRequest.get).not.toHaveBeenCalled();
            }
        );

        it('updates only the name endpoint without needing unrelated settings', async () => {
            const result = await actionOps.updateClient('mac', { name: 'Laptop' }, 'site');
            expect(mockRequest.request).toHaveBeenCalledExactlyOnceWith({
                method: 'PATCH',
                url: '/openapi/v1/test-omadac/sites/site/clients/mac/name',
                data: { name: 'Laptop' },
            });
            expect(mockRequest.get).not.toHaveBeenCalled();
            expect(result).toMatchObject({ written: true, completed: ['name'] });
        });

        it('preserves an unspecified rate-limit direction and uses the mode/custom contract', async () => {
            await actionOps.updateClient('mac', { upLimit: 512 }, 'site');
            expect(mockRequest.request).toHaveBeenCalledExactlyOnceWith({
                method: 'PATCH',
                url: '/openapi/v1/test-omadac/sites/site/clients/mac/ratelimit',
                data: { mode: 0, customRateLimit: { upEnable: true, upLimit: 512, upUnit: 1, downEnable: true, downLimit: 100, downUnit: 2 } },
            });
        });

        it('re-enables stored directions when explicitly enabling a disabled custom rate limit', async () => {
            vi.mocked(mockRequest.get).mockResolvedValue({ errorCode: 0, result: { rateLimit: { ...rateLimit, enable: false, downEnable: false } } });
            await actionOps.updateClient('mac', { rateLimitEnable: true });
            expect(mockRequest.request).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: {
                        mode: 0,
                        customRateLimit: {
                            upEnable: true,
                            upLimit: 10,
                            upUnit: 2,
                            downEnable: false,
                            downLimit: 100,
                            downUnit: 2,
                        },
                    },
                })
            );
        });

        it('does not re-enable unrelated stored directions when changing only one limit', async () => {
            vi.mocked(mockRequest.get).mockResolvedValue({ errorCode: 0, result: { rateLimit: { ...rateLimit, enable: false } } });
            await actionOps.updateClient('mac', { upLimit: 512 });
            expect(mockRequest.request).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: {
                        mode: 0,
                        customRateLimit: {
                            upEnable: true,
                            upLimit: 512,
                            upUnit: 1,
                            downEnable: false,
                            downLimit: 100,
                            downUnit: 2,
                        },
                    },
                })
            );
        });

        it('previews IP changes preserving DHCP server identifiers without writing', async () => {
            const result = await actionOps.updateClient('mac', { name: 'Laptop', fixedIp: '192.0.2.10' }, 'site', true);
            expect(result).toMatchObject({
                dryRun: true,
                written: false,
                operations: [
                    { setting: 'name', body: { name: 'Laptop' } },
                    {
                        setting: 'fixedIp',
                        path: '/openapi/v1/test-omadac/network/sites/site/cmd/clients/mac/update-ipSetting',
                        body: { useFixedAddr: true, ip: '192.0.2.10', netId: 'lan-1', serverMac: 'AA-BB-CC-DD-EE-FF', serverType: 'gateway' },
                    },
                ],
            });
            expect(mockRequest.request).not.toHaveBeenCalled();
        });

        it('disables a fixed address without carrying the old address into the write', async () => {
            await actionOps.updateClient('mac', { fixedIp: '' }, 'site');
            expect(mockRequest.request).toHaveBeenCalledWith(expect.objectContaining({ data: { ...ipSetting, useFixedAddr: false } }));
        });

        it('fails a missing preservation snapshot before writing the otherwise valid name', async () => {
            vi.mocked(mockRequest.get).mockResolvedValue({ errorCode: 0, result: {} });
            await expect(actionOps.updateClient('mac', { name: 'Laptop', fixedIp: '192.0.2.10' })).rejects.toThrow('preserve');
            expect(mockRequest.request).not.toHaveBeenCalled();
        });

        it('refuses an unrecognized DHCP server identifier type instead of silently dropping it', async () => {
            vi.mocked(mockRequest.get).mockResolvedValue({ errorCode: 0, result: { ipSetting: { ...ipSetting, serverType: 1 } } });
            await expect(actionOps.updateClient('mac', { name: 'Laptop', fixedIp: '192.0.2.10' })).rejects.toThrow('IP setting serverType');
            expect(mockRequest.request).not.toHaveBeenCalled();
        });

        it('requires explicit replacement when a rate-limit profile is active', async () => {
            vi.mocked(mockRequest.get).mockResolvedValue({ errorCode: 0, result: { rateLimit: { ...rateLimit, rateLimitId: 'profile-1' } } });
            await expect(actionOps.updateClient('mac', { name: 'Laptop', upLimit: 10 })).rejects.toThrow('profile');
            expect(mockRequest.request).not.toHaveBeenCalled();
        });

        it('accepts an explicit complete custom configuration including Mbps units', async () => {
            const customRateLimit = { upEnable: true, upLimit: 1000, upUnit: 2, downEnable: false, downLimit: 1, downUnit: 1 };
            await actionOps.updateClient('mac', { rateLimit: { mode: 0, customRateLimit } });
            expect(mockRequest.get).not.toHaveBeenCalled();
            expect(mockRequest.request).toHaveBeenCalledWith(expect.objectContaining({ data: { mode: 0, customRateLimit } }));
        });

        it('accepts an existing rate-limit profile', async () => {
            await actionOps.updateClient('mac', { rateLimit: { mode: 1, rateLimitProfileId: 'profile-1' } });
            expect(mockRequest.request).toHaveBeenCalledWith(expect.objectContaining({ data: { mode: 1, rateLimitProfileId: 'profile-1' } }));
        });

        it('rejects conflicting or incomplete rate settings before any request', async () => {
            await expect(actionOps.updateClient('mac', { rateLimit: { mode: 1, rateLimitProfileId: 'p' }, upLimit: 10 })).rejects.toThrow();
            await expect(actionOps.updateClient('mac', { rateLimit: { mode: 0, customRateLimit: { upEnable: false } } })).rejects.toThrow();
            expect(mockRequest.request).not.toHaveBeenCalled();
            expect(mockRequest.get).not.toHaveBeenCalled();
        });

        it('identifies partial completion and stops rather than replaying uncertain writes', async () => {
            vi.mocked(mockRequest.request).mockResolvedValueOnce({ errorCode: 0, result: {} }).mockRejectedValueOnce(new Error('timeout'));
            await expect(actionOps.updateClient('mac', { name: 'Laptop', upLimit: 100, fixedIp: '192.0.2.10' })).rejects.toThrow(
                'failed at rateLimit; completed settings: name'
            );
            expect(mockRequest.request).toHaveBeenCalledTimes(2);
        });

        it('preserves HTTP and controller error details in the surfaced partial-failure message', async () => {
            vi.mocked(mockRequest.request).mockRejectedValue(new Error('PATCH /name (HTTP 403) (errorCode: -41011) - Client does not exist'));
            await expect(actionOps.updateClient('mac', { name: 'Laptop' })).rejects.toThrow('(HTTP 403) (errorCode: -41011)');
            expect(mockRequest.request).toHaveBeenCalledTimes(1);
        });
    });

    describe('getFirmwareDetails', () => {
        it('should fetch firmware details from the latest-firmware-info endpoint', async () => {
            const mockData = { currentVersion: '1.0.0', lastVersion: '1.1.0' };
            const mockResponse: OmadaApiResponse<unknown> = {
                errorCode: 0,
                result: mockData,
            };

            vi.mocked(mockRequest.get).mockResolvedValue(mockResponse);

            const result = await actionOps.getFirmwareDetails('AA-BB-CC-DD-EE-FF', 'site-123');

            expect(mockRequest.get).toHaveBeenCalledWith('/openapi/v1/test-omadac/sites/site-123/devices/AA-BB-CC-DD-EE-FF/latest-firmware-info');
            expect(result).toEqual(mockData);
        });
    });

    describe('setGatewayWanConnect', () => {
        it.each([
            ['disconnect', 0],
            ['connect', 1],
        ] as const)('posts %s to the internet-state endpoint as operation %i', async (action, operation) => {
            vi.mocked(mockRequest.post).mockResolvedValue({ errorCode: 0, result: {} });

            await actionOps.setGatewayWanConnect('AA-BB-CC-DD-EE-FF', 2, action, 'site-123');

            expect(mockRequest.post).toHaveBeenCalledWith('/openapi/v1/test-omadac/sites/site-123/gateways/AA-BB-CC-DD-EE-FF/internet-state', {
                portId: 2,
                operation,
            });
        });
    });
});
