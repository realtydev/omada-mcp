import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SiteDashboardResult } from '../../src/omadaClient/monitor.js';
import { WifiAuditOperations } from '../../src/omadaClient/wifiAudit.js';
import type { OmadaDeviceInfo } from '../../src/types/index.js';

const NOW = Date.UTC(2026, 10, 9, 2);
const mac = (index: number) => `aabbcc${index.toString(16).padStart(6, '0')}`;
const device = (index: number): OmadaDeviceInfo => ({ mac: mac(index), type: 'ap', model: 'Test AP', status: '1' });
const radios = (channel = '1') => ({
    radioConfig: { radioSetting5g: { radioEnable: true, channel, channelWidth: '5', txPower: 19, txPowerLevel: 3, secret: 'do-not-return' } },
    radioStats: { wp5g: { actualChannel: '36', bandWidth: '80MHz', txUtil: 0, rxUtil: 20, interUtil: 5, busyUtil: 25 }, secret: 'do-not-return' },
});
const dashboard = (): SiteDashboardResult => ({
    capturedAt: NOW,
    completedAt: NOW,
    queryWindow: { start: NOW / 1000 - 3600, end: NOW / 1000, unit: 'seconds' },
    collectionComplete: true,
    sections: {
        wifi: {
            status: 'ok',
            truncated: false,
            data: { connectedApNum: 1, clients: 5, channelUtilization: 25, totalTraffic: 0, password: 'do-not-return' },
        },
        traffic: { status: 'ok', truncated: false, data: [] },
        wirelessRates: {
            status: 'ok',
            truncated: false,
            data: { retryEaps: [{ apMac: mac(1), avg: 0, password: 'do-not-return' }], droppedEaps: [] },
        },
        switches: { status: 'ok', truncated: false, data: [] },
        poe: { status: 'ok', truncated: false, data: [] },
    },
});
function setup(devices = [device(1)]) {
    const client = {
        listDevices: vi.fn().mockResolvedValue(devices),
        getSiteDashboard: vi.fn().mockImplementation(async () => dashboard()),
        getApRadios: vi.fn().mockResolvedValue(radios()),
        getApRfScanResults: vi.fn().mockResolvedValue({ status: 0, time: NOW - 1000, channel5g: [{ securityKey: 'do-not-return' }] }),
        startRfScan: vi.fn(),
        setApRadio: vi.fn(),
        genericApiCall: vi.fn(),
    };
    return { client, audit: new WifiAuditOperations(client, { omadacId: 'controller-1', siteId: 'site-1' }) };
}

