import type { AxiosInstance } from 'axios';

import { logger } from '../utils/logger.js';

/**
 * Authentication state management for the Omada internal (web UI) API.
 * Uses cookie-based sessions with CSRF tokens instead of OAuth bearer tokens.
 */
export class InternalAuthManager {
    private csrfToken?: string;

    private sessionCookie?: string;

    private generation = 0;

    private pendingLogin?: { generation: number; promise: Promise<void> };

    constructor(
        private readonly http: AxiosInstance,
        private readonly username: string,
        private readonly password: string,
        private readonly omadacId: string
    ) {}

    /**
     * Get the current CSRF token, logging in if necessary.
     */
    public async getCsrfToken(): Promise<string> {
        return (await this.getAuthHeaders())['Csrf-Token'];
    }

    /**
     * Get the current session cookie.
     */
    public async getSessionCookie(): Promise<string> {
        return (await this.getAuthHeaders()).Cookie;
    }

    /** Return matching token/cookie values from one session snapshot. */
    public async getAuthHeaders(): Promise<Record<string, string>> {
        await this.ensureSession();
        return { 'Csrf-Token': this.csrfToken ?? '', Cookie: this.sessionCookie ?? '' };
    }

    /**
     * Clear the current session, forcing re-login on next request.
     */
    public clearSession(rejectedCsrfToken?: string): void {
        if (rejectedCsrfToken !== undefined && rejectedCsrfToken !== this.csrfToken) {
            return;
        }
        this.generation += 1;
        this.csrfToken = undefined;
        this.sessionCookie = undefined;
    }

    private async ensureSession(): Promise<void> {
        for (;;) {
            if (this.csrfToken && this.sessionCookie) {
                return;
            }
            const generation = this.generation;
            let operation = this.pendingLogin;
            if (!operation || operation.generation !== generation) {
                operation = {
                    generation,
                    promise: this.login(generation).finally(() => {
                        if (this.pendingLogin === operation) {
                            this.pendingLogin = undefined;
                        }
                    }),
                };
                this.pendingLogin = operation;
            }
            try {
                await operation.promise;
            } catch (error) {
                if (generation === this.generation) {
                    throw error;
                }
            }
            if (generation === this.generation) {
                return;
            }
        }
    }

    /**
     * Check if web credentials are configured.
     */
    public isConfigured(): boolean {
        return Boolean(this.username && this.password);
    }

    /**
     * Log in to the internal web UI API and extract session cookie + CSRF token.
     */
    private async login(generation: number): Promise<void> {
        const loginPath = `/${encodeURIComponent(this.omadacId)}/api/v2/login`;

        try {
            const response = await this.http.post(loginPath, { username: this.username, password: this.password }, { withCredentials: true });

            const data = response.data as { errorCode?: number; msg?: string; result?: { token?: string } };

            if (data.errorCode !== 0) {
                logger.error('Internal API login error', {
                    errorCode: data.errorCode,
                    message: data.msg,
                });
                throw new Error(data.msg ?? 'Internal API login failed');
            }

            // Extract CSRF token from response body
            const token = data.result?.token;
            if (!token) {
                throw new Error('Internal API login succeeded but no CSRF token returned');
            }
            if (generation !== this.generation) {
                return;
            }
            this.csrfToken = token;
            this.sessionCookie = undefined;

            // Extract session cookie from Set-Cookie header
            const setCookieHeader = response.headers['set-cookie'];
            if (setCookieHeader) {
                // Collect all cookie name=value pairs
                const cookies = (Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader])
                    .map((c: string) => c.split(';')[0].trim())
                    .filter(Boolean);
                this.sessionCookie = cookies.join('; ');
            }

            if (!this.sessionCookie) {
                logger.warn('Internal API login succeeded but no session cookie received; requests may fail');
            }

            logger.info('Internal API login successful');
        } catch (error) {
            logger.error('Internal API login failed', {
                baseUrl: this.http.defaults.baseURL,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }
}
