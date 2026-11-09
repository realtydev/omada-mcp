import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('axios');

describe('RequestHandler', () => {
    let mockAxiosInstance: {
        defaults: Record<string, unknown>;
        request: ReturnType<typeof vi.fn>;
    };
    let mockAuthManager: {
        getAccessToken: ReturnType<typeof vi.fn>;
        getAuthHeaders: ReturnType<typeof vi.fn>;
        refreshAccessToken: ReturnType<typeof vi.fn>;
        clearToken?: ReturnType<typeof vi.fn>;
        mode?: 'oauth' | 'web';
    };

    beforeEach(() => {
        mockAxiosInstance = {
            defaults: {},
            request: vi.fn(),
        };

        mockAuthManager = {
            getAccessToken: vi.fn().mockResolvedValue('test-access-token'),
            getAuthHeaders: vi.fn().mockResolvedValue({ Authorization: 'AccessToken=test-access-token' }),
            refreshAccessToken: vi.fn().mockResolvedValue(undefined),
            clearToken: vi.fn(),
        };

        vi.mocked(axios.create).mockReturnValue(mockAxiosInstance as never);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    describe('get', () => {
        it('should make a GET request with access token', async () => {
            const { RequestHandler } = await import('../../src/omadaClient/request.js');

            mockAxiosInstance.request.mockResolvedValue({
                data: { errorCode: 0, msg: 'Success', result: { data: 'test-result' } },
            });

            const handler = new RequestHandler(mockAxiosInstance as never, mockAuthManager as never);
            const result = await handler.get<{ errorCode: number; msg: string; result: { data: string } }>('/api/test');

            expect(mockAuthManager.getAuthHeaders).toHaveBeenCalled();
            expect(mockAxiosInstance.request).toHaveBeenCalledWith(
                expect.objectContaining({
                    method: 'GET',
                    url: '/api/test',
                    headers: expect.objectContaining({
                        Authorization: 'AccessToken=test-access-token',
                    }),
                })
            );
            // get returns the full OmadaApiResponse
            expect(result).toEqual({ errorCode: 0, msg: 'Success', result: { data: 'test-result' } });
        });

        it('should pass query parameters', async () => {
            const { RequestHandler } = await import('../../src/omadaClient/request.js');

            mockAxiosInstance.request.mockResolvedValue({
                data: { errorCode: 0, msg: 'Success', result: { items: [] } },
            });

            const handler = new RequestHandler(mockAxiosInstance as never, mockAuthManager as never);
            await handler.get('/api/items', { page: 1, pageSize: 50 });

            expect(mockAxiosInstance.request).toHaveBeenCalledWith(
                expect.objectContaining({
                    params: { page: 1, pageSize: 50 },
                })
            );
        });
    });

    describe('request', () => {
        it('keeps retry errors detailed and retries authentication only once', async () => {
            const { RequestHandler } = await import('../../src/omadaClient/request.js');
            vi.mocked(axios.isAxiosError).mockReturnValue(true);
            mockAxiosInstance.request
                .mockRejectedValueOnce({ response: { status: 401, data: { errorCode: -44106, msg: 'Expired' } } })
                .mockRejectedValueOnce({ response: { status: 403, data: { errorCode: -44112, msg: 'Still unauthorized' } } });
            const handler = new RequestHandler(mockAxiosInstance as never, mockAuthManager as never);
            await expect(handler.get('/api/secure')).rejects.toThrow(
                'Omada API request failed: GET /api/secure (HTTP 403) (errorCode: -44112) - Still unauthorized'
            );
            expect(mockAxiosInstance.request).toHaveBeenCalledTimes(2);
            expect(mockAuthManager.clearToken).toHaveBeenCalledExactlyOnceWith({ Authorization: 'AccessToken=test-access-token' });
        });

        it.each(['session expired', 'session has expired', 'not logged in'])(
            'refreshes a web session for an explicit %s response',
            async (message) => {
                const { RequestHandler } = await import('../../src/omadaClient/request.js');
                mockAuthManager.mode = 'web';
                mockAxiosInstance.request
                    .mockResolvedValueOnce({ data: { errorCode: -1, msg: message } })
                    .mockResolvedValueOnce({ data: { errorCode: 0, result: { recovered: true } } });
                const handler = new RequestHandler(mockAxiosInstance as never, mockAuthManager as never);
                await expect(handler.get('/api/web')).resolves.toEqual({ errorCode: 0, result: { recovered: true } });
                expect(mockAxiosInstance.request).toHaveBeenCalledTimes(2);
                expect(mockAuthManager.clearToken).toHaveBeenCalledTimes(1);
            }
        );

        it('does not apply web-session message heuristics to OAuth responses', async () => {
            const { RequestHandler } = await import('../../src/omadaClient/request.js');
            mockAuthManager.mode = 'oauth';
            mockAxiosInstance.request.mockResolvedValue({ data: { errorCode: -1, msg: 'not logged in' } });
            const handler = new RequestHandler(mockAxiosInstance as never, mockAuthManager as never);
            await expect(handler.get('/api/oauth')).resolves.toEqual({ errorCode: -1, msg: 'not logged in' });
            expect(mockAuthManager.clearToken).not.toHaveBeenCalled();
            expect(mockAxiosInstance.request).toHaveBeenCalledTimes(1);
        });

        it('bounds retries for repeated HTTP 200 authentication failures', async () => {
            const { RequestHandler } = await import('../../src/omadaClient/request.js');
            mockAxiosInstance.request.mockResolvedValue({ data: { errorCode: -44106, msg: 'Expired' } });
            const handler = new RequestHandler(mockAxiosInstance as never, mockAuthManager as never);
            await expect(handler.get('/api/oauth')).resolves.toEqual({ errorCode: -44106, msg: 'Expired' });
            expect(mockAuthManager.clearToken).toHaveBeenCalledTimes(1);
            expect(mockAxiosInstance.request).toHaveBeenCalledTimes(2);
        });

        it('should handle successful response', async () => {
            const { RequestHandler } = await import('../../src/omadaClient/request.js');

            mockAxiosInstance.request.mockResolvedValue({
                data: { errorCode: 0, msg: 'Success', result: { value: 42 } },
            });

            const handler = new RequestHandler(mockAxiosInstance as never, mockAuthManager as never);
            const result = await handler.request<{ errorCode: number; msg: string; result: { value: number } }>({
                method: 'POST',
                url: '/api/action',
            });

            // request returns the full axios response data (OmadaApiResponse)
            expect(result).toEqual({ errorCode: 0, msg: 'Success', result: { value: 42 } });
        });

        it('should retry on 401 error and refresh token', async () => {
            const { RequestHandler } = await import('../../src/omadaClient/request.js');

            // Mock axios.isAxiosError to return true for our error object
            vi.mocked(axios.isAxiosError).mockReturnValue(true);

            const error401 = {
                response: { status: 401, data: { msg: 'Invalid token' } },
                isAxiosError: true,
            };

            // First request fails with 401
            mockAxiosInstance.request
                .mockRejectedValueOnce(error401)
                // Second request succeeds after token refresh
                .mockResolvedValueOnce({
                    data: { errorCode: 0, msg: 'Success', result: { refreshed: true } },
                });

            mockAuthManager.clearToken = vi.fn();

            const handler = new RequestHandler(mockAxiosInstance as never, mockAuthManager as never);
            const result = await handler.request<{ errorCode: number; msg: string; result: { refreshed: boolean } }>({
                method: 'GET',
                url: '/api/secure',
            });

            expect(mockAuthManager.clearToken).toHaveBeenCalledTimes(1);
            expect(mockAxiosInstance.request).toHaveBeenCalledTimes(2);
            expect(result).toEqual({ errorCode: 0, msg: 'Success', result: { refreshed: true } });
        });

        it('should not retry on 401 if retry=false', async () => {
            const { RequestHandler } = await import('../../src/omadaClient/request.js');

            mockAxiosInstance.request.mockRejectedValue({
                response: { status: 401, data: { msg: 'Invalid token' } },
                isAxiosError: true,
            });

            const handler = new RequestHandler(mockAxiosInstance as never, mockAuthManager as never);

            await expect(handler.request<unknown>({ method: 'GET', url: '/api/secure' }, false)).rejects.toThrow();

            expect(mockAuthManager.refreshAccessToken).not.toHaveBeenCalled();
            expect(mockAxiosInstance.request).toHaveBeenCalledTimes(1);
        });

        it('should retry on token expiration error message', async () => {
            const { RequestHandler } = await import('../../src/omadaClient/request.js');

            // Mock axios.isAxiosError to return true for our error object
            vi.mocked(axios.isAxiosError).mockReturnValue(true);

            const tokenExpiredError = {
                response: {
                    status: 200, // Sometimes errors come with 200 status
                    data: {
                        errorCode: -1,
                        msg: 'The access token has expired. Please re-initiate the refreshToken process to obtain the access token.',
                    },
                },
                isAxiosError: true,
            };

            // First request fails with token expired message
            mockAxiosInstance.request
                .mockResolvedValueOnce({
                    data: tokenExpiredError.response.data,
                })
                // Second request succeeds after token refresh
                .mockResolvedValueOnce({
                    data: { errorCode: 0, msg: 'Success', result: { refreshed: true } },
                });

            mockAuthManager.clearToken = vi.fn();

            const handler = new RequestHandler(mockAxiosInstance as never, mockAuthManager as never);
            const result = await handler.request<{ errorCode: number; msg: string; result?: { refreshed: boolean } }>({
                method: 'GET',
                url: '/api/secure',
            });

            expect(mockAuthManager.clearToken).toHaveBeenCalledTimes(1);
            expect(mockAxiosInstance.request).toHaveBeenCalledTimes(2);
            expect(result).toEqual({ errorCode: 0, msg: 'Success', result: { refreshed: true } });
        });

        it('should retry on various token expiration messages', async () => {
            const { RequestHandler } = await import('../../src/omadaClient/request.js');

            const expirationMessages = [
                'Token expired',
                'token has expired',
                'ACCESS TOKEN HAS EXPIRED',
                'Please re-initiate the refreshToken process',
            ];

            for (const msg of expirationMessages) {
                mockAxiosInstance.request
                    .mockResolvedValueOnce({
                        data: { errorCode: -1, msg },
                    })
                    .mockResolvedValueOnce({
                        data: { errorCode: 0, msg: 'Success', result: {} },
                    });

                mockAuthManager.clearToken = vi.fn();

                const handler = new RequestHandler(mockAxiosInstance as never, mockAuthManager as never);
                await handler.request({ method: 'GET', url: '/api/test' });

                expect(mockAuthManager.clearToken).toHaveBeenCalledTimes(1);
            }
        });

        it('should retry on auth error codes', async () => {
            const { RequestHandler } = await import('../../src/omadaClient/request.js');

            const authErrorCodes = [-44106, -44111, -44112, -44113, -44114, -44116];

            for (const errorCode of authErrorCodes) {
                mockAxiosInstance.request
                    .mockResolvedValueOnce({
                        data: { errorCode, msg: 'Auth error' },
                    })
                    .mockResolvedValueOnce({
                        data: { errorCode: 0, msg: 'Success', result: {} },
                    });

                mockAuthManager.clearToken = vi.fn();

                const handler = new RequestHandler(mockAxiosInstance as never, mockAuthManager as never);
                await handler.request({ method: 'GET', url: '/api/test' });

                expect(mockAuthManager.clearToken).toHaveBeenCalledTimes(1);
            }
        });

        it('should return response with errorCode without throwing', async () => {
            const { RequestHandler } = await import('../../src/omadaClient/request.js');

            mockAxiosInstance.request.mockResolvedValue({
                data: { errorCode: 1234, msg: 'Something went wrong' },
            });

            const handler = new RequestHandler(mockAxiosInstance as never, mockAuthManager as never);
            const result = await handler.request<{ errorCode: number; msg: string }>({ method: 'GET', url: '/api/fails' });

            // request doesn't check errorCode, it just returns the response
            // ensureSuccess() is responsible for throwing on non-zero errorCode
            expect(result).toEqual({ errorCode: 1234, msg: 'Something went wrong' });
        });

        it('should handle network errors', async () => {
            const { RequestHandler } = await import('../../src/omadaClient/request.js');

            mockAxiosInstance.request.mockRejectedValue(new Error('Network timeout'));

            const handler = new RequestHandler(mockAxiosInstance as never, mockAuthManager as never);

            await expect(handler.request<unknown>({ method: 'GET', url: '/api/network' })).rejects.toThrow('Network timeout');
        });
    });

    describe('fetchPaginated', () => {
        it('should fetch all pages until totalRows is reached', async () => {
            const { RequestHandler } = await import('../../src/omadaClient/request.js');

            // First page
            mockAxiosInstance.request
                .mockResolvedValueOnce({
                    data: {
                        errorCode: 0,
                        msg: 'Success',
                        result: {
                            data: [{ id: 1 }, { id: 2 }],
                            totalRows: 3,
                        },
                    },
                })
                // Second page
                .mockResolvedValueOnce({
                    data: {
                        errorCode: 0,
                        msg: 'Success',
                        result: {
                            data: [{ id: 3 }],
                            totalRows: 3,
                        },
                    },
                });

            const handler = new RequestHandler(mockAxiosInstance as never, mockAuthManager as never);
            const result = await handler.fetchPaginated<{ id: number }>('/api/items');

            expect(mockAxiosInstance.request).toHaveBeenCalledTimes(2);
            expect(result).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
        });

        it('rejects a premature empty page instead of returning a partial collection', async () => {
            const { RequestHandler } = await import('../../src/omadaClient/request.js');

            mockAxiosInstance.request
                .mockResolvedValueOnce({
                    data: {
                        errorCode: 0,
                        msg: 'Success',
                        result: {
                            data: [{ id: 1 }],
                            totalRows: 10,
                        },
                    },
                })
                .mockResolvedValueOnce({
                    data: {
                        errorCode: 0,
                        msg: 'Success',
                        result: {
                            data: [],
                            totalRows: 10,
                        },
                    },
                });

            const handler = new RequestHandler(mockAxiosInstance as never, mockAuthManager as never);
            await expect(handler.fetchPaginated<{ id: number }>('/api/items')).rejects.toThrow('empty page arrived before totalRows');
            expect(mockAxiosInstance.request).toHaveBeenCalledTimes(2);
        });

        it.each([undefined, null, [], {}, { data: null }, { data: {} }, { data: 'not rows' }])(
            'rejects malformed successful result %s instead of treating it as an empty collection',
            async (result) => {
                const { RequestHandler } = await import('../../src/omadaClient/request.js');
                mockAxiosInstance.request.mockResolvedValue({ data: { errorCode: 0, result } });
                const handler = new RequestHandler(mockAxiosInstance as never, mockAuthManager as never);
                await expect(handler.fetchPaginated('/api/items')).rejects.toThrow('expected a result object with a data array');
                expect(mockAxiosInstance.request).toHaveBeenCalledTimes(1);
            }
        );

        it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, null, '2'])(
            'rejects invalid totalRows %s',
            async (totalRows) => {
                const { RequestHandler } = await import('../../src/omadaClient/request.js');
                mockAxiosInstance.request.mockResolvedValue({ data: { errorCode: 0, result: { data: [], totalRows } } });
                const handler = new RequestHandler(mockAxiosInstance as never, mockAuthManager as never);
                await expect(handler.fetchPaginated('/api/items')).rejects.toThrow('totalRows must be a non-negative safe integer');
            }
        );

        it('accepts a verified empty collection with totalRows zero', async () => {
            const { RequestHandler } = await import('../../src/omadaClient/request.js');
            mockAxiosInstance.request.mockResolvedValue({ data: { errorCode: 0, result: { data: [], totalRows: 0, currentPage: 1 } } });
            const handler = new RequestHandler(mockAxiosInstance as never, mockAuthManager as never);
            await expect(handler.fetchPaginated('/api/items')).resolves.toEqual([]);
            expect(mockAxiosInstance.request).toHaveBeenCalledTimes(1);
        });

        it('collects through a terminal empty page when totals are absent', async () => {
            const { RequestHandler } = await import('../../src/omadaClient/request.js');
            mockAxiosInstance.request
                .mockResolvedValueOnce({ data: { errorCode: 0, result: { data: [{ id: 1 }], currentPage: 1 } } })
                .mockResolvedValueOnce({ data: { errorCode: 0, result: { data: [{ id: 2 }], currentPage: 2 } } })
                .mockResolvedValueOnce({ data: { errorCode: 0, result: { data: [], currentPage: 3 } } });
            const handler = new RequestHandler(mockAxiosInstance as never, mockAuthManager as never);
            await expect(handler.fetchPaginated('/api/items')).resolves.toEqual([{ id: 1 }, { id: 2 }]);
            expect(mockAxiosInstance.request).toHaveBeenCalledTimes(3);
        });

        it('rejects totals changing mid-read rather than claiming snapshot completeness', async () => {
            const { RequestHandler } = await import('../../src/omadaClient/request.js');
            mockAxiosInstance.request
                .mockResolvedValueOnce({ data: { errorCode: 0, result: { data: [{ id: 1 }], totalRows: 3 } } })
                .mockResolvedValueOnce({ data: { errorCode: 0, result: { data: [{ id: 2 }], totalRows: 2 } } });
            const handler = new RequestHandler(mockAxiosInstance as never, mockAuthManager as never);
            await expect(handler.fetchPaginated('/api/items')).rejects.toThrow('totalRows changed during collection');
        });

        it.each([0, 1])('rejects record counts exceeding declared totalRows %s', async (totalRows) => {
            const { RequestHandler } = await import('../../src/omadaClient/request.js');
            mockAxiosInstance.request.mockResolvedValue({ data: { errorCode: 0, result: { data: [{ id: 1 }, { id: 2 }], totalRows } } });
            const handler = new RequestHandler(mockAxiosInstance as never, mockAuthManager as never);
            await expect(handler.fetchPaginated('/api/items')).rejects.toThrow('more records than totalRows');
        });

        it('rejects a controller that repeats a page instead of confirming absence from duplicate rows', async () => {
            const { RequestHandler } = await import('../../src/omadaClient/request.js');
            mockAxiosInstance.request.mockResolvedValue({ data: { errorCode: 0, result: { data: [{ mac: 'AA-BB-CC-DD-EE-FF' }], totalRows: 2 } } });
            const handler = new RequestHandler(mockAxiosInstance as never, mockAuthManager as never);
            await expect(handler.fetchPaginated('/api/items')).rejects.toThrow('a non-empty page repeated');
            expect(mockAxiosInstance.request).toHaveBeenCalledTimes(2);
        });

        it('rejects non-advancing page metadata', async () => {
            const { RequestHandler } = await import('../../src/omadaClient/request.js');
            mockAxiosInstance.request
                .mockResolvedValueOnce({ data: { errorCode: 0, result: { data: [{ id: 1 }], currentPage: 1 } } })
                .mockResolvedValueOnce({ data: { errorCode: 0, result: { data: [{ id: 2 }], currentPage: 1 } } });
            const handler = new RequestHandler(mockAxiosInstance as never, mockAuthManager as never);
            await expect(handler.fetchPaginated('/api/items')).rejects.toThrow('did not return requested page 2');
        });

        it('fails explicitly at the finite page ceiling without returning partial records', async () => {
            const { RequestHandler } = await import('../../src/omadaClient/request.js');
            vi.useFakeTimers();
            try {
                mockAxiosInstance.request.mockImplementation(async (config) => ({
                    data: { errorCode: 0, result: { data: [{ id: config.params.page }] } },
                }));
                const handler = new RequestHandler(mockAxiosInstance as never, mockAuthManager as never);
                const result = expect(handler.fetchPaginated('/api/items')).rejects.toThrow('1000-page safety limit');
                await vi.runAllTimersAsync();
                await result;
                expect(mockAxiosInstance.request).toHaveBeenCalledTimes(1000);
            } finally {
                vi.useRealTimers();
            }
        });

        it('supports a smaller endpoint-specific page size without changing the default call shape', async () => {
            const { RequestHandler } = await import('../../src/omadaClient/request.js');
            mockAxiosInstance.request.mockResolvedValue({ data: { errorCode: 0, result: { data: [], totalRows: 0 } } });
            const handler = new RequestHandler(mockAxiosInstance as never, mockAuthManager as never);
            await handler.fetchPaginated('/api/vpn', { 'filters.vpnType': 5 }, 100);
            expect(mockAxiosInstance.request).toHaveBeenCalledWith(
                expect.objectContaining({
                    params: { 'filters.vpnType': 5, page: 1, pageSize: 100 },
                })
            );
        });

        it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1001])('rejects invalid pageSize %s before requesting', async (pageSize) => {
            const { RequestHandler } = await import('../../src/omadaClient/request.js');
            const handler = new RequestHandler(mockAxiosInstance as never, mockAuthManager as never);
            await expect(handler.fetchPaginated('/api/items', {}, pageSize)).rejects.toThrow('integer between 1 and 1000');
            expect(mockAxiosInstance.request).not.toHaveBeenCalled();
        });

        it('should pass additional params to each page request', async () => {
            const { RequestHandler } = await import('../../src/omadaClient/request.js');

            mockAxiosInstance.request.mockResolvedValue({
                data: {
                    errorCode: 0,
                    msg: 'Success',
                    result: {
                        data: [],
                        totalRows: 0,
                    },
                },
            });

            const handler = new RequestHandler(mockAxiosInstance as never, mockAuthManager as never);
            await handler.fetchPaginated('/api/items', { siteId: 'test-site', filter: 'active' });

            expect(mockAxiosInstance.request).toHaveBeenCalledWith(
                expect.objectContaining({
                    params: expect.objectContaining({
                        page: 1,
                        pageSize: 200,
                        siteId: 'test-site',
                        filter: 'active',
                    }),
                })
            );
        });
    });

    describe('ensureSuccess', () => {
        it('preserves the numeric controller code without attaching the response payload', async () => {
            const { RequestHandler } = await import('../../src/omadaClient/request.js');
            const handler = new RequestHandler(mockAxiosInstance as never, mockAuthManager as never);
            try {
                handler.ensureSuccess({ errorCode: -1600, msg: 'Unavailable', result: { privateData: 'not-attached' } });
                expect.fail('Expected a controller rejection');
            } catch (error) {
                expect(error).toMatchObject({ message: 'Unavailable', errorCode: -1600 });
                expect(error).not.toHaveProperty('response');
                expect(error).not.toHaveProperty('result');
            }
        });
        it('should return result for successful response', async () => {
            const { RequestHandler } = await import('../../src/omadaClient/request.js');

            const handler = new RequestHandler(mockAxiosInstance as never, mockAuthManager as never);
            const result = handler.ensureSuccess({
                errorCode: 0,
                msg: 'Success',
                result: { value: 123 },
            });

            expect(result).toEqual({ value: 123 });
        });

        it('should throw error for non-zero errorCode', async () => {
            const { RequestHandler } = await import('../../src/omadaClient/request.js');

            const handler = new RequestHandler(mockAxiosInstance as never, mockAuthManager as never);

            expect(() =>
                handler.ensureSuccess({
                    errorCode: 1001,
                    msg: 'Invalid parameters',
                    result: null,
                })
            ).toThrow('Invalid parameters');
        });

        it('should return empty object if result is missing', async () => {
            const { RequestHandler } = await import('../../src/omadaClient/request.js');

            const handler = new RequestHandler(mockAxiosInstance as never, mockAuthManager as never);
            const result = handler.ensureSuccess({
                errorCode: 0,
                msg: 'Success',
                result: undefined,
            });

            expect(result).toEqual({});
        });
    });

    describe('debug logging', () => {
        it.each(['negative-envelope', 'http-error', 'transport-error', 'string-body', 'object-body', 'auth-warning'])(
            'redacts submitted security keys echoed in %s logs and errors',
            async (kind) => {
                const { RequestHandler } = await import('../../src/omadaClient/request.js');
                const { logger } = await import('../../src/utils/logger.js');
                const logs = [vi.spyOn(logger, 'info'), vi.spyOn(logger, 'debug'), vi.spyOn(logger, 'warn'), vi.spyOn(logger, 'error')];
                for (const log of logs) log.mockImplementation(() => undefined);
                const secret = 'vendor-echoed-security-key';
                const message = `Rejected ${secret}`;
                const handler = new RequestHandler(mockAxiosInstance as never, mockAuthManager as never);
                vi.mocked(axios.isAxiosError).mockReturnValue(true);
                if (kind === 'negative-envelope' || kind === 'auth-warning') {
                    mockAxiosInstance.request.mockResolvedValue({
                        status: 200,
                        data: { errorCode: kind === 'auth-warning' ? -44106 : -1, msg: message },
                    });
                    const result = await handler.post('/api/ssid', { pskSetting: { securityKey: secret } });
                    expect(JSON.stringify(result)).not.toContain(secret);
                    expect(() => handler.ensureSuccess(result as never)).toThrow('Rejected [redacted]');
                } else {
                    const error = Object.assign(new Error(message), {
                        isAxiosError: true,
                        ...(kind === 'transport-error'
                            ? {}
                            : {
                                  response: {
                                      status: 400,
                                      data: kind === 'string-body' ? message : kind === 'object-body' ? { reason: message } : { msg: message },
                                  },
                              }),
                    });
                    mockAxiosInstance.request.mockRejectedValue(error);
                    await expect(handler.post('/api/ssid', { pskSetting: { securityKey: secret } })).rejects.not.toThrow(secret);
                }
                expect(JSON.stringify(logs.flatMap((log) => log.mock.calls))).not.toContain(secret);
                for (const log of logs) log.mockRestore();
            }
        );

        it('returns successful API data unchanged while redacting its log copy', async () => {
            const { RequestHandler } = await import('../../src/omadaClient/request.js');
            const { logger } = await import('../../src/utils/logger.js');
            const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
            const data = { errorCode: 0, result: { securityKey: 'preserved-config', note: 'preserved-config', channel: 36 } };
            mockAxiosInstance.request.mockResolvedValue({ status: 200, data });
            const handler = new RequestHandler(mockAxiosInstance as never, mockAuthManager as never);
            expect(await handler.post('/api/ssid', { securityKey: 'preserved-config' })).toBe(data);
            expect(JSON.stringify(debug.mock.calls)).not.toContain('preserved-config');
            expect(JSON.stringify(debug.mock.calls)).toContain('"channel":36');
            debug.mockRestore();
        });

        it('redacts discovered query credentials and JSON request/response secrets', async () => {
            const { RequestHandler } = await import('../../src/omadaClient/request.js');
            const { logger } = await import('../../src/utils/logger.js');
            const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
            const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
            mockAxiosInstance.request.mockResolvedValue({ status: 200, headers: {}, data: { errorCode: 0, result: { apiKey: 'returned-key' } } });
            const handler = new RequestHandler(mockAxiosInstance as never, mockAuthManager as never);
            await handler.post('/api/test', { psk: 'wireless-password', privateKey: 'private-key-material' }, { password: 'query-secret', page: 1 });
            const output = JSON.stringify([...info.mock.calls, ...debug.mock.calls]);
            for (const secret of ['returned-key', 'wireless-password', 'private-key-material', 'query-secret']) expect(output).not.toContain(secret);
            expect(output).toContain('"page":1');
            info.mockRestore();
            debug.mockRestore();
        });
        it('never logs the web session cookie in request or response headers', async () => {
            const { RequestHandler } = await import('../../src/omadaClient/request.js');
            const { logger } = await import('../../src/utils/logger.js');
            const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
            const session = 'TPOMADA_SESSIONID=5f2b8c1d9e7a4b3c';

            mockAuthManager.getAuthHeaders.mockResolvedValue({ Cookie: session, 'Csrf-Token': 'csrf-abcdef123456' });
            mockAxiosInstance.request.mockResolvedValue({
                status: 200,
                headers: { 'set-cookie': `${session}; Path=/; HttpOnly` },
                data: { errorCode: 0, result: {} },
            });

            const handler = new RequestHandler(mockAxiosInstance as never, mockAuthManager as never);
            await handler.get('/api/test');

            expect(JSON.stringify(debug.mock.calls)).not.toContain('5f2b8c1d9e7a4b3c');
            debug.mockRestore();
        });
    });
});