describe('Wi-Fi audit workflow', () => {
    it.each([
        ['157 / 5785MHz', 157, 5785],
        ['36', 36, undefined],
        ['157 / 5200MHz', undefined, undefined],
        ['<script>', undefined, undefined],
    ] as const)('qualifies controller operating channel %s', async (actualChannel, channel, frequency) => {
        const { client, audit } = setup();
        const value = radios();
        value.radioStats.wp5g.actualChannel = actualChannel;
        client.getApRadios.mockResolvedValue(value);
        const result = await audit.diagnoseWifi();
        const evidence = result.aps[0].radios;
        if (evidence.status === 'ok' || evidence.status === 'partial') {
            expect(evidence.data.radios[0].metrics.actualChannelNumber).toBe(channel);
            expect(evidence.data.radios[0].metrics.frequencyMHz).toBe(frequency);
        } else throw new Error('Radio evidence unavailable');
    });
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('collects only read evidence, preserves zero, and returns no arbitrary payload fields', async () => {
        const { client, audit } = setup();
        const result = await audit.diagnoseWifi();
        expect(result.collectionComplete).toBe(true);
        expect(result.snapshot.complete).toBe(true);
        expect(result.aps[0].radios).toMatchObject({
            status: 'ok',
            data: { radios: [{ band: '5g', configuration: { channelIndex: 1, channelWidthCode: 5 }, metrics: { txUtilPercent: 0 } }] },
        });
        expect(result.dashboard).toMatchObject({ data: { wifi: { data: { totalTraffic: 0, channelUtilization: 25 } } } });
        expect(result.comparison.status).toBe('not_requested');
        expect(client.getSiteDashboard).toHaveBeenCalledExactlyOnceWith({ siteId: 'site-1', start: NOW / 1000 - 3600, end: NOW / 1000 });
        expect(client.startRfScan).not.toHaveBeenCalled();
        expect(client.setApRadio).not.toHaveBeenCalled();
        expect(client.genericApiCall).not.toHaveBeenCalled();
        expect(JSON.stringify(result)).not.toContain('do-not-return');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps AP, dashboard and saved-scan failures explicit without echoing vendor messages', async () => {
        const { client, audit } = setup();
        client.getApRadios.mockRejectedValue(Object.assign(new Error('secret-password'), { errorCode: -1600 }));
        client.getApRfScanResults.mockResolvedValue({ status: 1 });
        client.getSiteDashboard.mockRejectedValue(new Error('secret-password'));
        const result = await audit.diagnoseWifi();
        expect(result.collectionComplete).toBe(false);
        expect(result.snapshot.complete).toBe(false);
        expect(result.aps[0].radios).toMatchObject({ status: 'error', errorCode: -1600 });
        expect(result.aps[0].rf).toMatchObject({ status: 'unavailable', reason: 'No saved RF scan result.' });
        expect(result.dashboard.status).toBe('error');
        expect(result.observations.map((item) => item.code)).toEqual(
            expect.arrayContaining(['radio_evidence_incomplete', 'rf_evidence_incomplete', 'dashboard_incomplete'])
        );
        expect(JSON.stringify(result)).not.toContain('secret-password');
    });

    it('bounds selected APs and marks incomplete scope instead of silently omitting them', async () => {
        const { client, audit } = setup([device(3), device(1), device(2)]);
        const result = await audit.diagnoseWifi({ maxAps: 2 });
        expect(result.aps.map((ap) => ap.mac)).toEqual([mac(1), mac(2)]);
        expect(result.inventory).toMatchObject({ status: 'partial', data: { apsDiscovered: 3, selectedAps: 2, truncated: true } });
        expect(result.snapshot.complete).toBe(false);
        expect(client.getApRadios).toHaveBeenCalledTimes(2);
        expect(client.getApRfScanResults).toHaveBeenCalledTimes(2);
    });

    it('normalizes identities and selection ordering independently of inventory order', async () => {
        const { client, audit } = setup([device(2), { ...device(1), mac: 'AA:BB:CC:00:00:01' }]);
        const first = await audit.diagnoseWifi();
        client.listDevices.mockResolvedValue([device(1), device(2)]);
        const second = await audit.diagnoseWifi({ baseline: first.snapshot });
        expect(second.snapshot.inventoryFingerprint).toBe(first.snapshot.inventoryFingerprint);
        expect(second.comparison).toMatchObject({ status: 'comparable', changes: [] });
    });

    it('compares only explicit configuration fields and does not call a difference an improvement', async () => {
        const { client, audit } = setup();
        const initial = await audit.diagnoseWifi();
        client.getApRadios.mockResolvedValue(radios('2'));
        const result = await audit.diagnoseWifi({ baseline: initial.snapshot });
        expect(result.comparison).toMatchObject({
            status: 'comparable',
            changes: [{ apMac: mac(1), band: '5g', field: 'channelIndex', before: 1, after: 2 }],
        });
        expect(result.comparison).toHaveProperty('interpretation', expect.stringContaining('does not establish performance improvement'));
    });

    it.each(['controllerId', 'siteId', 'inventoryFingerprint', 'maxAps'] as const)('refuses baseline comparison with different %s', async (field) => {
        const { audit } = setup();
        const initial = await audit.diagnoseWifi();
        const baseline = { ...initial.snapshot, [field]: field === 'maxAps' ? 11 : field === 'inventoryFingerprint' ? '0'.repeat(64) : 'other' };
        const result = await audit.diagnoseWifi({ baseline });
        expect(result.comparison.status).toBe('not_comparable');
    });

    it('rejects incomplete, duplicated and future baseline scopes', async () => {
        const { audit } = setup();
        const { snapshot } = await audit.diagnoseWifi();
        for (const baseline of [
            { ...snapshot, complete: false },
            { ...snapshot, aps: [...snapshot.aps, ...snapshot.aps] },
            { ...snapshot, capturedAt: NOW + 1 },
        ]) {
            expect((await audit.diagnoseWifi({ baseline })).comparison.status).toBe('not_comparable');
        }
    });

    it('does not compare configuration fields absent on one side', async () => {
        const { client, audit } = setup();
        const initial = await audit.diagnoseWifi();
        client.getApRadios.mockResolvedValue({
            radioConfig: { radioSetting5g: { radioEnable: true, channel: 1, channelWidth: 5 } },
            radioStats: { wp5g: { txUtil: 1 } },
        });
        expect((await audit.diagnoseWifi({ baseline: initial.snapshot })).comparison.status).toBe('not_comparable');
    });

    it.each([{ status: 0 }, { status: 0, time: NOW + 120000, channel5g: [] }, { status: 0, time: NOW - 86400001, channel5g: [] }])(
        'reports missing/future/stale scan timestamps: %j',
        async (rf) => {
            const { client, audit } = setup();
            client.getApRfScanResults.mockResolvedValue(rf);
            const result = await audit.diagnoseWifi();
            expect(result.collectionComplete).toBe(false);
            expect(result.aps[0].rf.status).not.toBe('ok');
            expect(client.startRfScan).not.toHaveBeenCalled();
        }
    );

    it('does not interpret missing radio metrics as zero or healthy', async () => {
        const { client, audit } = setup();
        client.getApRadios.mockResolvedValue({ ...radios(), radioStats: { wp5g: {} } });
        const result = await audit.diagnoseWifi();
        expect(result.aps[0].radios).toMatchObject({ status: 'partial', data: { radios: [{ metrics: {} }] } });
        expect(result.collectionComplete).toBe(false);
    });

    it('retains null dashboard values as incomplete evidence instead of converting them to zero', async () => {
        const { client, audit } = setup();
        const value = dashboard();
        value.sections.wifi = { status: 'ok', truncated: false, data: { connectedApNum: 1, clients: 5, channelUtilization: null, totalTraffic: 0 } };
        client.getSiteDashboard.mockResolvedValue(value);
        const result = await audit.diagnoseWifi();
        expect(result.dashboard).toMatchObject({
            status: 'partial',
            data: { wifi: { status: 'partial', data: { channelUtilization: null, totalTraffic: 0 } } },
        });
        expect(result.collectionComplete).toBe(false);
    });

    it('preserves mixed per-band RF status and age instead of claiming all results are fresh', async () => {
        const { client, audit } = setup();
        for (const sample of [
            { status: 0, time: NOW, status5g: 2, channel5g: [] },
            { status: 0, time: NOW, time5g: NOW - 86400001, channel5g: [] },
            { status: 0, time: NOW, time2g: NOW - 86400001, channel2g: [] },
        ]) {
            client.getApRfScanResults.mockResolvedValue(sample);
            const result = await audit.diagnoseWifi();
            expect(result.aps[0].rf.status).toBe('partial');
            expect(result.collectionComplete).toBe(false);
            if ('data' in result.aps[0].rf) {
                expect(result.aps[0].rf.data.reportedStatuses.status).toBe(0);
                if ('status5g' in sample) expect(result.aps[0].rf.data.reportedStatuses.status5g).toBe(2);
                if ('time5g' in sample || 'time2g' in sample) expect(result.aps[0].rf.data.freshness).toBe('stale');
                if ('time2g' in sample) expect(result.aps[0].rf.data.notes.join(' ')).toContain('ambiguous');
            }
        }
    });

    it('preserves unavailable inventory and refuses duplicate AP identities', async () => {
        const { client, audit } = setup([device(1), device(1)]);
        const duplicate = await audit.diagnoseWifi();
        expect(duplicate.inventory.status).toBe('partial');
        expect(duplicate.snapshot.complete).toBe(false);
        expect(duplicate.aps).toEqual([]);
        client.listDevices.mockRejectedValue(new Error('inventory secret'));
        const failed = await audit.diagnoseWifi();
        expect(failed.inventory.status).toBe('error');
        expect(failed.dashboard.status).toBe('ok');
        expect(failed.collectionComplete).toBe(false);
    });

    it('does not declare an authoritative zero-AP inventory from unknown device types', async () => {
        const { audit } = setup([{ mac: mac(1), type: 'future-ap-type' }]);
        const result = await audit.diagnoseWifi();
        expect(result.inventory.status).toBe('partial');
        expect(result.collectionComplete).toBe(false);
    });

    it('stops starting reads after the overall budget and returns partial evidence', async () => {
        const { client, audit } = setup([device(1), device(2)]);
        client.getApRadios.mockReturnValue(
            new Promise(() => {
                /* Intentionally unresolved to exercise the collection deadline. */
            })
        );
        const pending = audit.diagnoseWifi();
        await vi.advanceTimersByTimeAsync(30000);
        const result = await pending;
        expect(result.completedAt - result.capturedAt).toBe(30000);
        expect(result.collectionComplete).toBe(false);
        expect(result.aps).toHaveLength(2);
        expect(client.getApRadios).toHaveBeenCalledTimes(1);
        expect(client.getApRfScanResults).toHaveBeenCalledTimes(1);
        expect(client.listDevices.mock.calls[0][1].maxRecords).toBe(2000);
        expect(client.listDevices.mock.calls[0][1].signal.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('validates size, schema, and required site before collecting any data', async () => {
        const { client, audit } = setup();
        await expect(audit.diagnoseWifi({ maxAps: 26 })).rejects.toThrow();
        await expect(audit.diagnoseWifi({ baseline: { ...(await audit.diagnoseWifi()).snapshot, version: 2 } as never })).rejects.toThrow();
        client.listDevices.mockClear();
        client.getSiteDashboard.mockClear();
        await expect(audit.diagnoseWifi({ siteId: 'x'.repeat(129) })).rejects.toThrow();
        await expect(audit.diagnoseWifi({ siteId: 'x'.repeat(128 * 1024) })).rejects.toThrow('128 KiB');
        await expect(new WifiAuditOperations(client, { omadacId: 'controller' }).diagnoseWifi()).rejects.toThrow('site ID');
        expect(client.listDevices).not.toHaveBeenCalled();
        expect(client.getSiteDashboard).not.toHaveBeenCalled();
    });
});
