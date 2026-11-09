import { AxiosError } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type DhcpReservation, DhcpReservationOperations } from '../../src/omadaClient/dhcpReservation.js';
import type { RequestHandler } from '../../src/omadaClient/request.js';
import type { SiteOperations } from '../../src/omadaClient/site.js';

const MAC = 'AA-BB-CC-DD-EE-FF';
const reservation = (changes: Partial<DhcpReservation> = {}): DhcpReservation => ({
    mac: MAC,
    netId: 'network-1',
    ip: '192.0.2.50',
    status: true,
    description: 'Test client',
    options: [{ code: 15, type: 0, value: 'example.test' }],
    ...changes,
});

describe('DHCP reservation operations', () => {
    let request: RequestHandler;
    let ops: DhcpReservationOperations;

    beforeEach(() => {
        vi.useFakeTimers();
        request = {
            fetchPaginated: vi.fn(),
            request: vi.fn().mockResolvedValue({ errorCode: 0 }),
            ensureSuccess: vi.fn((response) => {
                if (response.errorCode !== 0) throw new Error(response.msg);
                return response.result;
            }),
        } as unknown as RequestHandler;
        const site = { resolveSiteId: (siteId?: string) => siteId ?? 'default-site' } as SiteOperations;
        ops = new DhcpReservationOperations(request, site, (path) => `/openapi/v1/controller${path}`);
    });

    afterEach(() => vi.useRealTimers());

    it('lists all pages with optional controller search and encoded site IDs', async () => {
        vi.mocked(request.fetchPaginated).mockResolvedValue([reservation()]);
        await expect(ops.listDhcpReservations('site/one', '192.0.2')).resolves.toEqual([reservation()]);
        expect(request.fetchPaginated).toHaveBeenCalledWith('/openapi/v1/controller/sites/site%2Fone/setting/service/dhcp', { searchKey: '192.0.2' });
    });

    it('resolves the default site', async () => {
        vi.mocked(request.fetchPaginated).mockResolvedValue([]);
        await ops.listDhcpReservations();
        expect(request.fetchPaginated).toHaveBeenCalledWith('/openapi/v1/controller/sites/default-site/setting/service/dhcp', {});
    });

    it.each([null, [], {}, { mac: 42 }, { mac: 'not-a-mac' }, { mac: 'FF-FF-FF-FF-FF-FF' }])(
        'rejects malformed reservation evidence before inferring absence (%j)',
        async (row) => {
            vi.mocked(request.fetchPaginated).mockResolvedValue([row]);
            await expect(ops.listDhcpReservations()).rejects.toThrow('evidence is incomplete');
            await expect(ops.createDhcpReservation(reservation())).rejects.toThrow('evidence is incomplete');
            expect(request.request).not.toHaveBeenCalled();
        }
    );

    it('rejects overlapping nonidentical pages with duplicate normalized MACs', async () => {
        vi.mocked(request.fetchPaginated).mockResolvedValue([
            reservation(),
            reservation({ mac: 'AA-BB-CC-DD-EE-00', ip: '192.0.2.51' }),
            reservation({ mac: 'aa:bb:cc:dd:ee:ff', ip: '192.0.2.52' }),
            reservation({ mac: 'AA-BB-CC-DD-EE-22', ip: '192.0.2.53' }),
        ]);
        await expect(ops.listDhcpReservations()).rejects.toThrow('duplicate MAC');
    });

    it('previews create without mutation and normalizes colon-delimited lower-case MACs', async () => {
        vi.mocked(request.fetchPaginated).mockResolvedValue([]);
        const result = await ops.createDhcpReservation(reservation({ mac: 'aa:bb:cc:dd:ee:ff' }), undefined, true);
        expect(result).toMatchObject({ dryRun: true, written: false, requestBody: reservation() });
        expect(request.request).not.toHaveBeenCalled();
    });

    it('refuses duplicate creation even when MAC formatting differs', async () => {
        vi.mocked(request.fetchPaginated).mockResolvedValue([reservation({ mac: 'aa:bb:cc:dd:ee:ff' })]);
        await expect(ops.createDhcpReservation(reservation())).rejects.toThrow('already exists');
        expect(request.request).not.toHaveBeenCalled();
    });

    it('creates using the documented POST payload and verifies the observed fields', async () => {
        vi.mocked(request.fetchPaginated)
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([reservation({ id: 'server-id', netName: 'LAN' })]);
        const result = await ops.createDhcpReservation(reservation(), 'site/one');
        expect(request.request).toHaveBeenCalledExactlyOnceWith(
            {
                method: 'POST',
                url: '/openapi/v1/controller/sites/site%2Fone/setting/service/dhcp',
                data: reservation(),
            },
            false
        );
        expect(result).toMatchObject({ written: true, verification: { status: 'verified', attempts: 1 } });
    });

    it('merges an update with existing writable fields but strips read-only controller fields', async () => {
        const before = reservation({ id: 'read-only-id', netName: 'LAN', clientName: 'client', exportToIpMacBinding: true });
        vi.mocked(request.fetchPaginated)
            .mockResolvedValueOnce([before])
            .mockResolvedValueOnce([reservation({ description: 'Updated' })]);
        const result = await ops.updateDhcpReservation('aa:bb:cc:dd:ee:ff', { description: 'Updated' }, 'site/one');
        expect(request.request).toHaveBeenCalledExactlyOnceWith(
            {
                method: 'PATCH',
                url: '/openapi/v1/controller/sites/site%2Fone/setting/service/dhcp/AA-BB-CC-DD-EE-FF',
                data: reservation({ description: 'Updated' }),
            },
            false
        );
        expect(result.changes).toEqual([{ field: 'description', before: 'Test client', after: 'Updated' }]);
        expect(result.verification?.status).toBe('verified');
    });

    it('does not send a mutation for already-desired settings regardless of MAC formatting and option key order', async () => {
        vi.mocked(request.fetchPaginated).mockResolvedValue([
            reservation({ mac: 'aa:bb:cc:dd:ee:ff', options: [{ value: 'example.test', type: 0, code: 15 }] }),
        ]);
        const result = await ops.updateDhcpReservation(MAC, { description: 'Test client', options: [{ code: 15, type: 0, value: 'example.test' }] });
        expect(result).toMatchObject({ written: false, changes: [] });
        expect(request.request).not.toHaveBeenCalled();
    });

    it('previews update with the complete documented request body', async () => {
        vi.mocked(request.fetchPaginated).mockResolvedValue([reservation()]);
        const result = await ops.updateDhcpReservation(MAC, { status: false }, undefined, true);
        expect(result).toMatchObject({ dryRun: true, written: false, requestBody: reservation({ status: false }) });
        expect(request.request).not.toHaveBeenCalled();
    });

    it('previews deletion without mutation', async () => {
        vi.mocked(request.fetchPaginated).mockResolvedValue([reservation()]);
        const result = await ops.deleteDhcpReservation(MAC, undefined, true);
        expect(result).toMatchObject({ operation: 'delete', dryRun: true, written: false, before: reservation() });
        expect(request.request).not.toHaveBeenCalled();
    });

    it('deletes by normalized MAC and verifies absence', async () => {
        vi.mocked(request.fetchPaginated).mockResolvedValueOnce([reservation()]).mockResolvedValueOnce([]);
        const result = await ops.deleteDhcpReservation('aa:bb:cc:dd:ee:ff');
        expect(request.request).toHaveBeenCalledExactlyOnceWith(
            {
                method: 'DELETE',
                url: '/openapi/v1/controller/sites/default-site/setting/service/dhcp/AA-BB-CC-DD-EE-FF',
            },
            false
        );
        expect(result).toMatchObject({ written: true, verification: { status: 'verified' } });
    });

    it.each(['update', 'delete'])('refuses %s for a missing reservation', async (operation) => {
        vi.mocked(request.fetchPaginated).mockResolvedValue([]);
        const pending = operation === 'delete' ? ops.deleteDhcpReservation(MAC) : ops.updateDhcpReservation(MAC, { status: false });
        await expect(pending).rejects.toThrow('No DHCP reservation');
        expect(request.request).not.toHaveBeenCalled();
    });

    it('refuses an empty update before reading or writing', async () => {
        await expect(ops.updateDhcpReservation(MAC, {})).rejects.toThrow('At least one');
        expect(request.fetchPaginated).not.toHaveBeenCalled();
    });

    it('refuses an update if controller state lacks required write fields', async () => {
        vi.mocked(request.fetchPaginated).mockResolvedValue([{ mac: MAC, ip: '192.0.2.50' }]);
        await expect(ops.updateDhcpReservation(MAC, { status: false })).rejects.toThrow('missing required');
        expect(request.request).not.toHaveBeenCalled();
    });

    it('does not reinterpret an explicit controller error as an uncertain write', async () => {
        vi.mocked(request.fetchPaginated).mockResolvedValue([]);
        vi.mocked(request.request).mockResolvedValue({ errorCode: -34514, msg: 'IP conflicts with existing reservation' });
        await expect(ops.createDhcpReservation(reservation())).rejects.toThrow('IP conflicts');
        expect(request.fetchPaginated).toHaveBeenCalledTimes(1);
        expect(request.request).toHaveBeenCalledTimes(1);
    });

    it('reports a persistent read-back mismatch without replaying the write', async () => {
        vi.mocked(request.fetchPaginated).mockResolvedValue([reservation()]);
        const pending = ops.updateDhcpReservation(MAC, { description: 'Not applied' });
        await vi.runAllTimersAsync();
        const result = await pending;
        expect(result).toMatchObject({ written: true, verification: { status: 'mismatch', attempts: 3 } });
        expect(result.after?.description).toBe('Test client');
        expect(request.request).toHaveBeenCalledTimes(1);
        expect(request.fetchPaginated).toHaveBeenCalledTimes(4);
    });

    it('accepts an eventually-consistent read-back on the final attempt', async () => {
        vi.mocked(request.fetchPaginated)
            .mockResolvedValueOnce([reservation()])
            .mockResolvedValueOnce([reservation()])
            .mockResolvedValueOnce([reservation()])
            .mockResolvedValueOnce([reservation({ status: false })]);
        const pending = ops.updateDhcpReservation(MAC, { status: false });
        await vi.runAllTimersAsync();
        await expect(pending).resolves.toMatchObject({ verification: { status: 'verified', attempts: 3 } });
        expect(request.request).toHaveBeenCalledTimes(1);
    });

    it('reconciles a lost response through reads without resending a mutation', async () => {
        vi.mocked(request.fetchPaginated).mockResolvedValueOnce([]).mockResolvedValueOnce([reservation()]);
        vi.mocked(request.request).mockRejectedValue(new AxiosError('socket closed after request', 'ECONNRESET'));
        const result = await ops.createDhcpReservation(reservation());
        expect(result).toMatchObject({ written: 'unknown', writeError: 'socket closed after request', verification: { status: 'verified' } });
        expect(request.request).toHaveBeenCalledTimes(1);
    });

    it('reports unknown outcome when both the mutation response and verification reads are lost', async () => {
        vi.mocked(request.fetchPaginated).mockResolvedValueOnce([]).mockRejectedValue(new Error('Controller unreachable'));
        vi.mocked(request.request).mockRejectedValue(new AxiosError('Write response lost', 'ETIMEDOUT'));
        const pending = ops.createDhcpReservation(reservation());
        await vi.runAllTimersAsync();
        await expect(pending).resolves.toMatchObject({ written: 'unknown', verification: { status: 'unknown', attempts: 3 } });
        expect(request.request).toHaveBeenCalledTimes(1);
    });

    it('reports unknown if verification fails after an acknowledged write', async () => {
        vi.mocked(request.fetchPaginated).mockResolvedValueOnce([reservation()]).mockRejectedValue(new Error('Read unavailable'));
        const pending = ops.deleteDhcpReservation(MAC);
        await vi.runAllTimersAsync();
        await expect(pending).resolves.toMatchObject({ written: true, verification: { status: 'unknown' } });
    });

    it('reports unknown rather than verified absence when read-back pages overlap', async () => {
        vi.mocked(request.fetchPaginated)
            .mockResolvedValueOnce([reservation()])
            .mockResolvedValue([reservation({ mac: 'AA-BB-CC-DD-EE-00' }), reservation({ mac: 'aa:bb:cc:dd:ee:00', ip: '192.0.2.52' })]);
        const pending = ops.deleteDhcpReservation(MAC);
        await vi.runAllTimersAsync();
        await expect(pending).resolves.toMatchObject({
            written: true,
            verification: { status: 'unknown', attempts: 3, message: expect.stringContaining('duplicate MAC') },
        });
        expect(request.request).toHaveBeenCalledTimes(1);
    });

    it('propagates a detailed HTTP failure that RequestHandler has already wrapped', async () => {
        vi.mocked(request.fetchPaginated).mockResolvedValue([]);
        vi.mocked(request.request).mockRejectedValue(new Error('Omada API request failed: POST /dhcp (HTTP 400) (errorCode: -34514) - IP conflict'));
        await expect(ops.createDhcpReservation(reservation())).rejects.toThrow('HTTP 400');
        expect(request.fetchPaginated).toHaveBeenCalledTimes(1);
    });

    it('does not reconcile a definite HTTP rejection', async () => {
        vi.mocked(request.fetchPaginated).mockResolvedValue([]);
        const rejection = { isAxiosError: true, response: { status: 400 }, message: 'Bad reservation' };
        vi.mocked(request.request).mockRejectedValue(rejection);
        await expect(ops.createDhcpReservation(reservation())).rejects.toEqual(rejection);
        expect(request.fetchPaginated).toHaveBeenCalledTimes(1);
    });
});
