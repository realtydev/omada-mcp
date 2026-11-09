import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkDiagnosisOperations } from '../../src/omadaClient/networkDiagnosis.js';

const NOW = Date.UTC(2026, 10, 9, 20),
    GW = 'AA-BB-CC-DD-EE-01',
    AP = 'AA-BB-CC-DD-EE-02',
    SW = 'AA-BB-CC-DD-EE-03',
    CLIENT = 'AA-BB-CC-DD-EE-04';
function setup() {
    const loop = { id: 'loop', key: 'OSW_DET_LOOP', time: NOW - 10000, content: `[switch:${SW}] port Tw1/0/1.` };
    const client = {
        listDevices: vi.fn().mockResolvedValue([
            { mac: GW, type: 'gateway', status: '1' },
            { mac: AP, type: 'ap', status: 1 },
            { mac: SW, type: 'switch', status: 1 },
        ]),
        listClients: vi.fn().mockResolvedValue([
            {
                mac: CLIENT,
                name: 'Printer',
                wireless: true,
                active: true,
                rssi: -90,
                snr: 5,
                healthScore: -1,
                apMac: AP,
                password: 'do-not-return',
            },
        ]),
        diagnoseWifi: vi.fn().mockResolvedValue({
            collectionComplete: true,
            aps: [
                {
                    mac: AP,
                    radios: { status: 'ok', data: { radios: [{ band: '5g', metrics: { actualChannelNumber: 149, channelWidth: '80MHz' } }] } },
                    rf: { status: 'ok' },
                },
            ],
            snapshot: { password: 'do-not-return' },
            password: 'do-not-return',
        }),
        getSwitchPortOverview: vi.fn().mockResolvedValue({
            collectionComplete: true,
            inventoryStatus: 'ok',
            switches: [{ status: 'complete' }],
            ports: [{ switchMac: SW, port: 1, portStatus: { linkStatus: 1, stpDiscarding: false } }],
        }),
        getSiteTopology: vi.fn().mockResolvedValue({ topologyArray: [{ password: 'do-not-return' }], lastUpdateTime: NOW - 1000 }),
        listEvents: vi.fn().mockResolvedValue({
            data: [loop, { id: 'clear', key: 'OSW_LOOP_C', time: NOW - 5000, content: `[switch:${SW}] port Tw1/0/1.` }],
            totalRows: 2,
            currentPage: 1,
        }),
        listAlerts: vi.fn().mockResolvedValue({ data: [loop], totalRows: 1, currentPage: 1 }),
        getRfPlanningStatus: vi
            .fn()
            .mockResolvedValue({ collectionComplete: true, readOnly: true, sections: { current: { status: 'ok', data: { status: 1 } } } }),
        diagnoseWan: vi.fn().mockResolvedValue({
            collectionComplete: true,
            sections: { status: { status: 'ok', data: [{ port: 1, status: 1, internetState: 1, latency: 4, loss: 0 }] } },
        }),
        getApSsidOverrides: vi.fn().mockResolvedValue({
            ssidOverrides: [
                {
                    ssidId: 'ssid',
                    ssidName: 'IoT',
                    password: 'do-not-return',
                    configured: { overrideSsidPassword: 'do-not-return' },
                    vlan: {
                        scope: 'configured_ssid_tagging',
                        override: { status: 'known', enabled: false },
                        inherited: { status: 'resolved', mode: 'explicit_vlan', vlanId: 20 },
                        effective: { status: 'resolved', mode: 'explicit_vlan', vlanId: 20, source: 'wlan_ssid' },
                    },
                },
            ],
        }),
    };
    return { client, ops: new NetworkDiagnosisOperations(client as never, { resolveSiteId: (id?: string) => id ?? 'site' } as never) };
}
describe('combined network evidence collection', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });
    it('collects bounded sources, preserves evidence links and never returns credentials or raw topology', async () => {
        const { client, ops } = setup();
        const r = await ops.diagnoseNetwork();
        expect(r).toMatchObject({
            readOnly: true,
            collectionComplete: true,
            summary: { managedDevices: 3, connectedDevices: 3, clients: 1, wirelessClients: 1, clientHealthScoresUnavailable: 1 },
            observationsTruncated: false,
        });
        expect(r.observations.map((o) => o.code)).toEqual(expect.arrayContaining(['weak_client_signal', 'historical_loop_cleared']));
        expect(client.listDevices).toHaveBeenCalledWith('site', { maxRecords: 1000 });
        expect(client.listClients).toHaveBeenCalledWith('site', { maxRecords: 1000 });
        expect(client.listEvents).toHaveBeenCalledWith('site', 1, 200, NOW - 24 * 3600000, NOW, undefined, undefined, 'OSG_', { maxPages: 4 });
        expect(client.diagnoseWan).toHaveBeenCalledWith({
            siteId: 'site',
            gatewayMac: GW,
            start: NOW / 1000 - 3600,
            end: NOW / 1000,
            maxSamples: 72,
        });
        expect(JSON.stringify(r)).not.toContain('do-not-return');
        expect(r.sections.topology).toMatchObject({ status: 'ok', data: { freshness: 'fresh' } });
        for (const o of r.observations)
            for (const path of o.evidence) {
                const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
                let value: unknown = r;
                for (const p of parts) value = (value as Record<string, unknown>)[p];
                expect(value).not.toBeUndefined();
            }
    });
    it('leaves other sections and observations available when a source is denied', async () => {
        const { client, ops } = setup();
        client.getSwitchPortOverview.mockRejectedValue(Object.assign(new Error('do-not-return'), { status: 403 }));
        const r = await ops.diagnoseNetwork();
        expect(r.collectionComplete).toBe(false);
        expect(r.sections.switchPorts.status).toBe('forbidden');
        expect(r.sections.clients.status).toBe('ok');
        expect(r.observations.some((o) => o.code === 'weak_client_signal')).toBe(true);
        expect(JSON.stringify(r)).not.toContain('do-not-return');
    });
    it('does not represent unavailable inventory as zero devices or an established absence of gateways', async () => {
        const { client, ops } = setup();
        client.listDevices.mockRejectedValue(new Error('private'));
        const r = await ops.diagnoseNetwork();
        expect(r.summary.managedDevices).toBeNull();
        expect(r.sections.wan.status).toBe('partial');
        expect(r.sections.vlans.status).toBe('partial');
        expect(client.diagnoseWan).not.toHaveBeenCalled();
    });
    it.each([
        ['old', NOW - 3600000, 'stale'],
        ['future', NOW + 3600000, 'unknown'],
        ['missing', undefined, 'unknown'],
        ['unqualified-seconds', NOW / 1000, 'unknown'],
    ] as const)('keeps %s topology incomplete', async (_label, time, freshness) => {
        const { client, ops } = setup();
        client.getSiteTopology.mockResolvedValue({ topologyArray: [], lastUpdateTime: time } as never);
        const r = await ops.diagnoseNetwork();
        expect(r.sections.topology).toMatchObject({ status: 'partial', data: { freshness } });
        expect(r.collectionComplete).toBe(false);
        expect(r.observations.some((o) => o.code === 'topology_not_fresh')).toBe(true);
    });
    it.each([
        { data: [], totalRows: 10, currentPage: 1 },
        { data: [], currentPage: 1 },
        { data: [], totalRows: 0, currentPage: 1, scanTruncated: true },
        { data: [{ id: 'bad', key: 'OSW_DET_LOOP', time: NOW + 1, content: 'future' }], totalRows: 1, currentPage: 1 },
    ])('does not treat incomplete log evidence as a complete empty window', async (logs) => {
        const { client, ops } = setup();
        client.listEvents.mockResolvedValue(logs as never);
        const r = await ops.diagnoseNetwork();
        expect(r.sections.events.status).toBe('partial');
        expect(r.collectionComplete).toBe(false);
    });
    it('rejects an unexpected history page and duplicate record IDs', async () => {
        const { client, ops } = setup();
        client.listEvents.mockResolvedValue({ data: [], totalRows: 0, currentPage: 2 } as never);
        expect((await ops.diagnoseNetwork()).sections.events.status).toBe('unknown');
        const e = { id: 'same', key: 'AP_RADAR', time: NOW - 5, content: 'radar' };
        client.listEvents.mockResolvedValue({ data: [e, e], totalRows: 2, currentPage: 1 } as never);
        const r = await ops.diagnoseNetwork();
        expect(r.sections.events.status).toBe('partial');
    });
    it('bounds observations rather than silently claiming a complete diagnosis', async () => {
        const { client, ops } = setup();
        client.listClients.mockResolvedValue(
            Array.from({ length: 150 }, (_, i) => ({ mac: `AA-BB-CC-DD-00-${i.toString(16).padStart(2, '0')}`, wireless: true, rssi: -90 })) as never
        );
        const r = await ops.diagnoseNetwork();
        expect(r.observations).toHaveLength(100);
        expect(r.observationsAvailable).toBeGreaterThan(100);
        expect(r.observationsTruncated).toBe(true);
        expect(r.collectionComplete).toBe(false);
    });
    it('bounds returned port detail and ignores an invalid optional AP attachment', async () => {
        const { client, ops } = setup();
        client.listClients.mockResolvedValue([{ mac: CLIENT, wireless: false, apMac: 'invalid', rssi: 0 }] as never);
        client.getSwitchPortOverview.mockResolvedValue({
            collectionComplete: true,
            switches: [],
            ports: Array.from({ length: 513 }, (_, i) => ({ port: i + 1 })),
        } as never);
        const r = await ops.diagnoseNetwork();
        expect(r.sections.switchPorts).toMatchObject({ status: 'partial', data: { portsTruncated: true } });
        expect(r.sections.clients.status).toBe('ok');
        expect(r.observations.some((o) => o.code === 'weak_client_signal')).toBe(false);
    });
    it('retains available AP VLAN evidence when one AP read fails and declares capped AP/gateway collections', async () => {
        const { client, ops } = setup();
        client.listDevices.mockResolvedValue([
            ...Array.from({ length: 5 }, (_, i) => ({ mac: `AA-BB-CC-DD-01-0${i}`, type: 'gateway', status: 1 })),
            { mac: AP, type: 'ap', status: 1 },
            { mac: SW, type: 'ap', status: 1 },
        ] as never);
        client.getApSsidOverrides.mockRejectedValue(new Error('private'));
        const r = await ops.diagnoseNetwork({ maxAps: 1 });
        expect(r.sections.wan).toMatchObject({ status: 'partial', data: { truncated: true } });
        expect(client.diagnoseWan).toHaveBeenCalledTimes(4);
        expect(r.sections.vlans).toMatchObject({ status: 'partial', data: { truncated: true } });
        expect(client.getApSsidOverrides).toHaveBeenCalledTimes(1);
    });
    it.each([{ maxAps: 0 }, { maxAps: 21 }, { hours: 25 }, { weakRssiDbm: -100 }, { unknown: true }])(
        'rejects invalid options before reads %j',
        async (args) => {
            const { client, ops } = setup();
            await expect(ops.diagnoseNetwork(args)).rejects.toThrow();
            expect(client.listDevices).not.toHaveBeenCalled();
        }
    );
});
