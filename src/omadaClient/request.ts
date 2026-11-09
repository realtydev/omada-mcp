import { createHash } from 'node:crypto';
import axios, { type AxiosInstance, type AxiosRequestConfig } from 'axios';

import type { OmadaApiResponse, PaginatedResult } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { createRequestRedactor, redactedRequestError } from '../utils/redact.js';

import type { RequestAuthManager } from './auth.js';
import { controllerRequest, remainingTimeout, requestDeadline, waitFor } from './transport.js';

const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGINATION_PAGES = 1000;

export interface PaginationReadOptions {
    signal?: AbortSignal;
    maxRecords?: number;
}

/**
 * HTTP request handler for Omada API calls with authentication and retry logic.
 */
export class RequestHandler {
    constructor(
        private readonly http: AxiosInstance,
        private readonly auth: RequestAuthManager
    ) {}

    /**
     * Make a GET request to the Omada API.
     */
    public async get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
        return await this.request<T>({ method: 'GET', url: path, params });
    }

    /**
     * Make a POST request to the Omada API.
     */
    public async post<T>(path: string, data: unknown, params?: Record<string, unknown>): Promise<T> {
        return await this.request<T>({ method: 'POST', url: path, data, params });
    }

    /**
     * Make a PUT request to the Omada API.
     */
    public async put<T>(path: string, data: unknown, params?: Record<string, unknown>): Promise<T> {
        return await this.request<T>({ method: 'PUT', url: path, data, params });
    }

    /**
     * Make a DELETE request to the Omada API.
     */
    public async delete<T>(path: string, params?: Record<string, unknown>): Promise<T> {
        return await this.request<T>({ method: 'DELETE', url: path, params });
    }

    /**
     * Make an arbitrary HTTP request to the Omada API.
     */
    public async request<T>(config: AxiosRequestConfig, retry = true, deadline: number | null = requestDeadline(this.http, config)): Promise<T> {
        remainingTimeout(config, deadline);
        const authHeaders = await waitFor(this.auth.getAuthHeaders(), config, deadline);

        const requestConfig: AxiosRequestConfig = {
            ...config,
            headers: {
                ...(config.headers ?? {}),
                ...authHeaders,
            },
        };

        const redact = createRequestRedactor(requestConfig.data, requestConfig.params, requestConfig.headers);
        const method = (requestConfig.method ?? 'GET').toUpperCase();
        const url = requestConfig.url ?? 'unknown-url';
        logger.info('Omada request', {
            method,
            url: redact(url),
            params: redact(requestConfig.params),
            siteId: redact(requestConfig.params?.siteId ?? undefined),
        });

        logger.debug('Omada request details', {
            method,
            url: redact(url),
            headers: redact(requestConfig.headers),
            params: redact(requestConfig.params ?? null),
            data: redact(requestConfig.data),
        });

        try {
            const response = await controllerRequest<T>(this.http, requestConfig, retry, deadline);
            logger.info('Omada response', {
                method,
                url: redact(url),
                status: response.status,
            });

            logger.debug('Omada response payload', {
                method,
                url: redact(url),
                status: response.status,
                headers: redact(response.headers),
                data: redact(response.data),
            });

            // Check if the response data indicates an authentication error
            const errorCode = (response.data as { errorCode?: number } | undefined)?.errorCode;
            const errorMsg = (response.data as { msg?: string } | undefined)?.msg;

            if (retry && (this.isAuthErrorCode(errorCode) || this.isExpiredAuthMessage(errorMsg))) {
                logger.warn('Omada authentication error in response, retrying with fresh token', {
                    method,
                    url: redact(url),
                    errorCode,
                    message: redact(errorMsg),
                });
                this.auth.clearToken(authHeaders);
                return this.request<T>(config, false, deadline);
            }

            return typeof errorCode === 'number' && errorCode !== 0 ? (redact(response.data) as T) : response.data;
        } catch (error) {
            logger.error('Omada request failed', {
                method,
                url: redact(url),
                message: redact(error instanceof Error ? error.message : String(error)),
            });

            if (axios.isAxiosError(error) && error.response) {
                logger.debug('Omada error response payload', {
                    method,
                    url: redact(url),
                    status: error.response.status,
                    headers: redact(error.response.headers),
                    data: redact(error.response.data),
                });
            }

            if (!axios.isAxiosError(error)) {
                throw this.toDetailedError(method, url, error, redact);
            }

            const status = error.response?.status;
            const errorCode = (error.response?.data as { errorCode?: number } | undefined)?.errorCode;

            const errorMsg = (error.response?.data as { msg?: string } | undefined)?.msg;
            if (retry && (status === 401 || this.isAuthErrorCode(errorCode) || this.isExpiredAuthMessage(errorMsg))) {
                this.auth.clearToken(authHeaders);
                return this.request<T>(config, false, deadline);
            }

            throw this.toDetailedError(method, url, error, redact);
        }
    }

    /**
     * Build an error that surfaces the HTTP status, endpoint, and response body/message for a
     * request that failed at the HTTP level, instead of losing that detail behind axios's generic
     * "Request failed with status code N" message.
     */
    private toDetailedError(method: string, url: string, error: unknown, redact: (value: unknown) => unknown): Error {
        if (!axios.isAxiosError(error) || !error.response) {
            return redactedRequestError(error, redact);
        }

        const status = error.response.status;
        const body = error.response.data as { msg?: string; errorCode?: number } | undefined;
        const detail = redact(body?.msg ?? this.safeStringifyBody(redact(error.response.data)) ?? error.message);
        const errorCodePart = body?.errorCode !== undefined ? ` (errorCode: ${body.errorCode})` : '';
        return redactedRequestError(error, redact, `Omada API request failed: ${method} ${url} (HTTP ${status})${errorCodePart} - ${detail}`, status);
    }

    /**
     * Stringify a non-2xx response body for inclusion in an error message.
     */
    private safeStringifyBody(data: unknown): string | undefined {
        if (data === undefined || data === null) {
            return undefined;
        }

        if (typeof data === 'string') {
            return data;
        }

        try {
            return JSON.stringify(data);
        } catch {
            return undefined;
        }
    }

    /**
     * Fetch all pages of a paginated API endpoint.
     */
    public async fetchPaginated<T>(
        path: string,
        params: Record<string, unknown> = {},
        pageSize = DEFAULT_PAGE_SIZE,
        options: PaginationReadOptions = {}
    ): Promise<T[]> {
        if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
            throw new Error('Pagination pageSize must be an integer between 1 and 1000.');
        }
        if (options.maxRecords !== undefined && (!Number.isSafeInteger(options.maxRecords) || options.maxRecords < 1)) {
            throw new Error('Pagination maxRecords must be a positive safe integer.');
        }
        const collectionPageSize = Math.min(pageSize, options.maxRecords ?? pageSize);
        const records: T[] = [];
        const seenPages = new Set<string>();
        let totalRows: number | undefined;

        // Never return a partial collection as successful absence: mutation verification depends
        // on these reads. A changing collection must be retried rather than silently truncated.
        for (let page = 1; page <= MAX_PAGINATION_PAGES; page += 1) {
            options.signal?.throwIfAborted();
            const query = { ...params, page, pageSize: collectionPageSize };
            const response = options.signal
                ? await this.request<OmadaApiResponse<PaginatedResult<T>>>({ method: 'GET', url: path, params: query, signal: options.signal })
                : await this.get<OmadaApiResponse<PaginatedResult<T>>>(path, query);
            options.signal?.throwIfAborted();
            const result = this.ensureSuccess(response);
            if (!result || typeof result !== 'object' || Array.isArray(result) || !Array.isArray(result.data)) {
                throw new Error(`Invalid pagination response for ${path}: expected a result object with a data array.`);
            }
            if (result.totalRows !== undefined) {
                if (!Number.isSafeInteger(result.totalRows) || result.totalRows < 0) {
                    throw new Error(`Invalid pagination response for ${path}: totalRows must be a non-negative safe integer.`);
                }
                if (totalRows !== undefined && totalRows !== result.totalRows) {
                    throw new Error(`Incomplete pagination for ${path}: totalRows changed during collection; retry the read.`);
                }
                totalRows = result.totalRows;
            }
            if (options.maxRecords !== undefined && (totalRows ?? records.length + result.data.length) > options.maxRecords) {
                throw new Error(`Incomplete pagination for ${path}: collection exceeds the ${options.maxRecords}-record limit.`);
            }
            if (result.currentPage !== undefined && (!Number.isSafeInteger(result.currentPage) || result.currentPage !== page)) {
                throw new Error(`Incomplete pagination for ${path}: the controller did not return requested page ${page}.`);
            }
            const pageData = result.data;
            if (totalRows !== undefined && records.length + pageData.length > totalRows) {
                throw new Error(`Invalid pagination response for ${path}: returned more records than totalRows.`);
            }
            if (pageData.length === 0) {
                if (totalRows !== undefined && records.length < totalRows) {
                    throw new Error(`Incomplete pagination for ${path}: an empty page arrived before totalRows was reached.`);
                }
                return records;
            }
            const fingerprint = createHash('sha256').update(JSON.stringify(pageData)).digest('hex');
            if (seenPages.has(fingerprint)) {
                throw new Error(`Incomplete pagination for ${path}: a non-empty page repeated; the controller may be ignoring pagination.`);
            }
            seenPages.add(fingerprint);
            records.push(...pageData);
            if (totalRows !== undefined && records.length === totalRows) {
                return records;
            }
        }
        throw new Error(`Incomplete pagination for ${path}: exceeded the ${MAX_PAGINATION_PAGES}-page safety limit.`);
    }

    /**
     * Ensure an Omada API response indicates success.
     * @throws {Error} If the response contains an error code
     */
    public ensureSuccess<T>(response: OmadaApiResponse<T>): T {
        if (response.errorCode !== 0) {
            logger.error('Omada API error', {
                errorCode: response.errorCode,
                message: response.msg,
            });
            const error = new Error(response.msg ?? 'Omada API request failed');
            if (Number.isSafeInteger(response.errorCode)) Object.assign(error, { errorCode: response.errorCode });
            throw error;
        }

        return (response.result ?? ({} as T)) as T;
    }

    /**
     * Check if an error code indicates an authentication error.
     */
    private isAuthErrorCode(errorCode?: number): boolean {
        if (errorCode === undefined) {
            return false;
        }

        return [-44106, -44111, -44112, -44113, -44114, -44116].includes(errorCode);
    }

    /**
     * Check if an error message indicates token expiration.
     */
    private isExpiredAuthMessage(message?: string): boolean {
        if (!message) {
            return false;
        }

        const lowerMsg = message.toLowerCase();
        return (
            lowerMsg.includes('access token has expired') ||
            lowerMsg.includes('token has expired') ||
            lowerMsg.includes('token expired') ||
            lowerMsg.includes('re-initiate the refreshtoken') ||
            (this.auth.mode === 'web' &&
                (lowerMsg.includes('session expired') || lowerMsg.includes('session has expired') || lowerMsg.includes('not logged in')))
        );
    }
}
