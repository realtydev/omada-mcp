import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InternalRequestHandler } from '../../src/omadaClient/internalRequest.js';
import { MonitoringOperations } from '../../src/omadaClient/monitoring.js';
import type { RequestHandler } from '../../src/omadaClient/request.js';
import type { SiteOperations } from '../../src/omadaClient/site.js';

describe('MonitoringOperations', () => {
    let ops: MonitoringOperations;
    const request = {
        get: vi.fn(),
        fetchPaginated: vi.fn(),
        ensureSuccess: vi.fn((response) => {
            if (response.errorCode !== 0) throw new Error(response.msg);
            return response.result;
        }),
    };
    const site = { resolveSiteId: vi.fn((id?: string) => id ?? 'default-site') };
    beforeEach(() => {
        vi.clearAllMocks();
        ops = new MonitoringOperations(
            request as unknown as RequestHandler,
            site as unknown as SiteOperations,
            (path) => `/openapi/v1/controller${path}`
        );
    });

    it('uses exact paginated VPN paths and protocol filters', async () => {
        request.fetchPaginated.mockResolvedValue([{ status: 1 }]);
        await expect(ops.listVpnConnections({ kind: 's2s', vpnType: 2, siteId: 'site/one' })).resolves.toEqual([{ status: 1 }]);
        expect(request.fetchPaginated).toHaveBeenCalledWith(
            '/openapi/v1/controller/sites/site%2Fone/setting/vpn/stats/s2s',
            { 'filters.vpnType': 2 },
            100
        );
    });

    it('defaults to traditional tunnel status without inventing filters', async () => {
        request.fetchPaginated.mockResolvedValue([]);
        await expect(ops.listVpnConnections()).resolves.toEqual([]);
        expect(request.fetchPaginated).toHaveBeenCalledWith('/openapi/v1/controller/sites/default-site/setting/vpn/stats/tunnel', {}, 100);
    });

    it.each(['server', 'client'] as const)('preserves protocol zero for %s status', async (kind) => {
        request.fetchPaginated.mockResolvedValue([]);
        await expect(ops.listVpnConnections({ kind, vpnType: 0 })).resolves.toEqual([]);
        expect(request.fetchPaginated).toHaveBeenCalledWith(
            `/openapi/v1/controller/sites/default-site/setting/vpn/stats/${kind}`,
            { 'filters.vpnType': 0 },
            100
        );
    });

    it.each(['s2s', 'server', 'client'] as const)('requires a protocol for %s without trying a rejected request', async (kind) => {
        await expect(ops.listVpnConnections({ kind })).rejects.toThrow('vpnType is required');
        expect(request.fetchPaginated).not.toHaveBeenCalled();
    });

    it('preserves VPN controller errors', async () => {
        request.fetchPaginated.mockRejectedValue(new Error('Unsupported request path'));
        await expect(ops.listVpnConnections()).rejects.toThrow('Unsupported request path');
    });

    it('reads existing speed results with encoded identifiers without triggering a test', async () => {
        const payload = { status: 0, portSpeedResults: [] };
        request.get.mockResolvedValue({ errorCode: 0, result: payload });
        await expect(ops.getGatewayWanSpeedTestResults('AA/BB', 'site/one')).resolves.toEqual(payload);
        expect(request.get).toHaveBeenCalledExactlyOnceWith('/openapi/v1/controller/sites/site%2Fone/gateways/AA%2FBB/speedTestResult');
    });

    it('requires configured web credentials for topology', async () => {
        await expect(ops.getSiteTopology()).rejects.toThrow('OMADA_WEB_USERNAME');
        expect(request.get).not.toHaveBeenCalled();
    });

    it('unwraps topology without dropping uplink or firmware fields', async () => {
        const topology = { topologyArray: [{ type: 'gateway', successors: [{ type: 'ap', wireUpLink: { linkSpeed: 2500 } }] }], lastUpdateTime: 42 };
        const internal = { get: vi.fn().mockResolvedValue({ errorCode: 0, result: topology }), ensureSuccess: request.ensureSuccess };
        ops.setInternalRequest(internal as unknown as InternalRequestHandler);
        await expect(ops.getSiteTopology('site/one')).resolves.toEqual(topology);
        expect(internal.get).toHaveBeenCalledWith('/sites/site%2Fone/topology');
    });
});
