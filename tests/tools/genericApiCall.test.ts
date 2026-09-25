import { describe, expect, it, vi } from 'vitest';

describe('registerGenericApiCallTool', () => {
    it('should register the tool and pass call args through to the client', async () => {
        const { registerGenericApiCallTool } = await import('../../src/tools/genericApiCall.js');

        const mockClient = { genericApiCall: vi.fn().mockResolvedValue({}) };
        const mockServer = {
            registerTool: vi.fn((_, _schema, handler) =>
                handler(
                    {
                        method: 'GET',
                        path: '/sites/test-site/firewall',
                        version: 'v1',
                        body: undefined,
                        queryParams: { page: 1 },
                    },
                    {}
                )
            ),
        };

        registerGenericApiCallTool(mockServer as never, mockClient as never);

        expect(mockServer.registerTool).toHaveBeenCalledWith(
            'genericApiCall',
            expect.objectContaining({ description: expect.any(String) }),
            expect.any(Function)
        );
        expect(mockClient.genericApiCall).toHaveBeenCalledWith('GET', '/sites/test-site/firewall', 'v1', undefined, { page: 1 });
    });
});
