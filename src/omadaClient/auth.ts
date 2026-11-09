import type { AxiosInstance } from 'axios';

import type { OmadaApiResponse, TokenResult } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { CredentialCooldown, loginError } from './transport.js';

const TOKEN_EXPIRY_BUFFER_SECONDS = 30;

export type AuthMode = 'oauth' | 'web';

export interface RequestAuthManager {
    getAuthHeaders(): Promise<Record<string, string>>;
    readonly mode?: AuthMode;
    clearToken(rejectedHeaders?: Record<string, string>): void;
}

/**
 * Authentication state management for the Omada client.
 */
export class AuthManager implements RequestAuthManager {
    public readonly mode = 'oauth' as const;

    private generation = 0;
    private readonly credentialCooldown = new CredentialCooldown();

    private pendingAuthentication?: { generation: number; promise: Promise<void> };
    private accessToken?: string;

    private refreshToken?: string;

    private tokenExpiresAt?: number;

    constructor(
        private readonly http: AxiosInstance,
        private readonly clientId: string,
        private readonly clientSecret: string,
        private readonly omadacId: string
    ) {}

    /**
     * Get the current access token, refreshing if necessary.
     */
    public async getAccessToken(): Promise<string> {
        return await this.ensureAccessToken();
    }

    public async getAuthHeaders(): Promise<Record<string, string>> {
        const accessToken = await this.getAccessToken();
        return { Authorization: `AccessToken=${accessToken}` };
    }

    /**
     * Clear the current authentication token.
     */
    public clearToken(rejectedHeaders?: Record<string, string>): void {
        // A late rejection of old credentials must not invalidate a newer login.
        if (rejectedHeaders && rejectedHeaders.Authorization !== `AccessToken=${this.accessToken ?? ''}`) {
            return;
        }
        this.generation += 1;
        this.accessToken = undefined;
        this.refreshToken = undefined;
        this.tokenExpiresAt = undefined;
    }

    /** Share authentication within a credential generation and discard superseded responses. */
    private async ensureAccessToken(): Promise<string> {
        for (;;) {
            if (this.accessToken && this.tokenExpiresAt && Date.now() < this.tokenExpiresAt) {
                return this.accessToken;
            }
            const generation = this.generation;
            this.credentialCooldown.check();
            let operation = this.pendingAuthentication;
            if (!operation || operation.generation !== generation) {
                operation = {
                    generation,
                    promise: this.acquireToken(generation).finally(() => {
                        if (this.pendingAuthentication === operation) {
                            this.pendingAuthentication = undefined;
                        }
                    }),
                };
                this.pendingAuthentication = operation;
            }
            try {
                await operation.promise;
            } catch (error) {
                if (generation === this.generation) {
                    throw error;
                }
            }
            if (generation === this.generation && this.accessToken) {
                return this.accessToken;
            }
        }
    }

    private async acquireToken(generation: number): Promise<void> {
        let token: TokenResult;
        const refreshToken = this.refreshToken;
        if (refreshToken) {
            try {
                token = await this.authenticate('refresh_token', refreshToken);
            } catch {
                if (generation !== this.generation) {
                    return;
                }
                this.accessToken = undefined;
                this.refreshToken = undefined;
                this.tokenExpiresAt = undefined;
                token = await this.acquireCredentials(generation);
            }
        } else {
            token = await this.acquireCredentials(generation);
        }
        if (generation === this.generation) {
            this.setToken(token);
        }
    }

    private async acquireCredentials(generation: number): Promise<TokenResult> {
        try {
            return await this.authenticate('client_credentials');
        } catch (error) {
            if (generation === this.generation) this.credentialCooldown.record(error);
            throw error;
        }
    }

