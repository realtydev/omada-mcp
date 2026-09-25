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
            get: vi.fn(),
            post: vi.fn(),
            put: vi.fn(),
            delete: vi.fn(),
            fetchPaginated: vi.fn(),
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

    describe('setSwitchPortProfile', () => {
        it('sets a LAN profile on a single port', async () => {
            vi.mocked(mockRequest.put).mockResolvedValue({ errorCode: 0, result: {} });

            await switchOps.setSwitchPortProfile('D8-44-89-C3-00-04', 3, 'profile-1', 'site-123');

            expect(mockRequest.put).toHaveBeenCalledWith('/openapi/v1/test-omadac/sites/site-123/switches/D8-44-89-C3-00-04/ports/3/profile', {
                profileId: 'profile-1',
            });
        });
    });

    describe('setSwitchPortPoe', () => {
        it('sets PoE mode on a single port', async () => {
            vi.mocked(mockRequest.put).mockResolvedValue({ errorCode: 0, result: {} });

            await switchOps.setSwitchPortPoe('D8-44-89-C3-00-04', 3, 1, 'site-123');

            expect(mockRequest.put).toHaveBeenCalledWith('/openapi/v1/test-omadac/sites/site-123/switches/D8-44-89-C3-00-04/ports/3/poe-mode', {
                poeMode: 1,
            });
        });
    });

    describe('setSwitchPortName', () => {
        it('sets the name on a single port', async () => {
            vi.mocked(mockRequest.put).mockResolvedValue({ errorCode: 0, result: {} });

            await switchOps.setSwitchPortName('D8-44-89-C3-00-04', 3, 'Uplink', 'site-123');

            expect(mockRequest.put).toHaveBeenCalledWith('/openapi/v1/test-omadac/sites/site-123/switches/D8-44-89-C3-00-04/ports/3/name', {
                name: 'Uplink',
            });
        });
    });

    describe('setSwitchPortStatus', () => {
        it('enables or disables a single port', async () => {
            vi.mocked(mockRequest.put).mockResolvedValue({ errorCode: 0, result: {} });

            await switchOps.setSwitchPortStatus('D8-44-89-C3-00-04', 3, 0, 'site-123');

            expect(mockRequest.put).toHaveBeenCalledWith('/openapi/v1/test-omadac/sites/site-123/switches/D8-44-89-C3-00-04/ports/3/status', {
                status: 0,
            });
        });
    });

    describe('setSwitchPortProfileOverride', () => {
        it('enables or disables profile override on a single port', async () => {
            vi.mocked(mockRequest.put).mockResolvedValue({ errorCode: 0, result: {} });

            await switchOps.setSwitchPortProfileOverride('D8-44-89-C3-00-04', 3, true, 'site-123');

            expect(mockRequest.put).toHaveBeenCalledWith(
                '/openapi/v1/test-omadac/sites/site-123/switches/D8-44-89-C3-00-04/ports/3/profile-override',
                { profileOverrideEnable: true }
            );
        });
    });

    describe('batchSetSwitchPortProfile', () => {
        it('batch sets profile override on multiple ports', async () => {
            vi.mocked(mockRequest.put).mockResolvedValue({ errorCode: 0, result: {} });

            await switchOps.batchSetSwitchPortProfile('D8-44-89-C3-00-04', [1, 2, 3], false, 'site-123');

            expect(mockRequest.put).toHaveBeenCalledWith(
                '/openapi/v1/test-omadac/sites/site-123/switches/D8-44-89-C3-00-04/multi-ports/profile-override',
                { portList: [1, 2, 3], profileOverrideEnable: false }
            );
        });
    });

    describe('batchSetSwitchPortPoe', () => {
        it('batch sets PoE mode on multiple ports', async () => {
            vi.mocked(mockRequest.put).mockResolvedValue({ errorCode: 0, result: {} });

            await switchOps.batchSetSwitchPortPoe('D8-44-89-C3-00-04', [1, 2, 3], 1, 'site-123');

            expect(mockRequest.put).toHaveBeenCalledWith('/openapi/v1/test-omadac/sites/site-123/switches/D8-44-89-C3-00-04/multi-ports/poe-mode', {
                portList: [1, 2, 3],
                poeMode: 1,
            });
        });
    });

    describe('batchSetSwitchPortStatus', () => {
        it('batch enables or disables multiple ports', async () => {
            vi.mocked(mockRequest.put).mockResolvedValue({ errorCode: 0, result: {} });

            await switchOps.batchSetSwitchPortStatus('D8-44-89-C3-00-04', [1, 2, 3], 1, 'site-123');

            expect(mockRequest.put).toHaveBeenCalledWith('/openapi/v1/test-omadac/sites/site-123/switches/D8-44-89-C3-00-04/multi-ports/status', {
                portList: [1, 2, 3],
                status: 1,
            });
        });
    });

    describe('batchSetSwitchPortName', () => {
        it('batch sets names on multiple ports', async () => {
            vi.mocked(mockRequest.put).mockResolvedValue({ errorCode: 0, result: {} });

            const portNameList = [{ port: 1, name: 'Uplink' }];
            await switchOps.batchSetSwitchPortName('D8-44-89-C3-00-04', portNameList, 'site-123');

            expect(mockRequest.put).toHaveBeenCalledWith('/openapi/v1/test-omadac/sites/site-123/switches/D8-44-89-C3-00-04/multi-ports/name', {
                portNameList,
            });
        });
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
