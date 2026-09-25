import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LogNotificationOperations } from '../../src/omadaClient/logNotification.js';
import type { RequestHandler } from '../../src/omadaClient/request.js';
import type { SiteOperations } from '../../src/omadaClient/site.js';
import type { LogNotificationItem, OmadaApiResponse } from '../../src/types/index.js';

const item = (key: string, enable: boolean, email = false, webhook = false): LogNotificationItem => ({ key, enable, email, webhook });

const makeState = (overrides: Record<string, unknown> = {}) => ({
    webhookConfig: { webhookEnable: false },
    alertNotifications: [item('DEV_DISCONN', true, true), item('AP_ISOLATE', true, true)],
    eventNotifications: [item('W_C_ROAM', false), item('W_C_DISCONN', false), item('DEV_DISCONN', true, true), item('AP_ISOLATE', true, true)],
    alertEmailSetting: { alertEmailEnable: false, delayEnable: false, delay: 60 },
    eventEmailSetting: { alertEmailEnable: false, delayEnable: false, delay: 60 },
    ...overrides,
});

const ok = (result: unknown): OmadaApiResponse<unknown> => ({ errorCode: 0, result });

describe('LogNotificationOperations', () => {
    let mockRequest: RequestHandler;
    let ops: LogNotificationOperations;
    const path = '/openapi/v2/test-omadac/sites/site-1/site/log-notification';

    /** GETs return the queued states in order; a PATCH applies `applied` (default: the body itself) as the next state. */
    const queueStates = (...states: unknown[]) => {
        for (const state of states) {
            vi.mocked(mockRequest.get).mockResolvedValueOnce(ok(state));
        }
    };

    beforeEach(() => {
        mockRequest = {
            get: vi.fn(),
            request: vi.fn().mockResolvedValue(ok(null)),
            ensureSuccess: vi.fn((response: OmadaApiResponse<unknown>) => {
                if (response.errorCode === 0) {
                    return response.result;
                }
                throw new Error(response.msg ?? 'API Error');
            }),
        } as unknown as RequestHandler;
        const site = { resolveSiteId: vi.fn((siteId?: string) => siteId ?? 'default-site') } as unknown as SiteOperations;
        ops = new LogNotificationOperations(mockRequest, site, (p: string, version = 'v1') => `/openapi/${version}/test-omadac${p}`);
    });

    it('should require at least one change', async () => {
        await expect(ops.setLogNotifications({ siteId: 'site-1' })).rejects.toThrow('At least one entry');
        await expect(ops.setLogNotifications({ siteId: 'site-1', events: [], alerts: [] })).rejects.toThrow('At least one entry');
        expect(mockRequest.get).not.toHaveBeenCalled();
    });

    it('should reject unknown keys before sending anything, naming the list', async () => {
        queueStates(makeState());

        await expect(
            ops.setLogNotifications({
                siteId: 'site-1',
                events: [
                    { key: 'W_C_ROAM', enable: true },
                    { key: 'NOPE', enable: true },
                ],
                alerts: [{ key: 'W_C_ROAM', enable: true }],
            })
        ).rejects.toThrow('NOPE (eventNotifications), W_C_ROAM (alertNotifications)');
        expect(mockRequest.request).not.toHaveBeenCalled();
    });

    it('should reject duplicate keys within one list', async () => {
        queueStates(makeState());

        await expect(
            ops.setLogNotifications({
                siteId: 'site-1',
                events: [
                    { key: 'W_C_ROAM', enable: true },
                    { key: 'W_C_ROAM', enable: false },
                ],
            })
        ).rejects.toThrow('Duplicate key W_C_ROAM');
        expect(mockRequest.request).not.toHaveBeenCalled();
    });

    it('should return the diff without writing on dryRun', async () => {
        queueStates(makeState());

        const result = await ops.setLogNotifications({ siteId: 'site-1', events: [{ key: 'W_C_ROAM', enable: true }], dryRun: true });

        expect(mockRequest.get).toHaveBeenCalledTimes(1);
        expect(mockRequest.get).toHaveBeenCalledWith(path);
        expect(mockRequest.request).not.toHaveBeenCalled();
        expect(result).toEqual({
            dryRun: true,
            written: false,
            changes: [
                {
                    list: 'event',
                    key: 'W_C_ROAM',
                    before: { enable: false, email: false, webhook: false },
                    after: { enable: true, email: false, webhook: false },
                },
            ],
            unchanged: [],
        });
    });

    it('should not write when every requested value is already set', async () => {
        queueStates(makeState());

        const result = await ops.setLogNotifications({ siteId: 'site-1', events: [{ key: 'DEV_DISCONN', enable: true }] });

        expect(mockRequest.request).not.toHaveBeenCalled();
        expect(result).toMatchObject({ dryRun: false, written: false, changes: [], unchanged: [{ list: 'event', key: 'DEV_DISCONN' }] });
    });

    it('should PATCH the full state back with only the named event flipped, then verify', async () => {
        const before = makeState();
        const after = makeState({ eventNotifications: [item('W_C_ROAM', true), ...before.eventNotifications.slice(1)] });
        queueStates(before, after);

        const result = await ops.setLogNotifications({ siteId: 'site-1', events: [{ key: 'W_C_ROAM', enable: true }] });

        expect(mockRequest.request).toHaveBeenCalledWith({
            method: 'PATCH',
            url: path,
            data: {
                webhookConfig: { webhookEnable: false },
                alertNotifications: before.alertNotifications,
                eventNotifications: after.eventNotifications,
                alertEmailSetting: before.alertEmailSetting,
                eventEmailSetting: before.eventEmailSetting,
            },
        });
        expect(mockRequest.get).toHaveBeenCalledTimes(2);
        expect(result.written).toBe(true);
        expect(result.changes).toHaveLength(1);
        expect(result.verification).toEqual({ ok: true, unexpectedChanges: [], missingChanges: [] });
    });

    it('should strip fields the API does not accept (shortMsg) from the sent items', async () => {
        const withShortMsg = makeState({ eventNotifications: [{ ...item('W_C_ROAM', false), shortMsg: 'Client Roaming (Wireless)' }] });
        queueStates(withShortMsg, makeState({ eventNotifications: [item('W_C_ROAM', true)] }));

        await ops.setLogNotifications({ siteId: 'site-1', events: [{ key: 'W_C_ROAM', enable: true }] });

        const sent = vi.mocked(mockRequest.request).mock.calls[0][0].data as { eventNotifications: unknown[] };
        expect(sent.eventNotifications).toEqual([item('W_C_ROAM', true)]);
    });

    it('should keep email and webhook when omitted and apply them when given', async () => {
        const before = makeState({ eventNotifications: [item('W_C_ROAM', false, true, true), item('W_C_DISCONN', false, true, true)] });
        queueStates(before, before);

        await ops.setLogNotifications({
            siteId: 'site-1',
            events: [
                { key: 'W_C_ROAM', enable: true },
                { key: 'W_C_DISCONN', enable: true, email: false, webhook: false },
            ],
        });

        const sent = vi.mocked(mockRequest.request).mock.calls[0][0].data as { eventNotifications: LogNotificationItem[] };
        expect(sent.eventNotifications).toEqual([item('W_C_ROAM', true, true, true), item('W_C_DISCONN', true, false, false)]);
    });

    it('should change an alert entry without touching the same key in the event list', async () => {
        const before = makeState();
        queueStates(before, makeState({ alertNotifications: [item('DEV_DISCONN', false, true), item('AP_ISOLATE', true, true)] }));

        const result = await ops.setLogNotifications({ siteId: 'site-1', alerts: [{ key: 'DEV_DISCONN', enable: false }] });

        const sent = vi.mocked(mockRequest.request).mock.calls[0][0].data as {
            alertNotifications: LogNotificationItem[];
            eventNotifications: LogNotificationItem[];
        };
        expect(sent.alertNotifications[0]).toEqual(item('DEV_DISCONN', false, true));
        expect(sent.eventNotifications).toEqual(before.eventNotifications);
        expect(result.verification?.ok).toBe(true);
    });

    it('should report an unexpected change to another entry after the write', async () => {
        const before = makeState();
        queueStates(
            before,
            makeState({
                eventNotifications: [
                    item('W_C_ROAM', true),
                    item('W_C_DISCONN', true),
                    item('DEV_DISCONN', true, true),
                    item('AP_ISOLATE', true, true),
                ],
            })
        );

        const result = await ops.setLogNotifications({ siteId: 'site-1', events: [{ key: 'W_C_ROAM', enable: true }] });

        expect(result.verification).toEqual({ ok: false, unexpectedChanges: ['eventNotifications:W_C_DISCONN'], missingChanges: [] });
    });

    it('should report a requested change that did not stick and a dropped entry', async () => {
        queueStates(makeState(), makeState({ eventNotifications: [item('W_C_ROAM', false)] }));

        const result = await ops.setLogNotifications({ siteId: 'site-1', events: [{ key: 'W_C_ROAM', enable: true }] });

        expect(result.verification?.ok).toBe(false);
        expect(result.verification?.missingChanges).toEqual(['eventNotifications:W_C_ROAM']);
        expect(result.verification?.unexpectedChanges).toEqual(
            expect.arrayContaining(['eventNotifications:W_C_DISCONN missing after write', 'eventNotifications length 4 -> 1'])
        );
    });

    it('should report a changed email setting as unexpected', async () => {
        queueStates(
            makeState(),
            makeState({
                eventNotifications: [
                    item('W_C_ROAM', true),
                    item('W_C_DISCONN', false),
                    item('DEV_DISCONN', true, true),
                    item('AP_ISOLATE', true, true),
                ],
                eventEmailSetting: { alertEmailEnable: true, delayEnable: false, delay: 60 },
            })
        );

        const result = await ops.setLogNotifications({ siteId: 'site-1', events: [{ key: 'W_C_ROAM', enable: true }] });

        expect(result.verification?.unexpectedChanges).toEqual(['eventEmailSetting']);
    });

    it('should propagate an API error from the PATCH and not re-read', async () => {
        queueStates(makeState());
        vi.mocked(mockRequest.request).mockResolvedValue({ errorCode: -1, msg: 'General error' });

        await expect(ops.setLogNotifications({ siteId: 'site-1', events: [{ key: 'W_C_ROAM', enable: true }] })).rejects.toThrow('General error');
        expect(mockRequest.get).toHaveBeenCalledTimes(1);
    });
});