    /**
     * Authenticate with the Omada controller using the specified grant type.
     */
    private async authenticate(grantType: 'client_credentials' | 'refresh_token', refreshToken?: string): Promise<TokenResult> {
        const params: Record<string, string> = { grant_type: grantType };
        const body: Record<string, string> = {
            client_id: this.clientId,
            client_secret: this.clientSecret,
        };

        if (grantType === 'client_credentials') {
            body.omadacId = this.omadacId;
        } else {
            if (!refreshToken) {
                throw new Error('No refresh token available to refresh the access token');
            }

            params.refresh_token = refreshToken;
        }

        try {
            const { data } = await this.http.post<OmadaApiResponse<TokenResult>>('/openapi/authorize/token', body, { params });

            if (data.errorCode !== 0) {
                logger.error('Omada authentication error', {
                    errorCode: data.errorCode,
                    message: data.msg,
                });
                throw loginError(data.msg ?? 'Omada authentication failed');
            }

            const token = data.result;
            if (!token?.accessToken) {
                throw new Error('Omada authentication succeeded but no access token returned');
            }
            return token;
        } catch (error) {
            logger.error('Omada authentication failed', {
                grantType,
                baseUrl: this.http.defaults.baseURL,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }

    /**
     * Store the authentication token and calculate expiration time.
     */
    private setToken(token: TokenResult): void {
        this.accessToken = token.accessToken;
        this.refreshToken = token.refreshToken;

        const expiresInSeconds = Number.isFinite(token.expiresIn) ? token.expiresIn : 0;
        const expiresInMs = Math.max(expiresInSeconds - TOKEN_EXPIRY_BUFFER_SECONDS, 0) * 1000;
        this.tokenExpiresAt = Date.now() + expiresInMs;
    }
}

/**
 * Fusion gateway web-session authentication for OpenAPI requests.
 */
export class WebAuthManager implements RequestAuthManager {
    public readonly mode = 'web' as const;

    private generation = 0;
    private readonly credentialCooldown = new CredentialCooldown();
    private csrfToken?: string;

    private sessionCookie?: string;

    private pendingLogin?: { generation: number; promise: Promise<void> };

    constructor(
        private readonly http: AxiosInstance,
        private readonly username: string,
        private readonly password: string,
        private readonly omadacId: string
    ) {}

    public async getAuthHeaders(): Promise<Record<string, string>> {
        await this.ensureSession();

        const headers: Record<string, string> = {
            'Csrf-Token': this.csrfToken ?? '',
            'Omada-Request-Source': 'web-local',
        };

        if (this.sessionCookie) {
            headers.Cookie = this.sessionCookie;
        }

        return headers;
    }

    public clearToken(rejectedHeaders?: Record<string, string>): void {
        if (rejectedHeaders && rejectedHeaders['Csrf-Token'] !== this.csrfToken) {
            return;
        }
        this.generation += 1;
        this.csrfToken = undefined;
        this.sessionCookie = undefined;
    }

    private async ensureSession(): Promise<void> {
        while (!this.csrfToken) {
            const generation = this.generation;
            this.credentialCooldown.check();
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
        }
    }

    private async login(generation: number): Promise<void> {
        const loginPath = `/${encodeURIComponent(this.omadacId)}/api/v2/login`;

        try {
            const response = await this.http.post(loginPath, { username: this.username, password: this.password }, { withCredentials: true });
            const data = response.data as { errorCode?: number; msg?: string; result?: { token?: string } };

            if (data.errorCode !== 0) {
                logger.error('Omada web authentication error', {
                    errorCode: data.errorCode,
                    message: data.msg,
                });
                throw loginError(data.msg ?? 'Omada web authentication failed');
            }

            const token = data.result?.token;
            if (!token) {
                throw new Error('Omada web authentication succeeded but no CSRF token returned');
            }

            if (generation !== this.generation) {
                return;
            }
            this.csrfToken = token;
            this.sessionCookie = this.extractSessionCookie(response.headers['set-cookie']);

            logger.info('Omada web authentication successful');
        } catch (error) {
            if (generation === this.generation) this.credentialCooldown.record(error);
            logger.error('Omada web authentication failed', {
                baseUrl: this.http.defaults.baseURL,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }

    private extractSessionCookie(setCookieHeader: unknown): string | undefined {
        if (!setCookieHeader) {
            return undefined;
        }

        const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
        const cookies = headers.map((cookie) => String(cookie).split(';')[0].trim()).filter(Boolean);

        return cookies.length > 0 ? cookies.join('; ') : undefined;
    }
}
