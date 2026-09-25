import type { AxiosInstance } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InternalAuthManager } from '../../src/omadaClient/internalAuth.js';
import * as loggerModule from '../../src/utils/logger.js';

describe('InternalAuthManager', () => {
    let authManager: InternalAuthManager;
    let mockHttp: AxiosInstance;
    const username = 'admin';
    const password = 'secret';
    const omadacId = 'test-omadac-id';

    beforeEach(() => {
        mockHttp = {
            defaults: { baseURL: 'https://test.example.com' },
            post: vi.fn(),
        } as unknown as AxiosInstance;

        authManager = new InternalAuthManager(mockHttp, username, password, omadacId);

        vi.spyOn(loggerModule.logger, 'info').mockImplementation(() => {
            // Mock implementation
        });
        vi.spyOn(loggerModule.logger, 'warn').mockImplementation(() => {
            // Mock implementation
        });
        vi.spyOn(loggerModule.logger, 'error').mockImplementation(() => {
            // Mock implementation
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('isConfigured', () => {
        it('should return true when username and password are set', () => {
            expect(authManager.isConfigured()).toBe(true);
        });

        it('should return false when username or password is missing', () => {
            const unconfigured = new InternalAuthManager(mockHttp, '', '', omadacId);
            expect(unconfigured.isConfigured()).toBe(false);
        });
    });

    describe('getCsrfToken', () => {
        it('should log in and return the CSRF token on first call', async () => {
            (mockHttp.post as ReturnType<typeof vi.fn>).mockResolvedValue({
                data: { errorCode: 0, result: { token: 'csrf-token-1' } },
                headers: { 'set-cookie': ['JSESSIONID=abc123; Path=/; HttpOnly'] },
            });

            const token = await authManager.getCsrfToken();

            expect(token).toBe('csrf-token-1');
            expect(mockHttp.post).toHaveBeenCalledWith(`/${omadacId}/api/v2/login`, { username, password }, { withCredentials: true });
        });

        it('should reuse the cached token on subsequent calls', async () => {
            (mockHttp.post as ReturnType<typeof vi.fn>).mockResolvedValue({
                data: { errorCode: 0, result: { token: 'csrf-token-1' } },
                headers: { 'set-cookie': ['JSESSIONID=abc123'] },
            });

            await authManager.getCsrfToken();
            await authManager.getCsrfToken();

            expect(mockHttp.post).toHaveBeenCalledTimes(1);
        });

        it('should join multiple Set-Cookie header values', async () => {
            (mockHttp.post as ReturnType<typeof vi.fn>).mockResolvedValue({
                data: { errorCode: 0, result: { token: 'csrf-token-1' } },
                headers: { 'set-cookie': ['JSESSIONID=abc123; Path=/', 'other=value; Path=/'] },
            });

            await authManager.getCsrfToken();
            const cookie = await authManager.getSessionCookie();

            expect(cookie).toBe('JSESSIONID=abc123; other=value');
        });

        it('should accept a single string Set-Cookie header', async () => {
            (mockHttp.post as ReturnType<typeof vi.fn>).mockResolvedValue({
                data: { errorCode: 0, result: { token: 'csrf-token-1' } },
                headers: { 'set-cookie': 'JSESSIONID=abc123; Path=/' },
            });

            const cookie = await authManager.getSessionCookie();

            expect(cookie).toBe('JSESSIONID=abc123');
        });

        it('should warn and return an empty cookie when no Set-Cookie header is present', async () => {
            (mockHttp.post as ReturnType<typeof vi.fn>).mockResolvedValue({
                data: { errorCode: 0, result: { token: 'csrf-token-1' } },
                headers: {},
            });

            const cookie = await authManager.getSessionCookie();

            expect(cookie).toBe('');
            expect(loggerModule.logger.warn).toHaveBeenCalledWith('Internal API login succeeded but no session cookie received; requests may fail');
        });

        it('should throw and log when the controller returns a login error', async () => {
            (mockHttp.post as ReturnType<typeof vi.fn>).mockResolvedValue({
                data: { errorCode: -1, msg: 'Invalid credentials' },
                headers: {},
            });

            await expect(authManager.getCsrfToken()).rejects.toThrow('Invalid credentials');
            expect(loggerModule.logger.error).toHaveBeenCalledWith(
                'Internal API login error',
                expect.objectContaining({ errorCode: -1, message: 'Invalid credentials' })
            );
        });

        it('should throw when login succeeds but no token is returned', async () => {
            (mockHttp.post as ReturnType<typeof vi.fn>).mockResolvedValue({
                data: { errorCode: 0, result: {} },
                headers: {},
            });

            await expect(authManager.getCsrfToken()).rejects.toThrow('Internal API login succeeded but no CSRF token returned');
        });

        it('should log and rethrow when the HTTP request fails', async () => {
            (mockHttp.post as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));

            await expect(authManager.getCsrfToken()).rejects.toThrow('Network error');
            expect(loggerModule.logger.error).toHaveBeenCalledWith('Internal API login failed', expect.objectContaining({ error: 'Network error' }));
        });
    });

    describe('clearSession', () => {
        it('should force re-login on the next call', async () => {
            (mockHttp.post as ReturnType<typeof vi.fn>).mockResolvedValue({
                data: { errorCode: 0, result: { token: 'csrf-token-1' } },
                headers: { 'set-cookie': ['JSESSIONID=abc123'] },
            });

            await authManager.getCsrfToken();
            authManager.clearSession();
            await authManager.getCsrfToken();

            expect(mockHttp.post).toHaveBeenCalledTimes(2);
        });
    });
});
