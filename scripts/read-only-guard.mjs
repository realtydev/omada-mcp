/** Allow controller reads and the two authentication POSTs, while rejecting mutations. */
export function isReadOnlyControllerRequest(request, { baseUrl, omadacId }) {
    let target;
    try {
        target = new URL(request.url ?? '', request.baseURL ?? baseUrl);
    } catch {
        return false;
    }
    if (target.origin !== new URL(baseUrl).origin) return false;
    const method = (request.method ?? 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD') return true;
    if (method !== 'POST') return false;
    return target.pathname === '/openapi/authorize/token' || target.pathname === `/${encodeURIComponent(omadacId)}/api/v2/login`;
}

/** Install before creating OmadaClient; restore both the factory and installed interceptors. */
export function installReadOnlyGuard(axios, controller) {
    const originalCreate = axios.create;
    const interceptors = [];
    const counts = { reads: 0, authentication: 0, blocked: 0 };
    const guardedCreate = function (...args) {
        const instance = originalCreate.apply(axios, args);
        const id = instance.interceptors.request.use((request) => {
            if (!isReadOnlyControllerRequest(request, controller)) {
                counts.blocked += 1;
                throw new Error('Read-only validation blocked a request outside the allowed controller reads and authentication.');
            }
            if (['GET', 'HEAD'].includes((request.method ?? 'GET').toUpperCase())) counts.reads += 1;
            else counts.authentication += 1;
            // Follow-up redirects bypass Axios request interceptors, so do not follow them here.
            request.maxRedirects = 0;
            return request;
        });
        interceptors.push({ instance, id });
        return instance;
    };
    axios.create = guardedCreate;
    return {
        counts,
        restore() {
            if (axios.create === guardedCreate) axios.create = originalCreate;
            for (const { instance, id } of interceptors.splice(0)) instance.interceptors.request.eject(id);
        },
    };
}
