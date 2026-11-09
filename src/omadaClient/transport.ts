import axios, { AxiosError, type AxiosInstance, type AxiosRequestConfig, type AxiosResponse, CanceledError } from 'axios';

const controllers = new WeakMap<AxiosInstance, { nextStart: number; queue: Promise<void> }>();
const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);
const TRANSIENT_NETWORK_ERRORS = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN']);
export function requestDeadline(http: AxiosInstance, config: AxiosRequestConfig): number | null {
    const timeout = config.timeout ?? http.defaults.timeout;
    return typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0 ? Date.now() + timeout : null;
}

export function remainingTimeout(config: AxiosRequestConfig, deadline: number | null): number | undefined {
    if (config.signal?.aborted) throw new CanceledError('Controller request canceled');
    if (deadline === null) return undefined;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new AxiosError('Controller request timeout budget exhausted', 'ECONNABORTED');
    return remaining;
}

/** A caller can abandon its queue position without canceling another caller's work. */
export function waitFor<T>(operation: Promise<T>, config: AxiosRequestConfig, deadline: number | null): Promise<T> {
    const remaining = remainingTimeout(config, deadline);
    return new Promise<T>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (complete: () => void): void => {
            clearTimeout(timer);
            config.signal?.removeEventListener?.('abort', onAbort);
            complete();
        };
        const onAbort = (): void => finish(() => reject(new CanceledError('Controller request canceled')));
        config.signal?.addEventListener?.('abort', onAbort);
        if (remaining !== undefined) {
            timer = setTimeout(() => finish(() => reject(new AxiosError('Controller request timeout budget exhausted', 'ECONNABORTED'))), remaining);
        }
        operation.then(
            (value) => finish(() => resolve(value)),
            (error: unknown) => finish(() => reject(error))
        );
        if (config.signal?.aborted) onAbort();
    });
}

async function pause(ms: number, config: AxiosRequestConfig, deadline: number | null): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await waitFor(
            new Promise<void>((resolve) => {
                timer = setTimeout(resolve, ms);
            }),
            config,
            deadline
        );
    } finally {
        clearTimeout(timer);
    }
}

/** Public and internal handlers share the controller's Axios instance. Call only after authentication. */
async function dispatch<T>(http: AxiosInstance, config: AxiosRequestConfig, deadline: number | null): Promise<AxiosResponse<T>> {
    let controller = controllers.get(http);
    if (!controller) {
        controller = { nextStart: 0, queue: Promise.resolve() };
        controllers.set(http, controller);
    }
    const state = controller;
    const slot = state.queue.then(async () => {
        remainingTimeout(config, deadline);
        const remaining = state.nextStart - Date.now();
        if (remaining > 0) await pause(remaining, config, deadline);
        const timeout = remainingTimeout(config, deadline);
        state.nextStart = Date.now() + 125;
        const response = http.request<T>({ ...config, ...(timeout === undefined ? {} : { timeout }) });
        // A canceled caller may leave before it receives this already-started request.
        void response.catch(() => undefined);
        return { response };
    });
    state.queue = slot.then(
        () => undefined,
        () => undefined
    );
    const { response } = await waitFor(slot, config, deadline);
    return waitFor(response, config, deadline);
}

/** Retry safe reads only; a lost mutation response never justifies replaying the mutation. */
export async function controllerRequest<T>(
    http: AxiosInstance,
    config: AxiosRequestConfig,
    retry = true,
    deadline: number | null = requestDeadline(http, config)
): Promise<AxiosResponse<T>> {
    const safeRead = ['GET', 'HEAD'].includes((config.method ?? 'GET').toUpperCase());
    for (let attempt = 0; ; attempt++) {
        try {
            return await dispatch<T>(http, config, deadline);
        } catch (error) {
            remainingTimeout(config, deadline);
            if (!retry || !safeRead || attempt >= 2 || !axios.isAxiosError(error)) throw error;
            const status = error.response?.status;
            if (!(status === undefined ? TRANSIENT_NETWORK_ERRORS.has(error.code ?? '') : TRANSIENT_STATUSES.has(status))) throw error;
            let delay = Math.round(500 * 2 ** attempt * (1 + Math.random() * 0.25));
            const header = error.response?.headers?.['retry-after'];
            if (typeof header === 'string' || typeof header === 'number') {
                const value = String(header).trim();
                const requested = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
                // Do not shorten a controller's requested cooldown to fit our bounded retry policy.
                if (requested > 30_000) throw error;
                if (Number.isFinite(requested)) delay = Math.max(delay, requested);
            }
            await pause(delay, config, deadline);
        }
    }
}

export class CredentialRejectionError extends Error {}

/** Mark only explicit credential rejection, not arbitrary controller or network failures. */
export function loginError(message: string): Error {
    return /^login failed$|invalid (?:credentials|username|password|client)|(?:credentials|username|password|client secret).*(?:incorrect|invalid|wrong)|incorrect (?:username|password)/i.test(
        message
    )
        ? new CredentialRejectionError(message)
        : new Error(message);
}

export class CredentialCooldown {
    private rejectedUntil = 0;

    public check(): void {
        if (Date.now() < this.rejectedUntil) throw new Error('Omada credentials were rejected; authentication is cooling down. Retry shortly.');
    }

    public record(error: unknown): void {
        if (error instanceof CredentialRejectionError || (axios.isAxiosError(error) && [401, 403].includes(error.response?.status ?? 0))) {
            this.rejectedUntil = Date.now() + 3000;
        }
    }
}
