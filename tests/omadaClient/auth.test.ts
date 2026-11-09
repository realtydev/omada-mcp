import type { AxiosInstance } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthManager, WebAuthManager } from '../../src/omadaClient/auth.js';
import type { OmadaApiResponse, TokenResult } from '../../src/types/index.js';
import * as loggerModule from '../../src/utils/logger.js';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

const oauthResponse = (accessToken: string, expiresIn = 3600) => ({
    data: { errorCode: 0, result: { accessToken, refreshToken: `${accessToken}-refresh`, expiresIn, tokenType: 'Bearer' } },
});

describe('AuthManager', () => {
    let authManager: AuthManager;
    let mockHttp: AxiosInstance;
    const clientId = 'test-client-id';
    const clientSecret = 'test-client-secret';
    const omadacId = 'test-omadac-id';

    beforeEach(() => {
        mockHttp = {
            defaults: { baseURL: 'https://test.example.com' },
            post: vi.fn(),
        } as unknown as AxiosInstance;

        authManager = new AuthManager(mockHttp, clientId, clientSecret, omadacId);

        // Mock logger to avoid console output during tests
        vi.spyOn(loggerModule.logger, 'error').mockImplementation(() => {
            // Mock implementation
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('concurrent token lifecycle', () => {
        it('shares one cold login across concurrent callers', async () => {
            vi.mocked(mockHttp.post).mockResolvedValue(oauthResponse('shared-token'));
            const tokens = await Promise.all(Array.from({ length: 10 }, () => authManager.getAccessToken()));
            expect(tokens).toEqual(Array(10).fill('shared-token'));
            expect(mockHttp.post).toHaveBeenCalledTimes(1);
        });

        it('shares one refresh for expired tokens', async () => {
            vi.mocked(mockHttp.post).mockResolvedValueOnce(oauthResponse('initial', 1)).mockResolvedValueOnce(oauthResponse('refreshed'));
            await authManager.getAccessToken();
            await expect(Promise.all(Array.from({ length: 10 }, () => authManager.getAccessToken()))).resolves.toEqual(Array(10).fill('refreshed'));
            expect(mockHttp.post).toHaveBeenCalledTimes(2);
            expect(mockHttp.post).toHaveBeenLastCalledWith(
                '/openapi/authorize/token',
                { client_id: clientId, client_secret: clientSecret },
                { params: { grant_type: 'refresh_token', refresh_token: 'initial-refresh' } }
            );
        });

        it('shares one credentials fallback when a refresh fails', async () => {
            vi.mocked(mockHttp.post)
                .mockResolvedValueOnce(oauthResponse('initial', 1))
                .mockRejectedValueOnce(new Error('Refresh rejected'))
                .mockResolvedValueOnce(oauthResponse('replacement'));
            await authManager.getAccessToken();
            await expect(Promise.all(Array.from({ length: 10 }, () => authManager.getAccessToken()))).resolves.toEqual(Array(10).fill('replacement'));
            expect(mockHttp.post).toHaveBeenCalledTimes(3);
        });

        it('releases failed authentication so the next batch can retry', async () => {
            vi.mocked(mockHttp.post).mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValueOnce(oauthResponse('recovered'));
            const failures = await Promise.allSettled(Array.from({ length: 3 }, () => authManager.getAccessToken()));
            expect(failures.every((result) => result.status === 'rejected')).toBe(true);
            expect(mockHttp.post).toHaveBeenCalledTimes(1);
            await expect(authManager.getAccessToken()).resolves.toBe('recovered');
            expect(mockHttp.post).toHaveBeenCalledTimes(2);
        });

        it.each(['success', 'failure'] as const)('discards an invalidated login with a late %s', async (outcome) => {
            const oldLogin = deferred<ReturnType<typeof oauthResponse>>();
            vi.mocked(mockHttp.post).mockReturnValueOnce(oldLogin.promise).mockResolvedValueOnce(oauthResponse('current'));
            const oldCaller = authManager.getAccessToken();
            authManager.clearToken();
            await expect(authManager.getAccessToken()).resolves.toBe('current');
            if (outcome === 'success') {
                oldLogin.resolve(oauthResponse('obsolete'));
            } else {
                oldLogin.reject(new Error('Old request failed'));
            }
            await expect(oldCaller).resolves.toBe('current');
            await expect(authManager.getAccessToken()).resolves.toBe('current');
            expect(mockHttp.post).toHaveBeenCalledTimes(2);
        });

        it('ignores late rejections of old headers while fresh authentication is pending', async () => {
            const freshLogin = deferred<ReturnType<typeof oauthResponse>>();
            vi.mocked(mockHttp.post).mockResolvedValueOnce(oauthResponse('old')).mockReturnValueOnce(freshLogin.promise);
            const oldHeaders = await authManager.getAuthHeaders();
            authManager.clearToken(oldHeaders);
            const first = authManager.getAuthHeaders();
            authManager.clearToken(oldHeaders);
            const second = authManager.getAuthHeaders();
            freshLogin.resolve(oauthResponse('current'));
            await expect(Promise.all([first, second])).resolves.toEqual([
                { Authorization: 'AccessToken=current' },
                { Authorization: 'AccessToken=current' },
            ]);
            authManager.clearToken(oldHeaders);
            await expect(authManager.getAccessToken()).resolves.toBe('current');
            expect(mockHttp.post).toHaveBeenCalledTimes(2);
        });

        it('rejects successful envelopes that omit the access token and allows retry', async () => {
            vi.mocked(mockHttp.post)
                .mockResolvedValueOnce({ data: { errorCode: 0, result: {} } })
                .mockResolvedValueOnce(oauthResponse('valid'));
            await expect(authManager.getAccessToken()).rejects.toThrow('no access token');
            await expect(authManager.getAccessToken()).resolves.toBe('valid');
        });
    });

    describe('getAccessToken', () => {
        it('should authenticate and return access token on first call', async () => {
            const mockToken: TokenResult = {
                accessToken: 'test-access-token',
                refreshToken: 'test-refresh-token',
                expiresIn: 3600,
                tokenType: 'Bearer',
            };

            const mockResponse: OmadaApiResponse<TokenResult> = {
                errorCode: 0,
                msg: 'Success',
                result: mockToken,
            };

            (mockHttp.post as ReturnType<typeof vi.fn>).mockResolvedValue({ data: mockResponse });

            const token = await authManager.getAccessToken();

            expect(token).toBe('test-access-token');
            expect(mockHttp.post).toHaveBeenCalledWith(
                '/openapi/authorize/token',
                {
                    client_id: clientId,
                    client_secret: clientSecret,
                    omadacId: omadacId,
                },
                { params: { grant_type: 'client_credentials' } }
            );
        });

        it('should return cached token if still valid', async () => {
            const mockToken: TokenResult = {
                accessToken: 'cached-token',
                refreshToken: 'cached-refresh',
                expiresIn: 3600,
                tokenType: 'Bearer',
            };

            const mockResponse: OmadaApiResponse<TokenResult> = {
                errorCode: 0,
                msg: 'Success',
                result: mockToken,
            };

            (mockHttp.post as ReturnType<typeof vi.fn>).mockResolvedValue({ data: mockResponse });

            // First call to set token
            const token1 = await authManager.getAccessToken();
            expect(token1).toBe('cached-token');

            // Second call should use cached token
            const token2 = await authManager.getAccessToken();
            expect(token2).toBe('cached-token');
            expect(mockHttp.post).toHaveBeenCalledTimes(1); // Only called once
        });

        it('should refresh token when expired', async () => {
            const initialToken: TokenResult = {
                accessToken: 'initial-token',
                refreshToken: 'initial-refresh',
                expiresIn: 1, // Very short expiry
                tokenType: 'Bearer',
            };

            const refreshedToken: TokenResult = {
                accessToken: 'refreshed-token',
                refreshToken: 'refreshed-refresh',
                expiresIn: 3600,
                tokenType: 'Bearer',
            };

            const initialResponse: OmadaApiResponse<TokenResult> = {
                errorCode: 0,
                msg: 'Success',
                result: initialToken,
            };

            const refreshResponse: OmadaApiResponse<TokenResult> = {
                errorCode: 0,
                msg: 'Success',
                result: refreshedToken,
            };

            (mockHttp.post as ReturnType<typeof vi.fn>)
                .mockResolvedValueOnce({ data: initialResponse })
                .mockResolvedValueOnce({ data: refreshResponse });

            // First call
            await authManager.getAccessToken();

            // Wait for token to expire
            await new Promise((resolve) => setTimeout(resolve, 50));

            // Second call should refresh
            const token = await authManager.getAccessToken();

            expect(token).toBe('refreshed-token');
            expect(mockHttp.post).toHaveBeenCalledTimes(2);
            expect(mockHttp.post).toHaveBeenNthCalledWith(
                2,
                '/openapi/authorize/token',
                {
                    client_id: clientId,
                    client_secret: clientSecret,
                },
                { params: { grant_type: 'refresh_token', refresh_token: 'initial-refresh' } }
            );
        });

        it('should re-authenticate with client credentials if refresh fails', async () => {
            const initialToken: TokenResult = {
                accessToken: 'initial-token',
                refreshToken: 'initial-refresh',
                expiresIn: 1,
                tokenType: 'Bearer',
            };

            const newToken: TokenResult = {
                accessToken: 'new-token',
                refreshToken: 'new-refresh',
                expiresIn: 3600,
                tokenType: 'Bearer',
            };

            const initialResponse: OmadaApiResponse<TokenResult> = {
                errorCode: 0,
                msg: 'Success',
                result: initialToken,
            };

            const newResponse: OmadaApiResponse<TokenResult> = {
                errorCode: 0,
                msg: 'Success',
                result: newToken,
            };

            (mockHttp.post as ReturnType<typeof vi.fn>)
                .mockResolvedValueOnce({ data: initialResponse })
                .mockRejectedValueOnce(new Error('Refresh failed'))
                .mockResolvedValueOnce({ data: newResponse });

            // First call
            await authManager.getAccessToken();

            // Wait for token to expire
            await new Promise((resolve) => setTimeout(resolve, 50));

            // Second call should try refresh, fail, then use client_credentials
            const token = await authManager.getAccessToken();

            expect(token).toBe('new-token');
            expect(mockHttp.post).toHaveBeenCalledTimes(3);
        });

        it('should throw error if authentication fails', async () => {
            const errorResponse: OmadaApiResponse<TokenResult> = {
                errorCode: -1,
                msg: 'Authentication failed',
            };

            (mockHttp.post as ReturnType<typeof vi.fn>).mockResolvedValue({ data: errorResponse });

            await expect(authManager.getAccessToken()).rejects.toThrow('Authentication failed');
            expect(loggerModule.logger.error).toHaveBeenCalledWith(
                'Omada authentication error',
                expect.objectContaining({
                    errorCode: -1,
                    message: 'Authentication failed',
                })
            );
        });

        it('should throw error if HTTP request fails', async () => {
            (mockHttp.post as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));

            await expect(authManager.getAccessToken()).rejects.toThrow('Network error');
            expect(loggerModule.logger.error).toHaveBeenCalledWith(
                'Omada authentication failed',
                expect.objectContaining({
                    grantType: 'client_credentials',
                    error: 'Network error',
                })
            );
        });

        it('should reject a response without credentials', async () => {
            const mockResponse: OmadaApiResponse<TokenResult> = {
                errorCode: 0,
                msg: 'Success',
            };

            (mockHttp.post as ReturnType<typeof vi.fn>).mockResolvedValue({ data: mockResponse });

            await expect(authManager.getAccessToken()).rejects.toThrow('no access token');
        });

        it('should handle zero or negative expiresIn', async () => {
            const mockToken: TokenResult = {
                accessToken: 'test-token',
                refreshToken: 'test-refresh',
                expiresIn: 0,
                tokenType: 'Bearer',
            };

            const mockResponse: OmadaApiResponse<TokenResult> = {
                errorCode: 0,
                msg: 'Success',
                result: mockToken,
            };

            (mockHttp.post as ReturnType<typeof vi.fn>).mockResolvedValue({ data: mockResponse });

            const token = await authManager.getAccessToken();

            expect(token).toBe('test-token');
        });
    });

    describe('clearToken', () => {
        it('should clear all token state', async () => {
            const mockToken: TokenResult = {
                accessToken: 'test-token',
                refreshToken: 'test-refresh',
                expiresIn: 3600,
                tokenType: 'Bearer',
            };

            const mockResponse: OmadaApiResponse<TokenResult> = {
                errorCode: 0,
                msg: 'Success',
                result: mockToken,
            };

            (mockHttp.post as ReturnType<typeof vi.fn>).mockResolvedValue({ data: mockResponse });

            // Set a token
            await authManager.getAccessToken();
            expect(mockHttp.post).toHaveBeenCalledTimes(1);

            // Clear it
            authManager.clearToken();

            // Next call should re-authenticate
            await authManager.getAccessToken();
            expect(mockHttp.post).toHaveBeenCalledTimes(2);
        });
    });
});

describe('WebAuthManager', () => {
    let mockHttp: AxiosInstance;

    beforeEach(() => {
        mockHttp = {
            defaults: { baseURL: 'https://fusion.example.com' },
            post: vi.fn(),
        } as unknown as AxiosInstance;

        vi.spyOn(loggerModule.logger, 'error').mockImplementation(() => {
            // Mock implementation
        });
        vi.spyOn(loggerModule.logger, 'info').mockImplementation(() => {
            // Mock implementation
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('discards an invalidated web login instead of overwriting its replacement', async () => {
        const oldLogin = deferred<{ data: { errorCode: number; result: { token: string } }; headers: Record<string, string[]> }>();
        vi.mocked(mockHttp.post)
            .mockReturnValueOnce(oldLogin.promise)
            .mockResolvedValueOnce({
                data: { errorCode: 0, result: { token: 'current-csrf' } },
                headers: { 'set-cookie': ['SESSION=current; Path=/'] },
            });
        const auth = new WebAuthManager(mockHttp, 'admin', 'password', 'controller');
        const first = auth.getAuthHeaders();
        auth.clearToken();
        await expect(auth.getAuthHeaders()).resolves.toMatchObject({ 'Csrf-Token': 'current-csrf' });
        oldLogin.resolve({ data: { errorCode: 0, result: { token: 'old-csrf' } }, headers: { 'set-cookie': ['SESSION=old'] } });
        await expect(first).resolves.toMatchObject({ 'Csrf-Token': 'current-csrf', Cookie: 'SESSION=current' });
        auth.clearToken({ 'Csrf-Token': 'old-csrf' });
        await expect(auth.getAuthHeaders()).resolves.toMatchObject({ 'Csrf-Token': 'current-csrf' });
        expect(mockHttp.post).toHaveBeenCalledTimes(2);
    });

    it('should login and return Fusion web auth headers', async () => {
        (mockHttp.post as ReturnType<typeof vi.fn>).mockResolvedValue({
            data: { errorCode: 0, msg: 'Success', result: { token: 'csrf-token' } },
            headers: { 'set-cookie': ['TPOMADA_SESSIONID=session-123; Path=/; HttpOnly'] },
        });

        const authManager = new WebAuthManager(mockHttp, 'admin', 'password', 'omadac-id');

        await expect(authManager.getAuthHeaders()).resolves.toEqual({
            'Csrf-Token': 'csrf-token',
            'Omada-Request-Source': 'web-local',
            Cookie: 'TPOMADA_SESSIONID=session-123',
        });

        expect(mockHttp.post).toHaveBeenCalledWith('/omadac-id/api/v2/login', { username: 'admin', password: 'password' }, { withCredentials: true });
    });

    it('should reuse the cached web session', async () => {
        (mockHttp.post as ReturnType<typeof vi.fn>).mockResolvedValue({
            data: { errorCode: 0, msg: 'Success', result: { token: 'csrf-token' } },
            headers: {},
        });

        const authManager = new WebAuthManager(mockHttp, 'admin', 'password', 'omadac-id');

        await authManager.getAuthHeaders();
        await authManager.getAuthHeaders();

        expect(mockHttp.post).toHaveBeenCalledTimes(1);
    });

    it('should clear the cached web session', async () => {
        (mockHttp.post as ReturnType<typeof vi.fn>).mockResolvedValue({
            data: { errorCode: 0, msg: 'Success', result: { token: 'csrf-token' } },
            headers: {},
        });

        const authManager = new WebAuthManager(mockHttp, 'admin', 'password', 'omadac-id');

        await authManager.getAuthHeaders();
        authManager.clearToken();
        await authManager.getAuthHeaders();

        expect(mockHttp.post).toHaveBeenCalledTimes(2);
    });

    it('should throw when Fusion web login fails', async () => {
        (mockHttp.post as ReturnType<typeof vi.fn>).mockResolvedValue({
            data: { errorCode: -1, msg: 'Login failed' },
            headers: {},
        });

        const authManager = new WebAuthManager(mockHttp, 'admin', 'bad-password', 'omadac-id');

        await expect(authManager.getAuthHeaders()).rejects.toThrow('Login failed');
    });

    it('should log in once when several requests need a session at the same time', async () => {
        (mockHttp.post as ReturnType<typeof vi.fn>).mockResolvedValue({
            data: { errorCode: 0, msg: 'Success', result: { token: 'csrf-token' } },
            headers: {},
        });

        const authManager = new WebAuthManager(mockHttp, 'admin', 'password', 'omadac-id');
        await Promise.all([authManager.getAuthHeaders(), authManager.getAuthHeaders(), authManager.getAuthHeaders()]);

        expect(mockHttp.post).toHaveBeenCalledTimes(1);
    });

    it('permits another login after the credential rejection cooldown', async () => {
        vi.useFakeTimers();
        try {
            (mockHttp.post as ReturnType<typeof vi.fn>)
                .mockResolvedValueOnce({ data: { errorCode: -30109, msg: 'Login failed' }, headers: {} })
                .mockResolvedValueOnce({ data: { errorCode: 0, result: { token: 'csrf-token' } }, headers: {} });

            const authManager = new WebAuthManager(mockHttp, 'admin', 'password', 'omadac-id');
            await expect(authManager.getAuthHeaders()).rejects.toThrow('Login failed');
            await expect(authManager.getAuthHeaders()).rejects.toThrow('cooling down');
            expect(mockHttp.post).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(3000);
            await expect(authManager.getAuthHeaders()).resolves.toMatchObject({ 'Csrf-Token': 'csrf-token' });
        } finally {
            vi.useRealTimers();
        }
    });
});
