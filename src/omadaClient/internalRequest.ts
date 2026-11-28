import axios, { type AxiosError, type AxiosInstance, type AxiosRequestConfig, type AxiosResponse } from 'axios';

import type { OmadaApiResponse } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { createRequestRedactor, redactedRequestError } from '../utils/redact.js';

import type { InternalAuthManager } from './internalAuth.js';
import { controllerRequest, remainingTimeout, requestDeadline, waitFor } from './transport.js';

function apiEnvelope(value: unknown): value is { errorCode: number; msg?: string } {
    return value !== null && typeof value === 'object' && !Array.isArray(value) && Number.isSafeInteger((value as { errorCode?: unknown }).errorCode);
}

function attribute(attributes: string, name: string): string | undefined {
    for (const item of attributes.matchAll(/(?:^|\s)([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g)) {
        if (item[1].toLowerCase() === name) return item[2] ?? item[3] ?? item[4];
    }
    return undefined;
}

function activeHtml(data: string): string | undefined {
    const parts: string[] = [];
    const tags = /<!--[\s\S]*?(?:-->|$)|<([a-z][a-z\d:-]*)\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi;
    let cursor = 0;
    let count = 0;
    for (let tag = tags.exec(data); tag; tag = tags.exec(data)) {
        if (++count > 1024) return undefined;
        if (tag[0].startsWith('<!--')) {
            parts.push(data.slice(cursor, tag.index), ' ');
            cursor = tags.lastIndex;
            continue;
        }
        const name = tag[1].toLowerCase();
        // Templates can nest; unknown dormant markup is not proof of an active login form.
        if (name === 'template') return undefined;
        if (!['script', 'style', 'textarea', 'title', 'xmp'].includes(name)) continue;
        const closing = new RegExp(`</${name}\\s*>`, 'gi');
        closing.lastIndex = tags.lastIndex;
        const end = closing.exec(data);
        parts.push(data.slice(cursor, tag.index), ' ');
        cursor = end ? closing.lastIndex : data.length;
        tags.lastIndex = cursor;
    }
    return parts.length ? parts.join('') + data.slice(cursor) : data;
}

/**
 * HTTP request handler for Omada internal (web UI) API calls.
 * Uses cookie + Csrf-Token header instead of bearer token authentication.
 * The internal API base path is /{omadacId}/api/v2 (not /openapi/v1/{omadacId}).
 */
export class InternalRequestHandler {
    constructor(
        private readonly http: AxiosInstance,
        private readonly auth: InternalAuthManager,
        private readonly omadacId: string,
        /** Login principal (the MSP ID on MSP controllers); login redirects may name it instead of the controller ID. */
        private readonly authId: string = omadacId
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
            maxRedirects: 0,
        };

        const redact = createRequestRedactor(requestConfig.data, requestConfig.params, requestConfig.headers);
        const method = (requestConfig.method ?? 'GET').toUpperCase();
        const url = requestConfig.url ?? 'unknown-url';
        const safeRead = method === 'GET' || method === 'HEAD';
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
                data: apiEnvelope(response.data) ? redact(response.data) : { responseKind: this.responseKind(response) },
            });

            const envelope = apiEnvelope(response.data) ? response.data : undefined;
            const errorCode = envelope?.errorCode;
            const expired = this.sessionRejected(response);
            if (expired && retry) {
                this.auth.clearSession(csrfToken);
                if (safeRead) {
                    logger.warn('Internal API session expired, re-logging in', { method, url: redact(url), errorCode });
                    return this.request<T>(config, false, deadline);
                }
                throw this.unverifiedMutation(method, url, response.status, redact);
            }
            if (!envelope && method !== 'HEAD') throw this.unexpectedResponse(method, url, response, redact);

            return typeof errorCode === 'number' && errorCode !== 0 ? (redact(response.data) as T) : response.data;
        } catch (error) {
            const status = axios.isAxiosError(error) ? error.response?.status : undefined;
            logger.error('Internal API request failed', {
                method,
                url: redact(url),
                status,
                message: axios.isAxiosError(error)
                    ? this.toDetailedError(method, url, error, redact).message
                    : redact(error instanceof Error ? error.message : String(error)),
            });

            if (!axios.isAxiosError(error)) {
                throw redactedRequestError(error, redact);
            }

            if (retry && error.response && this.sessionRejected(error.response)) {
                this.auth.clearSession(csrfToken);
                if (safeRead) return this.request<T>(config, false, deadline);
                throw this.unverifiedMutation(method, url, status, redact);
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
        const nonApiBody = error.response && !apiEnvelope(error.response.data);
        const redirect = status !== undefined && status >= 300 && status < 400;
        const detail = redact(
            redirect
                ? 'Redirect refused; use the configured controller URL.'
                : nonApiBody
                  ? `Unexpected ${this.responseKind(error.response!)} response without a valid errorCode.`
                  : (body?.msg ?? error.message)
        );
        const statusPart = status ? ` (HTTP ${status})` : '';
        const errorCodePart = Number.isSafeInteger(body?.errorCode) ? ` (errorCode: ${body?.errorCode})` : '';
        const outcome =
            !['GET', 'HEAD'].includes(method) && (redirect || nonApiBody)
                ? ' Write outcome is unverified; request was not replayed. Read current settings before retrying.'
                : '';
        return redactedRequestError(
            error,
            redact,
            `Internal API request failed: ${method} ${url}${statusPart}${errorCodePart} - ${detail}${outcome}`,
            status
        );
    }

    private sessionRejected(response: AxiosResponse): boolean {
        if (apiEnvelope(response.data) && this.isSessionExpired(response.data.errorCode, response.data.msg)) return true;
        if (response.status === 401) return true;
        if (response.status >= 300 && response.status < 400) return this.loginTarget(response.headers?.location);
        return response.status >= 200 && response.status < 300 && this.loginHtml(response);
    }

    private loginTarget(value: unknown, api = false): boolean {
        if (
            typeof value !== 'string' ||
            value.length > 2048 ||
            [...value].some((c) => c === '\\' || c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127)
        )
            return false;
        try {
            const base = new URL(this.http.defaults.baseURL ?? 'https://configured-controller.invalid');
            if (!this.http.defaults.baseURL && /^[a-z][a-z\d+.-]*:|^\/\//i.test(value)) return false;
            const target = new URL(value, base);
            if (
                !['http:', 'https:'].includes(target.protocol) ||
                target.hostname !== base.hostname ||
                target.port !== base.port ||
                target.username ||
                target.password
            )
                return false;
            const path = target.pathname.replace(/\/$/, '');
            return [this.omadacId, this.authId].some(
                (id) =>
                    path === '/login' || path === `/${encodeURIComponent(id)}/login` || (api && path === `/${encodeURIComponent(id)}/api/v2/login`)
            );
        } catch {
            return false;
        }
    }

    private loginHtml(response: AxiosResponse): boolean {
        const data: unknown = response.data;
        const type: unknown = response.headers?.['content-type'];
        if (typeof data !== 'string' || Buffer.byteLength(data) > 65_536 || typeof type !== 'string' || !/^text\/html(?:;|$)/i.test(type))
            return false;
        const html = activeHtml(data);
        if (html === undefined) return false;
        const lower = html.toLowerCase();
        let forms = 0;
        for (const form of html.matchAll(/<form\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi)) {
            if (++forms > 16) return false;
            if (attribute(form[1], 'method')?.toLowerCase() !== 'post' || !this.loginTarget(attribute(form[1], 'action'), true)) continue;
            const end = lower.indexOf('</form', form.index + form[0].length);
            if (end < 0) continue;
            const body = html.slice(form.index + form[0].length, end);
            const inputs = [...body.matchAll(/<input\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi)];
            if (
                inputs.some((input) => attribute(input[1], 'type')?.toLowerCase() === 'password') &&
                inputs.some((input) => ['username', 'user', 'account'].includes(attribute(input[1], 'name')?.toLowerCase() ?? ''))
            )
                return true;
        }
        return false;
    }

    private responseKind(response: AxiosResponse): string {
        if (typeof response.data === 'string' && /^\s*</.test(response.data)) return 'HTML';
        return response.data !== null && typeof response.data === 'object' ? 'malformed JSON' : 'non-API';
    }

    private unexpectedResponse(method: string, url: string, response: AxiosResponse, redact: (value: unknown) => unknown): Error {
        return redactedRequestError(
            new Error(),
            redact,
            `Internal API request failed: ${method} ${url} (HTTP ${response.status}) - Unexpected ${this.responseKind(response)} response without a valid errorCode.${['GET', 'HEAD'].includes(method) ? '' : ' Write outcome is unverified; request was not replayed. Read current settings before retrying.'}`,
            response.status
        );
    }

    private unverifiedMutation(method: string, url: string, status: number | undefined, redact: (value: unknown) => unknown): Error {
        return redactedRequestError(
            new Error(),
            redact,
            `Internal API request failed: ${method} ${url}${status === undefined ? '' : ` (HTTP ${status})`} - Session rejected; write outcome is unverified and the request was not replayed. Read current settings before retrying.`,
            status
        );
    }

    /**
     * Check if the error indicates an expired or invalid session.
     */
    private isSessionExpired(errorCode?: number, message?: string): boolean {
        // Common internal API auth error codes
        if (errorCode === -44106 || errorCode === -44112 || errorCode === -44113) {
            return true;
        }
        if (typeof message === 'string') {
            const lower = message.toLowerCase();
            return lower.includes('token expired') || lower.includes('session expired') || lower.includes('not logged in');
        }
        return false;
    }
}
