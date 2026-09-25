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
});
