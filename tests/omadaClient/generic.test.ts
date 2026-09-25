import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GenericOperations } from '../../src/omadaClient/generic.js';
import type { RequestHandler } from '../../src/omadaClient/request.js';

describe('GenericOperations', () => {
    let genericOps: GenericOperations;
    let mockRequest: RequestHandler;
    let mockBuildPath: (path: string, version?: string) => string;

    beforeEach(() => {
        mockRequest = {
            request: vi.fn(),
        } as unknown as RequestHandler;

        mockBuildPath = vi.fn((path: string, version = 'v1') => `/openapi/${version}/test-omadac${path}`);

        genericOps = new GenericOperations(mockRequest, mockBuildPath);
    });

    describe('genericApiCall', () => {
        it('should build the path and forward method, body, and query params', async () => {
            const mockResult = { ok: true };
            vi.mocked(mockRequest.request).mockResolvedValue(mockResult);

            const result = await genericOps.genericApiCall('POST', '/sites/site-1/firewall', 'v2', { name: 'rule' }, { page: 1 });

            expect(mockBuildPath).toHaveBeenCalledWith('/sites/site-1/firewall', 'v2');
            expect(mockRequest.request).toHaveBeenCalledWith({
                method: 'POST',
                url: '/openapi/v2/test-omadac/sites/site-1/firewall',
                data: { name: 'rule' },
                params: { page: 1 },
            });
            expect(result).toEqual(mockResult);
        });

        it('should default to v1 when version is not provided', async () => {
            vi.mocked(mockRequest.request).mockResolvedValue({});

            await genericOps.genericApiCall('GET', '/sites/site-1/firewall');

            expect(mockBuildPath).toHaveBeenCalledWith('/sites/site-1/firewall', 'v1');
            expect(mockRequest.request).toHaveBeenCalledWith({
                method: 'GET',
                url: '/openapi/v1/test-omadac/sites/site-1/firewall',
                data: undefined,
                params: undefined,
            });
        });
    });
});
