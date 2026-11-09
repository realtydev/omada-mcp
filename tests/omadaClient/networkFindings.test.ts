import { describe, expect, it } from 'vitest';
import { networkFindings } from '../../src/omadaClient/networkFindings.js';

const section = (data: unknown) => ({ status: 'ok', data });
const sw = 'AA-BB-CC-DD-EE-01';
const radio = (mac: string, channel: number, width = 80, band = '5g') => ({
    mac,
    radios: { status: 'ok', data: { radios: [{ band, metrics: { actualChannelNumber: channel, channelWidth: `${width}MHz` } }] } },
    rf: { status: 'ok' },
});
describe('evidence-linked network observations', () => {
    it('reports weak wireless clients by explicit policy, with a read-only next step', () => {
        const r = networkFindings({ clients: section([{ mac: sw, name: 'Printer', wireless: true, rssi: -90, apName: 'Outdoor', snr: 5 }]) }, -75);
        expect(r).toContainEqual(
            expect.objectContaining({
                code: 'weak_client_signal',
                basis: 'controller_snapshot',
                details: expect.objectContaining({ rssiDbm: -90, thresholdDbm: -75 }),
                nextTool: { name: 'diagnoseClient', arguments: { clientMac: sw } },
            })
        );
    });
    it.each([
        { wireless: false, rssi: -90 },
        { wireless: true, rssi: 0 },
        { wireless: true, rssi: -127 },
        { wireless: true, rssi: -999 },
        { wireless: true, rssi: -60 },
        { wireless: true },
        { wireless: true, rssi: -90, active: false },
    ])('does not diagnose invalid, missing or ineligible client signals: %j', (client) => {
        expect(networkFindings({ clients: section([client]) }, -75).some((o) => o.code === 'weak_client_signal')).toBe(false);
    });
    it.each([
        [149, 157, 80, true],
        [36, 44, 80, true],
        [36, 149, 80, false],
        [149, 157, 40, false],
        [149, 153, 40, true],
        [36, 52, 160, true],
        [36, 100, 160, false],
        [165, 149, 80, false],
    ] as const)('qualifies channel reuse %s/%s at %sMHz', (a, b, width, overlap) => {
        const r = networkFindings({ wifi: section({ aps: [radio(sw, a, width), radio('AA-BB-CC-DD-EE-02', b, width)] }) }, -75);
        expect(r.some((o) => o.code === 'shared_5g_spectrum')).toBe(overlap);
        if (overlap)
            expect(r.find((o) => o.code === 'shared_5g_spectrum')).toMatchObject({
                basis: 'candidate',
                message: expect.stringContaining('not proof'),
            });
    });
    it('does not infer overlap from auto/configuration indices, unknown channels or 6GHz numbers', () => {
        const missing = radio(sw, 149);
        Object.assign(missing.radios.data.radios[0].metrics, { actualChannelNumber: undefined });
        const r = networkFindings(
            { wifi: section({ aps: [missing, radio('AA-BB-CC-DD-EE-02', 149), radio('AA-BB-CC-DD-EE-03', 149, 80, '6g')] }) },
            -75
        );
        expect(r.some((o) => o.code === 'shared_5g_spectrum')).toBe(false);
        expect(r.some((o) => o.code === 'operating_channel_unknown')).toBe(true);
    });
    it('distinguishes current STP discarding from a proven loop and preserves stale evidence', () => {
        const r = networkFindings(
            {
                switchPorts: section({ ports: [{ switchMac: sw, port: 1, portStatus: { stpDiscarding: true } }] }),
                topology: section({ freshness: 'stale' }),
                wifi: section({
                    aps: [
                        {
                            mac: sw,
                            radios: { data: { radios: [{ band: '2g', metrics: { channelWidth: '40MHz' } }] } },
                            rf: { status: 'unavailable' },
                        },
                    ],
                }),
            },
            -75
        );
        expect(r.map((o) => o.code)).toEqual(
            expect.arrayContaining(['switch_port_discarding', 'topology_not_fresh', 'wide_2g_channel', 'rf_evidence_incomplete'])
        );
        expect(r.find((o) => o.code === 'switch_port_discarding')?.message).toContain('alone does not establish a loop');
    });
    it('correlates only later clears for the same switch and physical port and deduplicates event/alert copies', () => {
        const loop = { key: 'OSW_DET_LOOP', time: 100, content: `Loop on [switch:${sw}] port Tw1/0/1 and port Tw1/0/7.` };
        const r = networkFindings(
            {
                events: section({ records: [loop, { key: 'OSW_LOOP_C', time: 101, content: `Loop cleared on [switch:${sw}] port Tw1/0/1.` }] }),
                alerts: section({ records: [loop] }),
            },
            -75
        );
        expect(r.filter((o) => o.code === 'historical_loop_cleared')).toHaveLength(1);
        expect(r.find((o) => o.code === 'historical_loop_cleared')).toMatchObject({
            basis: 'historical_event',
            evidence: ['sections.events.data.records[0]', 'sections.events.data.records[1]'],
        });
    });
    it.each([
        [99, sw, 1],
        [101, sw, 2],
        [101, 'AA-BB-CC-DD-EE-02', 1],
    ] as const)('does not clear an incident with mismatched recovery evidence', (time, clearMac, port) => {
        const r = networkFindings(
            {
                events: section({ records: [{ key: 'OSW_LOOP_C', time, content: `[switch:${clearMac}] port Tw1/0/${port}.` }] }),
                alerts: section({ records: [{ key: 'OSW_DET_LOOP', time: 100, content: `[switch:${sw}] port Tw1/0/1.` }] }),
            },
            -75
        );
        expect(r.some((o) => o.code === 'historical_loop_cleared')).toBe(false);
        expect(r.find((o) => o.code === 'historical_loop_reported')?.message).toContain('does not establish an active loop');
    });
    it('retains current discarding evidence even after a historical clear', () => {
        const r = networkFindings(
            {
                switchPorts: section({ ports: [{ portStatus: { stpDiscarding: true } }] }),
                events: section({ records: [{ key: 'OSW_LOOP_C', time: 200, content: `[switch:${sw}] port Tw1/0/1.` }] }),
                alerts: section({ records: [{ key: 'OSW_DET_LOOP', time: 100, content: `[switch:${sw}] port Tw1/0/1.` }] }),
            },
            -75
        );
        expect(r.map((o) => o.code)).toEqual(expect.arrayContaining(['historical_loop_cleared', 'switch_port_discarding']));
    });
    it('reports radar history without treating missing WAN status or negative health scores as a fault', () => {
        const r = networkFindings(
            {
                devices: section([{ status: 1 }, { status: 0 }]),
                clients: section([{ healthScore: -1 }]),
                events: section({ records: [{ key: 'AP_RADAR', time: 200 }] }),
                wan: section({
                    gateways: [{ report: { sections: { status: { data: [{ name: 'unknown' }, { port: 1, status: 0, internetState: 0 }] } } } }],
                }),
            },
            -75
        );
        expect(r.filter((o) => o.code === 'wan_not_online')).toHaveLength(1);
        expect(r.map((o) => o.code)).toEqual(expect.arrayContaining(['device_not_connected', 'radar_reported']));
        expect(r.some((o) => o.code.includes('health'))).toBe(false);
    });
    it('keeps failed and partial sources visible without fabricating failures from empty evidence', () => {
        const r = networkFindings({ clients: { status: 'unavailable' }, wifi: { status: 'partial', data: { aps: [] } } }, -75);
        expect(r).toHaveLength(2);
        expect(r.every((o) => o.basis === 'evidence_gap')).toBe(true);
    });
});
