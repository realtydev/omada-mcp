import type { AxiosInstance } from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { DeviceOperations } from '../../src/omadaClient/device.js';
import { RequestHandler } from '../../src/omadaClient/request.js';
import type { SiteOperations } from '../../src/omadaClient/site.js';

function setup() {
    const http = { defaults: {}, request: vi.fn() };
    const auth = { getAuthHeaders: async () => ({}), clearToken: vi.fn() };
    return { http, handler: new RequestHandler(http as unknown as AxiosInstance, auth) };
}
const page = (data: unknown[], totalRows?: number) => ({
    status: 200,
    data: { errorCode: 0, result: { data, ...(totalRows === undefined ? {} : { totalRows }) } },
});

describe('bounded device inventory pagination', () => {
    it('rejects a declared oversized collection after one read instead of collecting every page', async () => {
        const { http, handler } = setup();
        http.request.mockResolvedValue(page([{ id: 1 }], 2001));
        await expect(handler.fetchPaginated('/devices', {}, 200, { maxRecords: 2000 })).rejects.toThrow('2000-record limit');
        expect(http.request).toHaveBeenCalledTimes(1);
    });

    it('bounds collections without totals and never returns a truncated list as success', async () => {
        const { http, handler } = setup();
        http.request.mockResolvedValueOnce(page([{ id: 1 }, { id: 2 }])).mockResolvedValueOnce(page([{ id: 3 }]));
        await expect(handler.fetchPaginated('/devices', {}, 200, { maxRecords: 2 })).rejects.toThrow('2-record limit');
        expect(http.request).toHaveBeenCalledTimes(2);
        for (const [config] of http.request.mock.calls) expect(config.params.pageSize).toBe(2);
    });

    it('returns an exact-limit collection when the controller establishes completeness', async () => {
        const { http, handler } = setup();
        http.request.mockResolvedValue(page([{ id: 1 }, { id: 2 }], 2));
        await expect(handler.fetchPaginated('/devices', {}, 200, { maxRecords: 2 })).resolves.toEqual([{ id: 1 }, { id: 2 }]);
        expect(http.request).toHaveBeenCalledTimes(1);
    });

    it('does not start another page after the inventory signal is aborted', async () => {
        const { http, handler } = setup();
        const abort = new AbortController();
        http.request.mockResolvedValue(page([{ id: 1 }], 2));
        const ensure = handler.ensureSuccess.bind(handler);
        vi.spyOn(handler, 'ensureSuccess').mockImplementation((response) => {
            const result = ensure(response);
            abort.abort();
            return result;
        });
        await expect(handler.fetchPaginated('/devices', {}, 1, { signal: abort.signal, maxRecords: 2 })).rejects.toThrow();
        expect(http.request).toHaveBeenCalledTimes(1);
        expect(http.request.mock.calls[0][0].signal).toBe(abort.signal);
    });

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid maxRecords %s before HTTP', async (maxRecords) => {
        const { http, handler } = setup();
        await expect(handler.fetchPaginated('/devices', {}, 200, { maxRecords })).rejects.toThrow('maxRecords');
        expect(http.request).not.toHaveBeenCalled();
    });

    it('passes bounded/cancellable options through the device operation without changing legacy calls', async () => {
        const fetchPaginated = vi.fn().mockResolvedValue([]);
        const device = new DeviceOperations(
            { fetchPaginated } as unknown as RequestHandler,
            { resolveSiteId: () => 'site' } as unknown as SiteOperations,
            (path) => `/openapi/v1/controller${path}`
        );
        await device.listDevices('site');
        expect(fetchPaginated).toHaveBeenLastCalledWith('/openapi/v1/controller/sites/site/devices');
        const options = { signal: new AbortController().signal, maxRecords: 2000 };
        await device.listDevices('site', options);
        expect(fetchPaginated).toHaveBeenLastCalledWith('/openapi/v1/controller/sites/site/devices', {}, undefined, options);
    });
});
