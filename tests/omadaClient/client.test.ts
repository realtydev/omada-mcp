import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientOperations } from '../../src/omadaClient/client.js';
import type { RequestHandler } from '../../src/omadaClient/request.js';
import type { SiteOperations } from '../../src/omadaClient/site.js';
import type { ActiveClientInfo, ClientActivity, ClientPastConnection, OmadaApiResponse, OmadaClientInfo } from '../../src/types/index.js';

describe('omadaClient/client', () => {
    let mockRequest: RequestHandler;
    let mockSite: SiteOperations;
    let buildPath: (path: string) => string;
    let clientOps: ClientOperations;

    beforeEach(() => {
        mockRequest = {
            fetchPaginated: vi.fn(),
            get: vi.fn(),
            ensureSuccess: vi.fn((response) => response.result),
        } as unknown as RequestHandler;

        mockSite = {
            resolveSiteId: vi.fn((siteId) => siteId ?? 'default-site'),
        } as unknown as SiteOperations;

        buildPath = (path: string) => `/api${path}`;

        clientOps = new ClientOperations(mockRequest, mockSite, buildPath);
    });

    describe('listClients', () => {
        it('should fetch paginated list of clients', async () => {
            const mockClients: OmadaClientInfo[] = [
                { mac: '00:11:22:33:44:55', name: 'Client 1', id: 'client-1' } as OmadaClientInfo,
                { mac: '00:11:22:33:44:66', name: 'Client 2', id: 'client-2' } as OmadaClientInfo,
            ];

            (mockRequest.fetchPaginated as ReturnType<typeof vi.fn>).mockResolvedValue(mockClients);

            const clients = await clientOps.listClients('test-site');

            expect(clients).toEqual(mockClients);
            expect(mockSite.resolveSiteId).toHaveBeenCalledWith('test-site');
            expect(mockRequest.fetchPaginated).toHaveBeenCalledWith('/api/sites/test-site/clients');
        });

        it('should use default siteId if not provided', async () => {
            const mockClients: OmadaClientInfo[] = [];
            (mockRequest.fetchPaginated as ReturnType<typeof vi.fn>).mockResolvedValue(mockClients);

            await clientOps.listClients();

            expect(mockSite.resolveSiteId).toHaveBeenCalledWith(undefined);
            expect(mockRequest.fetchPaginated).toHaveBeenCalledWith('/api/sites/default-site/clients');
        });
    });

    describe('getClient', () => {
        it('should find client by MAC address', async () => {
            const mockClients: OmadaClientInfo[] = [
                { mac: '00:11:22:33:44:55', name: 'Client 1', id: 'client-1' } as OmadaClientInfo,
                { mac: '00:11:22:33:44:66', name: 'Client 2', id: 'client-2' } as OmadaClientInfo,
            ];

            (mockRequest.fetchPaginated as ReturnType<typeof vi.fn>).mockResolvedValue(mockClients);

            const client = await clientOps.getClient('00:11:22:33:44:66', 'test-site');

            expect(client).toEqual(mockClients[1]);
        });

        it('should find client by client ID', async () => {
            const mockClients: OmadaClientInfo[] = [
                { mac: '00:11:22:33:44:55', name: 'Client 1', id: 'client-1' } as OmadaClientInfo,
                { mac: '00:11:22:33:44:66', name: 'Client 2', id: 'client-2' } as OmadaClientInfo,
            ];

            (mockRequest.fetchPaginated as ReturnType<typeof vi.fn>).mockResolvedValue(mockClients);

            const client = await clientOps.getClient('client-1', 'test-site');

            expect(client).toEqual(mockClients[0]);
        });

        it('should return undefined if client not found', async () => {
            const mockClients: OmadaClientInfo[] = [];
            (mockRequest.fetchPaginated as ReturnType<typeof vi.fn>).mockResolvedValue(mockClients);

            const client = await clientOps.getClient('nonexistent', 'test-site');

            expect(client).toBeUndefined();
        });
    });

    describe('listMostActiveClients', () => {
        it('should fetch most active clients', async () => {
            const mockClients: ActiveClientInfo[] = [
                {
                    mac: '00:11:22:33:44:55',
                    name: 'Client 1',
                    trafficDown: 1000,
                    trafficUp: 500,
                    wireless: false,
                    type: 'wired',
                    model: 'PC',
                    totalTraffic: 1500,
                } as ActiveClientInfo,
            ];

            const mockResponse: OmadaApiResponse<ActiveClientInfo[]> = {
                errorCode: 0,
                msg: 'Success',
                result: mockClients,
            };

            (mockRequest.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

            const clients = await clientOps.listMostActiveClients('test-site');

            expect(clients).toEqual(mockClients);
            expect(mockSite.resolveSiteId).toHaveBeenCalledWith('test-site');
            expect(mockRequest.get).toHaveBeenCalledWith('/api/sites/test-site/dashboard/active-clients');
        });

        it('should use default siteId if not provided', async () => {
            const mockClients: ActiveClientInfo[] = [];
            const mockResponse: OmadaApiResponse<ActiveClientInfo[]> = {
                errorCode: 0,
                msg: 'Success',
                result: mockClients,
            };

            (mockRequest.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

            await clientOps.listMostActiveClients();

            expect(mockSite.resolveSiteId).toHaveBeenCalledWith(undefined);
            expect(mockRequest.get).toHaveBeenCalledWith('/api/sites/default-site/dashboard/active-clients');
        });

        it('should return empty array if result is undefined', async () => {
            const mockResponse: OmadaApiResponse<ActiveClientInfo[]> = {
                errorCode: 0,
                msg: 'Success',
            };

            (mockRequest.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

            const clients = await clientOps.listMostActiveClients();

            expect(clients).toEqual([]);
        });
    });

    describe('listClientsActivity', () => {
        it('should fetch client activity with no options', async () => {
            const mockActivity: ClientActivity[] = [
                {
                    time: 1640000000,
                    newEapClientNum: 5,
                    newSwitchClientNum: 2,
                    activeEapClientNum: 10,
                    activeSwitchClientNum: 8,
                    disconnectEapClientNum: 1,
                    disconnectSwitchClientNum: 1,
                } as ClientActivity,
            ];

            const mockResponse: OmadaApiResponse<ClientActivity[]> = {
                errorCode: 0,
                msg: 'Success',
                result: mockActivity,
            };

            (mockRequest.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

            const activity = await clientOps.listClientsActivity();

            expect(activity).toEqual(mockActivity);
            expect(mockSite.resolveSiteId).toHaveBeenCalledWith(undefined);
            expect(mockRequest.get).toHaveBeenCalledWith('/api/sites/default-site/dashboard/client-activity', {});
        });

        it('should fetch client activity with start and end timestamps', async () => {
            const mockActivity: ClientActivity[] = [];
            const mockResponse: OmadaApiResponse<ClientActivity[]> = {
                errorCode: 0,
                msg: 'Success',
                result: mockActivity,
            };

            (mockRequest.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

            await clientOps.listClientsActivity({
                siteId: 'test-site',
                start: 1640000000,
                end: 1640100000,
            });

            expect(mockSite.resolveSiteId).toHaveBeenCalledWith('test-site');
            expect(mockRequest.get).toHaveBeenCalledWith('/api/sites/test-site/dashboard/client-activity', {
                start: 1640000000,
                end: 1640100000,
            });
        });

        it('should return empty array if result is undefined', async () => {
            const mockResponse: OmadaApiResponse<ClientActivity[]> = {
                errorCode: 0,
                msg: 'Success',
            };

            (mockRequest.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

            const activity = await clientOps.listClientsActivity();

            expect(activity).toEqual([]);
        });
    });

    describe('listClientsPastConnections', () => {
        it('should fetch past connections with required options', async () => {
            const mockConnections: ClientPastConnection[] = [
                {
                    mac: '00:11:22:33:44:55',
                    name: 'Client 1',
                    lastSeen: 1640000000000,
                    firstSeen: 1639990000000,
                    download: 1000000,
                    upload: 500000,
                    duration: 3600,
                } as ClientPastConnection,
            ];

            const mockPaginatedResult = {
                data: mockConnections,
                totalRows: 1,
                currentPage: 1,
                currentSize: 1,
            };

            const mockResponse: OmadaApiResponse<typeof mockPaginatedResult> = {
                errorCode: 0,
                msg: 'Success',
                result: mockPaginatedResult,
            };

            (mockRequest.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);
            (mockRequest.ensureSuccess as ReturnType<typeof vi.fn>).mockReturnValue(mockPaginatedResult);

            const connections = await clientOps.listClientsPastConnections({
                page: 1,
                pageSize: 50,
            });

            expect(connections).toEqual(mockConnections);
            expect(mockSite.resolveSiteId).toHaveBeenCalledWith(undefined);
            expect(mockRequest.get).toHaveBeenCalledWith('/api/sites/default-site/insight/past-connection', {
                page: 1,
                pageSize: 50,
            });
            expect(mockRequest.ensureSuccess).toHaveBeenCalledWith(mockResponse);
        });

        it('should include all optional parameters when provided', async () => {
            const mockPaginatedResult = {
                data: [],
                totalRows: 0,
                currentPage: 1,
                currentSize: 0,
            };

            const mockResponse: OmadaApiResponse<typeof mockPaginatedResult> = {
                errorCode: 0,
                msg: 'Success',
                result: mockPaginatedResult,
            };

            (mockRequest.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);
            (mockRequest.ensureSuccess as ReturnType<typeof vi.fn>).mockReturnValue(mockPaginatedResult);

            await clientOps.listClientsPastConnections({
                siteId: 'test-site',
                page: 2,
                pageSize: 100,
                sortLastSeen: 'desc',
                timeStart: 1640000000000,
                timeEnd: 1640100000000,
                guest: true,
                searchKey: 'test',
            });

            expect(mockRequest.get).toHaveBeenCalledWith('/api/sites/test-site/insight/past-connection', {
                page: 2,
                pageSize: 100,
                'sorts.lastSeen': 'desc',
                'filters.timeStart': '1640000000000',
                'filters.timeEnd': '1640100000000',
                'filters.guest': 'true',
                searchKey: 'test',
            });
        });

        it('should return empty array if data is undefined', async () => {
            const mockPaginatedResult = {
                totalRows: 0,
                currentPage: 1,
                currentSize: 0,
            };

            const mockResponse: OmadaApiResponse<typeof mockPaginatedResult> = {
                errorCode: 0,
                msg: 'Success',
                result: mockPaginatedResult,
            };

            (mockRequest.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);
            (mockRequest.ensureSuccess as ReturnType<typeof vi.fn>).mockReturnValue(mockPaginatedResult as never);

            const connections = await clientOps.listClientsPastConnections({
                page: 1,
                pageSize: 50,
            });

            expect(connections).toEqual([]);
        });
    });

    describe('getClientHistory', () => {
        const mac = 'AA-BB-CC-DD-EE-FF';
        const wireless = (firstSeen: number, lastSeen: number, deviceName: string, extra: Record<string, unknown> = {}) => ({
            mac,
            firstSeen,
            lastSeen,
            duration: (lastSeen - firstSeen) / 1000,
            deviceName,
            ssid: 'Home',
            ...extra,
        });
        const mockPage = (rows: unknown[]) => {
            vi.mocked(mockRequest.get).mockResolvedValueOnce({ errorCode: 0, result: { data: rows } } as OmadaApiResponse<never>);
        };

        it('should query past-connection with searchKey and a default 7-day window', async () => {
            mockPage([]);
            vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);

            await clientOps.getClientHistory({ siteId: 'site-1', clientMac: mac });

            expect(mockRequest.get).toHaveBeenCalledWith('/api/sites/site-1/insight/past-connection', {
                page: 1,
                pageSize: 1000,
                'sorts.lastSeen': 'desc',
                'filters.timeStart': String(1_700_000_000_000 - 7 * 24 * 60 * 60 * 1000),
                'filters.timeEnd': '1700000000000',
                searchKey: mac,
            });

            vi.restoreAllMocks();
        });

        it('should keep only exact-MAC sessions, normalised and sorted oldest first', async () => {
            mockPage([
                wireless(3000, 4000, 'AP-B'),
                { ...wireless(1000, 2000, 'AP-A'), mac: 'aa:bb:cc:dd:ee:ff' },
                { ...wireless(500, 900, 'AP-A'), mac: 'AA-BB-CC-DD-EE-00' },
            ]);

            const history = await clientOps.getClientHistory({ clientMac: mac, timeStart: 0, timeEnd: 10_000 });

            expect(history.sessions.map((s) => [s.start, s.end, s.deviceName])).toEqual([
                [1000, 2000, 'AP-A'],
                [3000, 4000, 'AP-B'],
            ]);
            expect(history.sessions[0].durationSeconds).toBe(1);
            expect(history).not.toHaveProperty('roams');
        });

        it('should fetch following pages until a short page and set no truncation flag', async () => {
            mockPage(Array.from({ length: 1000 }, (_, i) => wireless(i * 10, i * 10 + 5, 'AP-A')));
            mockPage([wireless(20_000, 20_005, 'AP-A')]);

            const history = await clientOps.getClientHistory({ clientMac: mac, timeStart: 0, timeEnd: 30_000 });

            expect(mockRequest.get).toHaveBeenCalledTimes(2);
            expect(history.sessions).toHaveLength(1001);
            expect(history).not.toHaveProperty('truncated');
        });

        it('should flag truncated when the page cap is reached', async () => {
            vi.mocked(mockRequest.get).mockResolvedValue({
                errorCode: 0,
                result: { data: Array.from({ length: 1000 }, (_, i) => wireless(i, i + 1, 'AP-A')) },
            } as OmadaApiResponse<never>);

            const history = await clientOps.getClientHistory({ clientMac: mac, timeStart: 0, timeEnd: 30_000 });

            expect(mockRequest.get).toHaveBeenCalledTimes(20);
            expect(history.truncated).toBe(true);
        });

        describe('roam timeline', () => {
            it('should report a roam between different APs within the 60s gap', async () => {
                mockPage([wireless(0, 100_000, 'AP-A'), wireless(130_000, 200_000, 'AP-B')]);

                const history = await clientOps.getClientHistory({ clientMac: mac, roamTimeline: true });

                expect(history.roams).toEqual([
                    {
                        at: 130_000,
                        from: { deviceName: 'AP-A', ssid: 'Home', sessionEnd: 100_000 },
                        to: { deviceName: 'AP-B', ssid: 'Home', sessionStart: 130_000 },
                        gapSeconds: 30,
                    },
                ]);
            });

            it('should treat exactly 60s as a roam and 61s as not', async () => {
                mockPage([wireless(0, 10_000, 'AP-A'), wireless(70_000, 80_000, 'AP-B'), wireless(141_000, 150_000, 'AP-A')]);

                const history = await clientOps.getClientHistory({ clientMac: mac, roamTimeline: true });

                expect(history.roams?.map((r) => r.gapSeconds)).toEqual([60]);
            });

            it('should count overlapping sessions on different APs as a roam with a negative gap', async () => {
                mockPage([wireless(0, 10_000, 'AP-A'), wireless(8_000, 20_000, 'AP-B')]);

                const history = await clientOps.getClientHistory({ clientMac: mac, roamTimeline: true });

                expect(history.roams?.map((r) => r.gapSeconds)).toEqual([-2]);
            });

            it('should not report a reconnect on the same AP as a roam', async () => {
                mockPage([wireless(0, 10_000, 'AP-A'), wireless(20_000, 30_000, 'AP-A')]);

                const history = await clientOps.getClientHistory({ clientMac: mac, roamTimeline: true });

                expect(history.roams).toEqual([]);
            });

            it('should ignore wired sessions', async () => {
                mockPage([wireless(0, 10_000, 'AP-A'), wireless(20_000, 30_000, 'Switch', { ssid: undefined, port: 3 })]);

                const history = await clientOps.getClientHistory({ clientMac: mac, roamTimeline: true });

                expect(history.roams).toEqual([]);
            });

            it('should honour a custom maxGapSeconds', async () => {
                mockPage([wireless(0, 10_000, 'AP-A'), wireless(200_000, 210_000, 'AP-B')]);

                const history = await clientOps.getClientHistory({ clientMac: mac, roamTimeline: true, maxGapSeconds: 300 });

                expect(history.roams).toHaveLength(1);
            });
        });
    });
});
