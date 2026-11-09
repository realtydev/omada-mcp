import axios, { type AxiosError, type AxiosInstance, type AxiosRequestConfig } from 'axios';

import type { OmadaApiResponse } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { createRequestRedactor, redactedRequestError } from '../utils/redact.js';

import type { InternalAuthManager } from './internalAuth.js';
import { controllerRequest, remainingTimeout, requestDeadline, waitFor } from './transport.js';

/**
 * HTTP request handler for Omada internal (web UI) API calls.
 * Uses cookie + Csrf-Token header instead of bearer token authentication.
 * The internal API base path is /{omadacId}/api/v2 (not /openapi/v1/{omadacId}).
 */
export class InternalRequestHandler {
    constructor(
        private readonly http: AxiosInstance,
        private readonly auth: InternalAuthManager,
        private readonly omadacId: string
    ) {}

    /**
     * Make a GET request to the internal API.
     */
    public async get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
        return await this.request<T>({ method: 'GET', url: this.buildInternalPath(path), params });
    }

    /**
     * Make a POST request to the internal API.
     */
    public async post<T>(path: string, data: unknown, params?: Record<string, unknown>): Promise<T> {
        return await this.request<T>({ method: 'POST', url: this.buildInternalPath(path), data, params });
    }

    /**
     * Make a PUT request to the internal API.
     */
    public async put<T>(path: string, data: unknown, params?: Record<string, unknown>): Promise<T> {
        return await this.request<T>({ method: 'PUT', url: this.buildInternalPath(path), data, params });
    }

    /**
     * Make a DELETE request to the internal API.
     */
    public async delete<T>(path: string, params?: Record<string, unknown>): Promise<T> {
        return await this.request<T>({ method: 'DELETE', url: this.buildInternalPath(path), params });
    }

    /**
     * Ensure an internal API response indicates success.
     * @throws {Error} If the response contains an error code
     */
    public ensureSuccess<T>(response: OmadaApiResponse<T>): T {
        if (response.errorCode !== 0) {
            logger.error('Internal API error', {
                errorCode: response.errorCode,
                message: response.msg,
            });
            const detail = response.msg ? `: ${response.msg}` : '';
            const error = new Error(`Internal API request failed (errorCode: ${response.errorCode})${detail}`);
            if (Number.isSafeInteger(response.errorCode)) Object.assign(error, { errorCode: response.errorCode });
            throw error;
        }

        return (response.result ?? ({} as T)) as T;
    }

    /**
     * Build the internal API path: /{omadacId}/api/v2{relativePath}
     */
    private buildInternalPath(relativePath: string): string {
        const normalized = relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
        return `/${encodeURIComponent(this.omadacId)}/api/v2${normalized}`;
    }

    /**
     * Make an authenticated request to the internal API with retry on session expiry.
     */
    private async request<T>(config: AxiosRequestConfig, retry = true, deadline: number | null = requestDeadline(this.http, config)): Promise<T> {
        remainingTimeout(config, deadline);
        const authHeaders = await waitFor(this.auth.getAuthHeaders(), config, deadline);
        const csrfToken = authHeaders['Csrf-Token'];

        const requestConfig: AxiosRequestConfig = {
            ...config,
            headers: {
                ...(config.headers ?? {}),
                ...authHeaders,
            },
            withCredentials: true,
        };

        const redact = createRequestRedactor(requestConfig.data, requestConfig.params, requestConfig.headers);
        const method = (requestConfig.method ?? 'GET').toUpperCase();
        const url = requestConfig.url ?? 'unknown-url';
        logger.info('Internal API request', {
            method,
            url: redact(url),
            params: redact(requestConfig.params),
        });

        logger.debug('Internal API request details', {
            method,
            url: redact(url),
            headers: redact(requestConfig.headers),
            params: redact(requestConfig.params ?? null),
            data: redact(requestConfig.data),
        });

        try {
            const response = await controllerRequest<T>(this.http, requestConfig, retry, deadline);
            logger.info('Internal API response', {
                method,
                url: redact(url),
                status: response.status,
            });

            logger.debug('Internal API response payload', {
                method,
                url: redact(url),
                status: response.status,
                data: redact(response.data),
            });

            // Check for session expiry in response
            const errorCode = (response.data as { errorCode?: number } | undefined)?.errorCode;
            const errorMsg = (response.data as { msg?: string } | undefined)?.msg;

            if (retry && this.isSessionExpired(errorCode, errorMsg)) {
                logger.warn('Internal API session expired, re-logging in', { method, url: redact(url), errorCode });
                this.auth.clearSession(csrfToken);
                return this.request<T>(config, false, deadline);
            }

            return typeof errorCode === 'number' && errorCode !== 0 ? (redact(response.data) as T) : response.data;
        } catch (error) {
            const status = axios.isAxiosError(error) ? error.response?.status : undefined;
            logger.error('Internal API request failed', {
                method,
                url: redact(url),
                status,
                message: redact(error instanceof Error ? error.message : String(error)),
            });

            if (!axios.isAxiosError(error)) {
                throw redactedRequestError(error, redact);
            }

            const body = error.response?.data as { errorCode?: number; msg?: string } | undefined;
            if (retry && (status === 401 || this.isSessionExpired(body?.errorCode, body?.msg))) {
                this.auth.clearSession(csrfToken);
                return this.request<T>(config, false, deadline);
            }

            throw this.toDetailedError(method, url, error, redact);
        }
    }

    /**
     * Build an error that surfaces the HTTP status, endpoint, and response body/message
     * for an internal API request that failed at the HTTP level, instead of losing that
     * detail behind axios's generic "Request failed with status code N" message.
     */
    private toDetailedError(method: string, url: string, error: AxiosError, redact: (value: unknown) => unknown): Error {
        const status = error.response?.status;
        const body = error.response?.data as { msg?: string; errorCode?: number } | undefined;
        const detail = redact(body?.msg ?? error.message);
        const statusPart = status ? ` (HTTP ${status})` : '';
        const errorCodePart = body?.errorCode !== undefined ? ` (errorCode: ${body.errorCode})` : '';
        return redactedRequestError(error, redact, `Internal API request failed: ${method} ${url}${statusPart}${errorCodePart} - ${detail}`, status);
    }

    /**
     * Check if the error indicates an expired or invalid session.
     */
    private isSessionExpired(errorCode?: number, message?: string): boolean {
        // Common internal API auth error codes
        if (errorCode === -44106 || errorCode === -44112 || errorCode === -44113) {
            return true;
        }
        if (message) {
            const lower = message.toLowerCase();
            return lower.includes('token expired') || lower.includes('session expired') || lower.includes('not logged in');
        }
        return false;
    }
}
