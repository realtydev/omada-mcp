import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestHandler } from '../../src/omadaClient/request.js';
import type { SiteOperations } from '../../src/omadaClient/site.js';
import { SwitchOperations } from '../../src/omadaClient/switch.js';
import type { OmadaApiResponse } from '../../src/types/index.js';

describe('SwitchOperations', () => {
    let switchOps: SwitchOperations;
    let mockRequest: RequestHandler;
    let mockSite: SiteOperations;
    let mockBuildPath: (path: string, version?: string) => string;

    beforeEach(() => {
        mockRequest = {
            get: vi.fn().mockResolvedValue({
                errorCode: 0,
                result: {
                    mac: 'D8-44-89-C3-00-04',
                    portList: Array.from({ length: 4 }, (_, index) => ({
                        port: index + 1,
                        name: `Port ${index + 1}`,
                        profileId: 'old-profile',
                        profileOverrideEnable: true,
                        poeMode: 0,
                        lagPort: false,
                        status: 1,
                    })),
                },
            }),
            request: vi.fn().mockResolvedValue({ errorCode: 0, result: {} }),
            post: vi.fn(),
            put: vi.fn(),
            delete: vi.fn(),
            fetchPaginated: vi.fn().mockResolvedValue(
                Array.from({ length: 4 }, (_, index) => ({
                    switchMac: 'D8-44-89-C3-00-04',
                    port: index + 1,
                    supportPoe: true,
                    configStack: false,
                    configMlagPeerLink: false,
                    configMlagDad: false,
                }))
            ),
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

        switchOps = new SwitchOperations(mockRequest, mockSite, mockBuildPath);
    });

    describe('getSwitchNetworks', () => {
        it('fetches all pages, since the endpoint 400s without page/pageSize', async () => {
            const mockData = [
                { id: 'net1', vlan: 1, name: 'Default' },
                { id: 'net2', vlan: 20, name: 'IoT VLAN' },
            ];

            vi.mocked(mockRequest.fetchPaginated).mockResolvedValue(mockData);

            const result = await switchOps.getSwitchNetworks('D8-44-89-C3-00-04', 'site-123');

            expect(mockRequest.fetchPaginated).toHaveBeenCalledWith('/openapi/v1/test-omadac/sites/site-123/switches/D8-44-89-C3-00-04/networks');
            expect(mockRequest.get).not.toHaveBeenCalled();
            expect(result).toEqual(mockData);
        });
    });

    describe('getSwitch', () => {
        it('fetches full switch info by MAC', async () => {
            const mockSwitch = { mac: 'D8-44-89-C3-00-04', portList: [] };
            vi.mocked(mockRequest.get).mockResolvedValue({ errorCode: 0, result: mockSwitch });

            const result = await switchOps.getSwitch('D8-44-89-C3-00-04', 'site-123');

            expect(mockRequest.get).toHaveBeenCalledWith('/openapi/v1/test-omadac/sites/site-123/switches/D8-44-89-C3-00-04');
            expect(result).toEqual(mockSwitch);
        });
    });

    describe('listSwitchPorts', () => {
        it('fetches the paginated site-wide port telemetry endpoint', async () => {
            const mockPorts = [
                { switchMac: 'AA-BB-CC-DD-EE-FF', port: 1, portStatus: { linkStatus: 1 } },
                { switchMac: '11-22-33-44-55-66', port: 1, portStatus: { linkStatus: 0 } },
            ];
            vi.mocked(mockRequest.fetchPaginated).mockResolvedValue(mockPorts);

            const result = await switchOps.listSwitchPorts(undefined, 'site-123');

            expect(mockRequest.fetchPaginated).toHaveBeenCalledWith('/openapi/v1/test-omadac/sites/site-123/switches/ports/poe-info');
            expect(result).toEqual(mockPorts);
        });

        it('uses the default site and safely ignores rows without a switch MAC when filtering', async () => {
            vi.mocked(mockRequest.fetchPaginated).mockResolvedValue([{ port: 1 }, { switchMac: 'AA-BB-CC-DD-EE-FF', port: 2 }]);
            await expect(switchOps.listSwitchPorts('aa-bb-cc-dd-ee-ff')).resolves.toEqual([{ switchMac: 'AA-BB-CC-DD-EE-FF', port: 2 }]);
            expect(mockRequest.fetchPaginated).toHaveBeenCalledWith('/openapi/v1/test-omadac/sites/default-site/switches/ports/poe-info');
        });

        it('encodes site IDs and propagates pagination errors', async () => {
            vi.mocked(mockRequest.fetchPaginated).mockRejectedValue(new Error('Unsupported endpoint'));
            await expect(switchOps.listSwitchPorts(undefined, 'site/one')).rejects.toThrow('Unsupported endpoint');
            expect(mockRequest.fetchPaginated).toHaveBeenCalledWith('/openapi/v1/test-omadac/sites/site%2Fone/switches/ports/poe-info');
        });

        it('returns an empty filter result when the controller omits a non-PoE switch', async () => {
            vi.mocked(mockRequest.fetchPaginated).mockResolvedValue([{ switchMac: 'AA-BB-CC-DD-EE-FF', port: 1 }]);
            await expect(switchOps.listSwitchPorts('11-22-33-44-55-66', 'site-123')).resolves.toEqual([]);
        });

        it('filters port telemetry by switch MAC case-insensitively', async () => {
            const mockPorts = [
                { switchMac: 'AA-BB-CC-DD-EE-FF', port: 1 },
                { switchMac: '11-22-33-44-55-66', port: 1 },
            ];
            vi.mocked(mockRequest.fetchPaginated).mockResolvedValue(mockPorts);

            const result = await switchOps.listSwitchPorts('aa-bb-cc-dd-ee-ff', 'site-123');

            expect(result).toEqual([{ switchMac: 'AA-BB-CC-DD-EE-FF', port: 1 }]);
        });
    });

    it.each([
        ['setSwitchPortProfile', [3, 'profile-1'], 'ports/3/profile', { profileId: 'profile-1' }],
        ['setSwitchPortPoe', [3, 1], 'ports/3/poe-mode', { poeMode: 1 }],
        ['setSwitchPortName', [3, 'Uplink'], 'ports/3/name', { name: 'Uplink' }],
        ['setSwitchPortStatus', [3, 0], 'ports/3/status', { status: 0 }],
        ['setSwitchPortProfileOverride', [3, false], 'ports/3/profile-override', { profileOverrideEnable: false }],
        ['batchSetSwitchPortProfile', [[1, 2, 3], false], 'multi-ports/profile-override', { portList: [1, 2, 3], profileOverrideEnable: false }],
        ['batchSetSwitchPortPoe', [[1, 2, 3], 1], 'multi-ports/poe-mode', { portList: [1, 2, 3], poeMode: 1 }],
        ['batchSetSwitchPortStatus', [[1, 2, 3], 0], 'multi-ports/status', { portList: [1, 2, 3], status: 0 }],
        ['batchSetSwitchPortName', [[{ port: 1, name: 'Uplink' }]], 'multi-ports/name', { portNameList: [{ port: 1, name: 'Uplink' }] }],
    ])('uses the documented guarded endpoint for %s', async (method, args, suffix, data) => {
        const invoke = switchOps[method as keyof SwitchOperations] as (...args: unknown[]) => Promise<unknown>;
        await invoke.call(switchOps, 'D8-44-89-C3-00-04', ...(args as unknown[]), 'site-123');
        expect(mockRequest.request).toHaveBeenCalledExactlyOnceWith(
            { method: 'PUT', url: `/openapi/v1/test-omadac/sites/site-123/switches/D8-44-89-C3-00-04/${suffix}`, data },
            false
        );
        expect(mockRequest.put).not.toHaveBeenCalled();
    });

    describe('startCableTest', () => {
        it('starts a cable test on a switch', async () => {
            vi.mocked(mockRequest.post).mockResolvedValue({ errorCode: 0, result: {} });

            await switchOps.startCableTest('D8-44-89-C3-00-04', 'site-123');

            expect(mockRequest.post).toHaveBeenCalledWith('/openapi/v1/test-omadac/sites/site-123/cable-test/switches/D8-44-89-C3-00-04/start', {});
        });
    });

    describe('getCableTestResults', () => {
        it('gets cable test results for a switch', async () => {
            const mockResults = { status: 'completed', ports: [] };
            vi.mocked(mockRequest.get).mockResolvedValue({ errorCode: 0, result: mockResults });

            const result = await switchOps.getCableTestResults('D8-44-89-C3-00-04', 'site-123');

            expect(mockRequest.get).toHaveBeenCalledWith('/openapi/v1/test-omadac/sites/site-123/cable-test/switches/D8-44-89-C3-00-04/full-results');
            expect(result).toEqual(mockResults);
        });
    });

    describe('setSwitchNetworks', () => {
        it('sets switch networks / VLAN trunking config', async () => {
            vi.mocked(mockRequest.post).mockResolvedValue({ errorCode: 0, result: {} });

            const data = { vlanTrunk: true };
            await switchOps.setSwitchNetworks('D8-44-89-C3-00-04', data, 'site-123');

            expect(mockRequest.post).toHaveBeenCalledWith('/openapi/v1/test-omadac/sites/site-123/switches/D8-44-89-C3-00-04/networks', data);
        });
    });
});
