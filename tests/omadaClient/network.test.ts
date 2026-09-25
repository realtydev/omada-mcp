import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { InternalRequestHandler } from '../../src/omadaClient/internalRequest.js';
import { NetworkOperations } from '../../src/omadaClient/network.js';
import type { RequestHandler } from '../../src/omadaClient/request.js';
import type { SiteOperations } from '../../src/omadaClient/site.js';
import type { OmadaApiResponse, PaginatedResult } from '../../src/types/index.js';

describe('NetworkOperations', () => {
    let networkOps: NetworkOperations;
    let mockRequest: RequestHandler;
    let mockInternalRequest: InternalRequestHandler;
    let mockSite: SiteOperations;
    let mockBuildPath: (path: string, version?: string) => string;

    beforeEach(() => {
        mockRequest = {
            get: vi.fn(),
            post: vi.fn(),
            put: vi.fn(),
            delete: vi.fn(),
            request: vi.fn(),
            fetchPaginated: vi.fn(),
            ensureSuccess: vi.fn((response: OmadaApiResponse<unknown>) => {
                if (response.errorCode === 0) {
                    return response.result;
                }
                throw new Error(response.msg ?? 'API Error');
            }),
        } as unknown as RequestHandler;

        mockInternalRequest = {
            get: vi.fn(),
            post: vi.fn(),
            put: vi.fn(),
            delete: vi.fn(),
            ensureSuccess: vi.fn((response: OmadaApiResponse<unknown>) => {
                if (response.errorCode === 0) {
                    return response.result;
                }
                throw new Error(response.msg ?? 'Internal API Error');
            }),
        } as unknown as InternalRequestHandler;

        mockSite = {
            resolveSiteId: vi.fn((siteId?: string) => siteId ?? 'default-site'),
        } as unknown as SiteOperations;

        mockBuildPath = vi.fn((path: string, version = 'v1') => `/openapi/${version}/test-omadac${path}`);

        networkOps = new NetworkOperations(mockRequest, mockSite, mockBuildPath);
    });

    describe('getInternetInfo', () => {
        it('should fetch internet info for a site', async () => {
            const mockResponse: OmadaApiResponse<unknown> = {
                errorCode: 0,
                result: { wanType: 'static', ip: '192.168.1.1' },
            };

            vi.mocked(mockRequest.get).mockResolvedValue(mockResponse);

            const result = await networkOps.getInternetInfo('site-123');

            expect(mockSite.resolveSiteId).toHaveBeenCalledWith('site-123');
            expect(mockRequest.get).toHaveBeenCalledWith('/openapi/v1/test-omadac/sites/site-123/internet');
            expect(result).toEqual({ wanType: 'static', ip: '192.168.1.1' });
        });

        it('should use default site when siteId is not provided', async () => {
            const mockResponse: OmadaApiResponse<unknown> = {
                errorCode: 0,
                result: {},
            };

            vi.mocked(mockRequest.get).mockResolvedValue(mockResponse);

            await networkOps.getInternetInfo();

            expect(mockSite.resolveSiteId).toHaveBeenCalledWith(undefined);
        });
    });

    describe('getPortForwardingStatus', () => {
        it('should fetch port forwarding status for User type', async () => {
            const mockResult: PaginatedResult<unknown> = {
                data: [{ name: 'Rule1', externalPort: 80 }],
                totalRows: 1,
                currentPage: 1,
                currentSize: 1,
            };
            const mockResponse: OmadaApiResponse<PaginatedResult<unknown>> = {
                errorCode: 0,
                result: mockResult,
            };

            vi.mocked(mockRequest.get).mockResolvedValue(mockResponse);

            const result = await networkOps.getPortForwardingStatus('User', 'site-123', 1, 10);

            expect(mockRequest.get).toHaveBeenCalledWith('/openapi/v1/test-omadac/sites/site-123/insight/port-forwarding/user', {
                page: 1,
                pageSize: 10,
            });
            expect(result).toEqual(mockResult);
        });

        it('should fetch port forwarding status for UPnP type', async () => {
            const mockResult: PaginatedResult<unknown> = {
                data: [{ name: 'UPnP Rule', externalPort: 8080 }],
                totalRows: 1,
                currentPage: 1,
                currentSize: 1,
            };
            const mockResponse: OmadaApiResponse<PaginatedResult<unknown>> = {
                errorCode: 0,
                result: mockResult,
            };

            vi.mocked(mockRequest.get).mockResolvedValue(mockResponse);

            const result = await networkOps.getPortForwardingStatus('UPnP', 'site-123');

            expect(mockRequest.get).toHaveBeenCalledWith('/openapi/v1/test-omadac/sites/site-123/insight/port-forwarding/upnp', {
                page: 1,
                pageSize: 10,
            });
            expect(result).toEqual(mockResult);
        });
    });

    describe('getLanNetworkList', () => {
        it('should fetch LAN network list using v2 API', async () => {
            const mockData = [
                { id: 'net1', name: 'LAN1', vlan: 10 },
                { id: 'net2', name: 'LAN2', vlan: 20 },
            ];

            vi.mocked(mockRequest.fetchPaginated).mockResolvedValue(mockData);

            const result = await networkOps.getLanNetworkList('site-123');

            expect(mockRequest.fetchPaginated).toHaveBeenCalledWith('/openapi/v2/test-omadac/sites/site-123/lan-networks');
            expect(result).toEqual(mockData);
        });
    });

    describe('updateLanNetwork', () => {
        it('should PATCH the v2 lan-networks endpoint (PUT 405s per the Open API spec)', async () => {
            const mockResponse: OmadaApiResponse<unknown> = {
                errorCode: 0,
                result: {},
            };
            const data = { name: 'Default', dhcpSettings: { leaseTime: 86400 } };

            vi.mocked(mockRequest.request).mockResolvedValue(mockResponse);

            await networkOps.updateLanNetwork('net-1', data, 'site-123');

            expect(mockRequest.request).toHaveBeenCalledWith({
                method: 'PATCH',
                url: '/openapi/v2/test-omadac/sites/site-123/lan-networks/net-1',
                data,
            });
            expect(mockRequest.put).not.toHaveBeenCalled();
        });
    });

    describe('deleteLanNetwork', () => {
        it('should DELETE the v1 lan-networks endpoint (v2 has no DELETE per the Open API spec)', async () => {
            const mockResponse: OmadaApiResponse<unknown> = {
                errorCode: 0,
                result: {},
            };

            vi.mocked(mockRequest.delete).mockResolvedValue(mockResponse);

            await networkOps.deleteLanNetwork('net-1', 'site-123');

            expect(mockRequest.delete).toHaveBeenCalledWith('/openapi/v1/test-omadac/sites/site-123/lan-networks/net-1');
        });
    });

    describe('getLanProfileList', () => {
        it('should fetch LAN profile list', async () => {
            const mockData = [
                { id: 'prof1', name: 'Profile1' },
                { id: 'prof2', name: 'Profile2' },
            ];

            vi.mocked(mockRequest.fetchPaginated).mockResolvedValue(mockData);

            const result = await networkOps.getLanProfileList('site-123');

            expect(mockRequest.fetchPaginated).toHaveBeenCalledWith('/openapi/v1/test-omadac/sites/site-123/lan-profiles');
            expect(result).toEqual(mockData);
        });
    });

    describe('getWlanGroupList', () => {
        it('should fetch WLAN group list', async () => {
            const mockData = [
                { id: 'wlan1', name: 'WLAN Group 1' },
                { id: 'wlan2', name: 'WLAN Group 2' },
            ];
            const mockResponse: OmadaApiResponse<unknown[]> = {
                errorCode: 0,
                result: mockData,
            };

            vi.mocked(mockRequest.get).mockResolvedValue(mockResponse);

            const result = await networkOps.getWlanGroupList('site-123');

            expect(mockRequest.get).toHaveBeenCalledWith('/openapi/v1/test-omadac/sites/site-123/wireless-network/wlans');
            expect(result).toEqual(mockData);
        });
    });

    describe('getSsidList', () => {
        it('should fetch SSID list for a WLAN group', async () => {
            const mockData = [
                { id: 'ssid1', name: 'WiFi-1' },
                { id: 'ssid2', name: 'WiFi-2' },
            ];

            vi.mocked(mockRequest.fetchPaginated).mockResolvedValue(mockData);

            const result = await networkOps.getSsidList('wlan-123', 'site-123');

            expect(mockRequest.fetchPaginated).toHaveBeenCalledWith('/openapi/v1/test-omadac/sites/site-123/wireless-network/wlans/wlan-123/ssids');
            expect(result).toEqual(mockData);
        });

        it('should throw error when wlanId is not provided', async () => {
            await expect(networkOps.getSsidList('', 'site-123')).rejects.toThrow(
                'A wlanId must be provided. Use getWlanGroupList to get available WLAN group IDs.'
            );
        });
    });

    describe('getSsidDetail', () => {
        it('should fetch detailed SSID information', async () => {
            const mockData = {
                id: 'ssid1',
                name: 'WiFi-1',
                security: 'WPA2',
                encryption: 'AES',
            };
            const mockResponse: OmadaApiResponse<unknown> = {
                errorCode: 0,
                result: mockData,
            };

            vi.mocked(mockRequest.get).mockResolvedValue(mockResponse);

            const result = await networkOps.getSsidDetail('wlan-123', 'ssid-456', 'site-123');

            expect(mockRequest.get).toHaveBeenCalledWith('/openapi/v1/test-omadac/sites/site-123/wireless-network/wlans/wlan-123/ssids/ssid-456');
            expect(result).toEqual(mockData);
        });

        it('should throw error when wlanId is not provided', async () => {
            await expect(networkOps.getSsidDetail('', 'ssid-456', 'site-123')).rejects.toThrow(
                'A wlanId must be provided. Use getWlanGroupList to get available WLAN group IDs.'
            );
        });

        it('should throw error when ssidId is not provided', async () => {
            await expect(networkOps.getSsidDetail('wlan-123', '', 'site-123')).rejects.toThrow(
                'An ssidId must be provided. Use getSsidList to get available SSID IDs.'
            );
        });
    });

    describe('getFirewallSetting', () => {
        it('should fetch firewall settings for a site', async () => {
            const mockData = {
                aclEnabled: true,
                rules: [{ name: 'Rule1', action: 'allow' }],
            };
            const mockResponse: OmadaApiResponse<unknown> = {
                errorCode: 0,
                result: mockData,
            };

            vi.mocked(mockRequest.get).mockResolvedValue(mockResponse);

            const result = await networkOps.getFirewallSetting('site-123');

            expect(mockRequest.get).toHaveBeenCalledWith('/openapi/v1/test-omadac/sites/site-123/firewall');
            expect(result).toEqual(mockData);
        });
    });

    describe('updateFirewallSetting', () => {
        it('should PATCH the v1 firewall endpoint (PUT 405s per the Open API spec)', async () => {
            const mockResponse: OmadaApiResponse<unknown> = {
                errorCode: 0,
                result: {},
            };
            const data = { sendRedirects: false };

            vi.mocked(mockRequest.request).mockResolvedValue(mockResponse);

            await networkOps.updateFirewallSetting(data, 'site-123');

            expect(mockRequest.request).toHaveBeenCalledWith({
                method: 'PATCH',
                url: '/openapi/v1/test-omadac/sites/site-123/firewall',
                data,
            });
            expect(mockRequest.put).not.toHaveBeenCalled();
        });
    });

    describe('updateWanPortSetting', () => {
        it('should PATCH the v1 wan port-setting endpoint, wrapping the port object in a type-0 envelope', async () => {
            const mockResponse: OmadaApiResponse<unknown> = {
                errorCode: 0,
                result: {},
            };
            const portSetting = {
                portId: '1_e98d1ea14d7c401591fdfcf431e5c348',
                wanPortIpv4Setting: { protoType: 1, vlanId: 0, ipv4Dhcp: { unicastDhcp: true, mtu: 1500 } },
                wanPortIpv6Setting: {},
                wanPortMacSetting: {},
            };

            vi.mocked(mockRequest.request).mockResolvedValue(mockResponse);

            await networkOps.updateWanPortSetting(portSetting, 'site-123');

            expect(mockRequest.request).toHaveBeenCalledWith({
                method: 'PATCH',
                url: '/openapi/v1/test-omadac/sites/site-123/wan/networks/port-setting',
                data: { type: 0, wanPortSetting: portSetting },
            });
        });
    });

    describe('getIpsSetting', () => {
        it('should fetch IDS/IPS config for a site and report supported: true', async () => {
            const mockData = { enable: false };
            const mockResponse: OmadaApiResponse<unknown> = {
                errorCode: 0,
                result: mockData,
            };

            vi.mocked(mockRequest.get).mockResolvedValue(mockResponse);

            const result = await networkOps.getIpsSetting('site-123');

            expect(mockRequest.get).toHaveBeenCalledWith('/openapi/v1/test-omadac/sites/site-123/network-security/ips');
            expect(result).toEqual({ supported: true, enable: false });
        });

        it('should report supported: false instead of throwing when the gateway does not support IDS/IPS', async () => {
            const mockResponse: OmadaApiResponse<unknown> = {
                errorCode: -35205,
                msg: 'The adopted gateway does not support IDS/IPS configurations.',
            };

            vi.mocked(mockRequest.get).mockResolvedValue(mockResponse);

            const result = await networkOps.getIpsSetting('site-123');

            expect(result).toEqual({
                supported: false,
                reason: 'The adopted gateway does not support IDS/IPS configurations.',
            });
        });
    });

    describe('setIpsSetting', () => {
        it('should PATCH the network-security/ips endpoint and report supported: true on success', async () => {
            const mockResponse: OmadaApiResponse<unknown> = {
                errorCode: 0,
                result: {},
            };
            const data = { enable: false };

            vi.mocked(mockRequest.request).mockResolvedValue(mockResponse);

            const result = await networkOps.setIpsSetting(data, 'site-123');

            expect(mockRequest.request).toHaveBeenCalledWith({
                method: 'PATCH',
                url: '/openapi/v1/test-omadac/sites/site-123/network-security/ips',
                data,
            });
            expect(result).toEqual({ supported: true });
        });

        it('should report supported: false instead of throwing when the gateway rejects enabling IDS/IPS', async () => {
            const mockResponse: OmadaApiResponse<unknown> = {
                errorCode: -35205,
                msg: 'The adopted gateway does not support IDS/IPS configurations.',
            };

            vi.mocked(mockRequest.request).mockResolvedValue(mockResponse);

            const result = await networkOps.setIpsSetting({ enable: true, mode: 'IDS', level: 'low' }, 'site-123');

            expect(result).toEqual({
                supported: false,
                reason: 'The adopted gateway does not support IDS/IPS configurations.',
            });
        });
    });

    describe('listEvents', () => {
        it('should fetch events from the logs/events endpoint with a default 7-day time range', async () => {
            const mockResult: PaginatedResult<unknown> = {
                data: [{ id: 'evt-1', message: 'Device connected' }],
                totalRows: 1,
                currentPage: 1,
                currentSize: 10,
            };
            const mockResponse: OmadaApiResponse<PaginatedResult<unknown>> = {
                errorCode: 0,
                result: mockResult,
            };

            vi.mocked(mockRequest.get).mockResolvedValue(mockResponse);
            vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);

            const result = await networkOps.listEvents('site-123', 1, 10);

            expect(mockRequest.get).toHaveBeenCalledWith('/openapi/v1/test-omadac/sites/site-123/logs/events', {
                page: 1,
                pageSize: 10,
                'filters.timeStart': 1_700_000_000_000 - 7 * 24 * 60 * 60 * 1000,
                'filters.timeEnd': 1_700_000_000_000,
            });
            expect(result).toEqual(mockResult);

            vi.restoreAllMocks();
        });

        it('should use an explicit time range when provided', async () => {
            const mockResponse: OmadaApiResponse<PaginatedResult<unknown>> = {
                errorCode: 0,
                result: { data: [], totalRows: 0, currentPage: 1, currentSize: 10 },
            };

            vi.mocked(mockRequest.get).mockResolvedValue(mockResponse);

            await networkOps.listEvents('site-123', 1, 10, 1_600_000_000_000, 1_600_100_000_000);

            expect(mockRequest.get).toHaveBeenCalledWith('/openapi/v1/test-omadac/sites/site-123/logs/events', {
                page: 1,
                pageSize: 10,
                'filters.timeStart': 1_600_000_000_000,
                'filters.timeEnd': 1_600_100_000_000,
            });
        });

        it('should include filters.module when a module filter is provided', async () => {
            const mockResponse: OmadaApiResponse<PaginatedResult<unknown>> = {
                errorCode: 0,
                result: { data: [], totalRows: 0, currentPage: 1, currentSize: 10 },
            };

            vi.mocked(mockRequest.get).mockResolvedValue(mockResponse);

            await networkOps.listEvents('site-123', 1, 10, 1_600_000_000_000, 1_600_100_000_000, 'Client');

            expect(mockRequest.get).toHaveBeenCalledWith('/openapi/v1/test-omadac/sites/site-123/logs/events', {
                page: 1,
                pageSize: 10,
                'filters.timeStart': 1_600_000_000_000,
                'filters.timeEnd': 1_600_100_000_000,
                'filters.module': 'Client',
            });
        });

        it('should omit filters.module when no module filter is provided', async () => {
            const mockResponse: OmadaApiResponse<PaginatedResult<unknown>> = {
                errorCode: 0,
                result: { data: [], totalRows: 0, currentPage: 1, currentSize: 10 },
            };

            vi.mocked(mockRequest.get).mockResolvedValue(mockResponse);

            await networkOps.listEvents('site-123', 1, 10, 1_600_000_000_000, 1_600_100_000_000);

            const params = vi.mocked(mockRequest.get).mock.calls[0][1] as Record<string, unknown>;
            expect(params).not.toHaveProperty('filters.module');
        });
    });

    describe('listEvents key filters', () => {
        const eventsPath = '/openapi/v1/test-omadac/sites/site-123/logs/events';
        const event = (key: string) => ({ id: key, key });
        const pageOf = (data: unknown[], totalRows: number): OmadaApiResponse<PaginatedResult<unknown>> => ({
            errorCode: 0,
            result: { data, totalRows, currentPage: 1, currentSize: data.length },
        });

        it('should keep only events whose key starts with keyPrefix, scanning at pageSize 1000', async () => {
            vi.mocked(mockRequest.get).mockResolvedValue(pageOf([event('OSG_DHCP_S'), event('DEV_CONN'), event('DEV_DISCONN')], 3));

            const result = await networkOps.listEvents('site-123', 1, 10, 1_600_000_000_000, 1_600_100_000_000, 'Device', 'DEV_');

            expect(mockRequest.get).toHaveBeenCalledWith(eventsPath, {
                page: 1,
                pageSize: 1000,
                'filters.timeStart': 1_600_000_000_000,
                'filters.timeEnd': 1_600_100_000_000,
                'filters.module': 'Device',
            });
            expect(result.data).toEqual([event('DEV_CONN'), event('DEV_DISCONN')]);
            expect(result.totalRows).toBe(2);
            expect(result).not.toHaveProperty('scanTruncated');
        });

        it('should drop events matching excludeKeyPrefix', async () => {
            vi.mocked(mockRequest.get).mockResolvedValue(pageOf([event('OSG_DDNS'), event('AP_CH_C'), event('OSG_DHCP_C')], 3));

            const result = await networkOps.listEvents('site-123', 1, 10, 1, 2, undefined, undefined, 'OSG_');

            expect(result.data).toEqual([event('AP_CH_C')]);
        });

        it('should scan across server pages and paginate the matches', async () => {
            vi.mocked(mockRequest.get)
                .mockResolvedValueOnce(pageOf([event('DEV_A'), event('OSG_X')], 1500))
                .mockResolvedValueOnce(pageOf([event('DEV_B'), event('DEV_C')], 1500));

            const result = await networkOps.listEvents('site-123', 2, 2, 1, 2, undefined, 'DEV_');

            expect(mockRequest.get).toHaveBeenCalledTimes(2);
            expect(result.data).toEqual([event('DEV_C')]);
            expect(result.totalRows).toBe(3);
            expect(result.currentPage).toBe(2);
        });

        it('should flag scanTruncated when the scan page cap is reached', async () => {
            vi.mocked(mockRequest.get).mockResolvedValue(pageOf([event('OSG_X')], 1_000_000));

            const result = await networkOps.listEvents('site-123', 1, 10, 1, 2, undefined, 'DEV_');

            expect(mockRequest.get).toHaveBeenCalledTimes(100);
            expect(result.scanTruncated).toBe(true);
        });
    });

    describe('listAlerts', () => {
        const emptyResponse: OmadaApiResponse<PaginatedResult<unknown>> = {
            errorCode: 0,
            result: { data: [], totalRows: 0, currentPage: 1, currentSize: 10 },
        };

        it('should fetch alerts from the logs/alerts endpoint with a default 7-day time range', async () => {
            vi.mocked(mockRequest.get).mockResolvedValue(emptyResponse);
            vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);

            const result = await networkOps.listAlerts('site-123', 1, 10);

            expect(mockRequest.get).toHaveBeenCalledWith('/openapi/v1/test-omadac/sites/site-123/logs/alerts', {
                page: 1,
                pageSize: 10,
                'filters.timeStart': 1_700_000_000_000 - 7 * 24 * 60 * 60 * 1000,
                'filters.timeEnd': 1_700_000_000_000,
            });
            expect(result).toEqual(emptyResponse.result);

            vi.restoreAllMocks();
        });

        it('should include filters.module and filters.resolved when provided', async () => {
            vi.mocked(mockRequest.get).mockResolvedValue(emptyResponse);

            await networkOps.listAlerts('site-123', 1, 10, 1_600_000_000_000, 1_600_100_000_000, 'Device', false);

            expect(mockRequest.get).toHaveBeenCalledWith('/openapi/v1/test-omadac/sites/site-123/logs/alerts', {
                page: 1,
                pageSize: 10,
                'filters.timeStart': 1_600_000_000_000,
                'filters.timeEnd': 1_600_100_000_000,
                'filters.module': 'Device',
                'filters.resolved': false,
            });
        });

        it('should omit optional filters when not provided', async () => {
            vi.mocked(mockRequest.get).mockResolvedValue(emptyResponse);

            await networkOps.listAlerts('site-123', 1, 10, 1_600_000_000_000, 1_600_100_000_000);

            const params = vi.mocked(mockRequest.get).mock.calls[0][1] as Record<string, unknown>;
            expect(params).not.toHaveProperty('filters.module');
            expect(params).not.toHaveProperty('filters.resolved');
        });
    });

    describe('listLogs', () => {
        it('should fetch audit logs from the audit-logs endpoint', async () => {
            const mockResult: PaginatedResult<unknown> = {
                data: [{ id: 'log-1', operation: 'Update SSID' }],
                totalRows: 1,
                currentPage: 1,
                currentSize: 10,
            };
            const mockResponse: OmadaApiResponse<PaginatedResult<unknown>> = {
                errorCode: 0,
                result: mockResult,
            };

            vi.mocked(mockRequest.get).mockResolvedValue(mockResponse);

            const result = await networkOps.listLogs('site-123', 1, 10);

            expect(mockRequest.get).toHaveBeenCalledWith('/openapi/v1/test-omadac/sites/site-123/audit-logs', {
                page: 1,
                pageSize: 10,
            });
            expect(result).toEqual(mockResult);
        });
    });

    describe('getPortForwardingStatus with internal API', () => {
        it('should use the internal API for User type when internal API is available', async () => {
            networkOps.setInternalRequest(mockInternalRequest);

            const mockResult: PaginatedResult<unknown> = {
                data: [{ name: 'Rule1', externalPort: '80' }],
                totalRows: 1,
                currentPage: 1,
                currentSize: 10,
            };
            const mockResponse: OmadaApiResponse<PaginatedResult<unknown>> = {
                errorCode: 0,
                result: mockResult,
            };

            vi.mocked(mockInternalRequest.get).mockResolvedValue(mockResponse);

            const result = await networkOps.getPortForwardingStatus('User', 'site-123', 1, 10);

            expect(mockInternalRequest.get).toHaveBeenCalledWith('/sites/site-123/setting/transmission/portForwardings', {
                currentPage: 1,
                currentPageSize: 10,
            });
            expect(mockRequest.get).not.toHaveBeenCalled();
            expect(result).toEqual(mockResult);
        });

        it('should still use the public API for UPnP type even when internal API is available', async () => {
            networkOps.setInternalRequest(mockInternalRequest);

            const mockResponse: OmadaApiResponse<PaginatedResult<unknown>> = {
                errorCode: 0,
                result: { data: [], totalRows: 0, currentPage: 1, currentSize: 10 },
            };

            vi.mocked(mockRequest.get).mockResolvedValue(mockResponse);

            await networkOps.getPortForwardingStatus('UPnP', 'site-123', 1, 10);

            expect(mockRequest.get).toHaveBeenCalledWith('/openapi/v1/test-omadac/sites/site-123/insight/port-forwarding/upnp', {
                page: 1,
                pageSize: 10,
            });
            expect(mockInternalRequest.get).not.toHaveBeenCalled();
        });
    });

    describe('listRoutes', () => {
        it('should use the internal API when available', async () => {
            networkOps.setInternalRequest(mockInternalRequest);

            const mockRoutes = [{ id: 'route-1', name: 'claude-mcp-test', metric: 15 }];
            const mockResponse: OmadaApiResponse<PaginatedResult<unknown>> = {
                errorCode: 0,
                result: { data: mockRoutes, totalRows: 1, currentPage: 1, currentSize: 100 },
            };

            vi.mocked(mockInternalRequest.get).mockResolvedValue(mockResponse);

            const result = await networkOps.listRoutes('site-123');

            expect(mockInternalRequest.get).toHaveBeenCalledWith('/sites/site-123/setting/transmission/staticRoutings', {
                currentPage: 1,
                currentPageSize: 100,
            });
            expect(result).toEqual(mockRoutes);
        });

        it('should fall back to the public API when internal API is not available', async () => {
            const mockRoutes = [{ id: 'route-1' }];
            vi.mocked(mockRequest.fetchPaginated).mockResolvedValue(mockRoutes);

            const result = await networkOps.listRoutes('site-123');

            expect(mockRequest.fetchPaginated).toHaveBeenCalledWith('/openapi/v1/test-omadac/sites/site-123/setting/routes');
            expect(result).toEqual(mockRoutes);
        });
    });

    describe('createRoute', () => {
        it('should create a route via the internal API', async () => {
            networkOps.setInternalRequest(mockInternalRequest);

            const routeData = {
                name: 'claude-mcp-test',
                status: true,
                destinations: ['203.0.113.0/24'],
                routeType: 0,
                nextHopIp: '192.168.0.1',
                metric: '15',
            };
            const mockResponse: OmadaApiResponse<unknown> = { errorCode: 0, result: {} };
            vi.mocked(mockInternalRequest.post).mockResolvedValue(mockResponse);

            await networkOps.createRoute(routeData, 'site-123');

            expect(mockInternalRequest.post).toHaveBeenCalledWith('/sites/site-123/setting/transmission/staticRoutings', routeData);
        });

        it('should throw a clear error when internal API is not configured', async () => {
            await expect(networkOps.createRoute({}, 'site-123')).rejects.toThrow(
                'createRoute requires the internal web UI API. Set OMADA_WEB_USERNAME and OMADA_WEB_PASSWORD environment variables to enable it.'
            );
        });
    });

    describe('updateRoute', () => {
        it('should update a route via the internal API', async () => {
            networkOps.setInternalRequest(mockInternalRequest);

            const routeData = {
                name: 'claude-mcp-test',
                status: true,
                destinations: ['203.0.113.0/24'],
                routeType: 0,
                nextHopIp: '192.168.0.1',
                metric: '5',
            };
            const mockResponse: OmadaApiResponse<unknown> = { errorCode: 0, result: {} };
            vi.mocked(mockInternalRequest.put).mockResolvedValue(mockResponse);

            await networkOps.updateRoute('route-1', routeData, 'site-123');

            expect(mockInternalRequest.put).toHaveBeenCalledWith('/sites/site-123/setting/transmission/staticRoutings/route-1', routeData);
        });

        it('should throw a clear error when internal API is not configured', async () => {
            await expect(networkOps.updateRoute('route-1', {}, 'site-123')).rejects.toThrow(
                'updateRoute requires the internal web UI API. Set OMADA_WEB_USERNAME and OMADA_WEB_PASSWORD environment variables to enable it.'
            );
        });
    });

    describe('deleteRoute', () => {
        it('should delete a route via the internal API', async () => {
            networkOps.setInternalRequest(mockInternalRequest);

            const mockResponse: OmadaApiResponse<unknown> = { errorCode: 0, result: {} };
            vi.mocked(mockInternalRequest.delete).mockResolvedValue(mockResponse);

            await networkOps.deleteRoute('route-1', 'site-123');

            expect(mockInternalRequest.delete).toHaveBeenCalledWith('/sites/site-123/setting/transmission/staticRoutings/route-1');
        });

        it('should throw a clear error when internal API is not configured', async () => {
            await expect(networkOps.deleteRoute('route-1', 'site-123')).rejects.toThrow(
                'deleteRoute requires the internal web UI API. Set OMADA_WEB_USERNAME and OMADA_WEB_PASSWORD environment variables to enable it.'
            );
        });
    });

    describe('createPortForward', () => {
        it('should create a port forwarding rule via the internal API', async () => {
            networkOps.setInternalRequest(mockInternalRequest);

            const ruleData = {
                name: 'claude-mcp-test',
                status: true,
                dMZ: false,
                externalPort: '59999',
                forwardIp: '192.168.0.253',
                forwardPort: '59999',
                protocol: 1,
                from: 0,
                interfaceWanPortId: ['wan-1'],
                virtualWanId: [],
                featureDescription: [],
            };
            const mockResponse: OmadaApiResponse<unknown> = { errorCode: 0, result: {} };
            vi.mocked(mockInternalRequest.post).mockResolvedValue(mockResponse);

            await networkOps.createPortForward(ruleData, 'site-123');

            expect(mockInternalRequest.post).toHaveBeenCalledWith('/sites/site-123/setting/transmission/portForwardings', ruleData);
        });

        it('should throw a clear error when internal API is not configured', async () => {
            await expect(networkOps.createPortForward({}, 'site-123')).rejects.toThrow(
                'createPortForward requires the internal web UI API. Set OMADA_WEB_USERNAME and OMADA_WEB_PASSWORD environment variables to enable it.'
            );
        });
    });

    describe('updatePortForward', () => {
        it('should update a port forwarding rule via the internal API', async () => {
            networkOps.setInternalRequest(mockInternalRequest);

            const ruleData = { name: 'claude-mcp-test', externalPort: '60000', forwardPort: '60000' };
            const mockResponse: OmadaApiResponse<unknown> = { errorCode: 0, result: {} };
            vi.mocked(mockInternalRequest.put).mockResolvedValue(mockResponse);

            await networkOps.updatePortForward('rule-1', ruleData, 'site-123');

            expect(mockInternalRequest.put).toHaveBeenCalledWith('/sites/site-123/setting/transmission/portForwardings/rule-1', ruleData);
        });

        it('should throw a clear error when internal API is not configured', async () => {
            await expect(networkOps.updatePortForward('rule-1', {}, 'site-123')).rejects.toThrow(
                'updatePortForward requires the internal web UI API. Set OMADA_WEB_USERNAME and OMADA_WEB_PASSWORD environment variables to enable it.'
            );
        });
    });

    describe('deletePortForward', () => {
        it('should delete a port forwarding rule via the internal API', async () => {
            networkOps.setInternalRequest(mockInternalRequest);

            const mockResponse: OmadaApiResponse<unknown> = { errorCode: 0, result: {} };
            vi.mocked(mockInternalRequest.delete).mockResolvedValue(mockResponse);

            await networkOps.deletePortForward('rule-1', 'site-123');

            expect(mockInternalRequest.delete).toHaveBeenCalledWith('/sites/site-123/setting/transmission/portForwardings/rule-1');
        });

        it('should throw a clear error when internal API is not configured', async () => {
            await expect(networkOps.deletePortForward('rule-1', 'site-123')).rejects.toThrow(
                'deletePortForward requires the internal web UI API. Set OMADA_WEB_USERNAME and OMADA_WEB_PASSWORD environment variables to enable it.'
            );
        });
    });
});
