import { describe, expect, it } from 'vitest';
import {
    compareDiagnosticSnapshots,
    diagnosticSnapshot,
    type NetworkDiagnosticSnapshot,
    networkDiagnosticSnapshotSchema,
    validateDiagnosticBaseline,
} from '../../src/omadaClient/networkDiagnosticComparison.js';
import type { NetworkDiagnosticSection } from '../../src/omadaClient/networkDiagnostics.js';

const MAC = 'AA-BB-CC-DD-EE-FF';
function snapshot(
    kind: NetworkDiagnosticSnapshot['kind'] = 'traffic',
    newer = false,
    overrides: Partial<Parameters<typeof diagnosticSnapshot>[0]> = {}
) {
    const start = newer ? 100 : 0;
    const sections: Record<string, NetworkDiagnosticSection> =
        kind === 'traffic'
            ? {
                  traffic: {
                      status: 'ok',
                      truncated: false,
                      data: {
                          apTrafficActivities: { data: [{ time: start + 10, txData: newer ? 3 : 1, rxData: 2 }] },
                          switchTrafficActivities: { data: [] },
                      },
                  },
              }
            : kind === 'wan'
              ? {
                    status: { status: 'ok', truncated: false, data: [{ port: 1, latency: newer ? 8 : 10, loss: newer ? 2 : 0 }] },
                    ispHistory: {
                        status: 'ok',
                        truncated: false,
                        data: [{ portId: 1, samples: { data: [{ time: start + 10, latency: newer ? 12 : 10, totalRate: 100 }] } }],
                    },
                    health: { status: 'ok', truncated: false, data: [{ port: 1, latency: 10, loss: 0 }] },
                }
              : {
                    channels: {
                        status: 'ok',
                        truncated: false,
                        data: { channels2g: [{ channel: 1, apNum: 2, clientNum: newer ? 3 : 1, channelUtilization: newer ? 40 : 20 }] },
                    },
                    interference: {
                        status: 'ok',
                        truncated: false,
                        data: { apInterference2g: [{ mac: MAC, interUtil: newer ? 15 : 10 }] },
                    },
                    wirelessRates: { status: 'ok', truncated: false, data: {} },
                };
    return diagnosticSnapshot({
        kind,
        controller: '/openapi/v1/controller',
        site: 'site',
        ...(kind === 'wan' ? { device: MAC } : {}),
        capturedAt: newer ? 2_000_000 : 1_000_000,
        completedAt: newer ? 2_000_010 : 1_000_010,
        start,
        end: start + 100,
        maxSamples: 100,
        sections,
        ...overrides,
    });
}

describe('portable diagnostic comparisons', () => {
    it('compares traffic observations at aligned offsets without traffic deltas or totals', () => {
        const old = snapshot();
        const current = snapshot('traffic', true);
        const comparison = compareDiagnosticSnapshots(old, current);
        expect(comparison).toMatchObject({ status: 'comparable', baselineAgeMs: 1_000_000, comparedMetrics: 2, changedPoints: 1 });
        expect(comparison.changes).toEqual([{ metric: 'apTrafficActivities/txData', offset: 10, before: 1, after: 3 }]);
        expect(comparison.notes.join(' ')).toContain('no traffic deltas or interval totals');
        expect(old.metrics.every((metric) => metric.arithmetic === 'observation-only' && metric.unit === 'MB')).toBe(true);
    });
    it('compares WAN point measurements in documented units, separately from site-wide ISP history', () => {
        const comparison = compareDiagnosticSnapshots(snapshot('wan'), snapshot('wan', true));
        expect(comparison.status).toBe('comparable');
        expect(comparison.changes).toEqual(
            expect.arrayContaining([
                { metric: 'wan/1/latency', offset: 0, before: 10, after: 8, delta: -2, deltaUnit: 'ms' },
                { metric: 'wan/1/loss', offset: 0, before: 0, after: 2, delta: 2, deltaUnit: 'percentage-points' },
                { metric: 'isp/1/latency', offset: 10, before: 10, after: 12, delta: 2, deltaUnit: 'ms' },
            ])
        );
        expect(comparison.notes.join(' ')).toContain('health-detail units are not specified');
        expect(snapshot('wan').metrics.some((metric) => metric.key.includes('totalRate') || metric.source.includes('health'))).toBe(false);
    });
    it('compares RF snapshots in percentage points and counts without treating them as window histories', () => {
        const old = snapshot('wifi');
        const current = snapshot('wifi', true);
        expect(old.metrics.every((metric) => metric.basis === 'current-snapshot' && metric.freshness === 'unknown')).toBe(true);
        const result = compareDiagnosticSnapshots(old, current);
        expect(result.status).toBe('comparable');
        expect(result.changes).toEqual(
            expect.arrayContaining([
                { metric: 'channel/2g/1/channelUtilization', offset: 0, before: 20, after: 40, delta: 20, deltaUnit: 'percentage-points' },
                { metric: 'channel/2g/1/clientNum', offset: 0, before: 1, after: 3, delta: 2, deltaUnit: 'count' },
            ])
        );
        expect(result.notes.join(' ')).toContain('unknown source freshness');
    });
    it.each([
        ['controller_changed', { controller: '/openapi/v1/other' }],
        ['site_changed', { site: 'another-site' }],
        ['window_duration_changed', { end: 201 }],
        ['sample_limit_changed', { maxSamples: 20 }],
        ['baseline_is_in_the_future', { capturedAt: 900_000 }],
        ['baseline_window_is_later', { start: -200, end: -100 }],
    ])('refuses incompatible scope/time evidence: %s', (reason, override) => {
        const result = compareDiagnosticSnapshots(snapshot(), snapshot('traffic', true, override));
        expect(result.status).toBe('not_comparable');
        expect(result.reasons).toContain(reason);
        expect(result.changes).toEqual([]);
    });
    it('refuses cross-workflow and changed data-source comparisons', () => {
        expect(compareDiagnosticSnapshots(snapshot(), snapshot('wan', true)).reasons).toContain('workflow_changed');
        const old = snapshot();
        old.sources.push('another-source');
        expect(compareDiagnosticSnapshots(old, snapshot('traffic', true)).reasons).toContain('sources_changed');
    });
    it('normalizes MAC separators/case but refuses another gateway', () => {
        const old = snapshot('wan', false, { device: 'aabbccddeeff' });
        expect(compareDiagnosticSnapshots(old, snapshot('wan', true)).status).toBe('comparable');
        const next = snapshot('wan', true, { device: '11:22:33:44:55:66' });
        expect(compareDiagnosticSnapshots(old, next).reasons).toContain('device_changed');
    });
    it('does not compare different inventory even when one metric happens to share a name', () => {
        const current = snapshot('wifi', true);
        current.scope.inventory = 'f'.repeat(64);
        const result = compareDiagnosticSnapshots(snapshot('wifi'), current);
        expect(result.reasons).toContain('evidence_inventory_changed');
        expect(result.comparedMetrics).toBe(0);
    });
    it('normalizes reordered series samples and inventory rows before comparing', () => {
        const traffic = (newer: boolean) =>
            snapshot('traffic', newer, {
                sections: {
                    traffic: {
                        status: 'ok',
                        truncated: false,
                        data: {
                            apTrafficActivities: {
                                data: (newer ? [10, 80] : [80, 10]).map((offset) => ({
                                    time: (newer ? 100 : 0) + offset,
                                    txData: offset,
                                    rxData: 0,
                                })),
                            },
                            switchTrafficActivities: { data: [] },
                        },
                    },
                },
            });
        expect(compareDiagnosticSnapshots(traffic(false), traffic(true))).toMatchObject({
            status: 'comparable',
            comparedMetrics: 2,
            changedPoints: 0,
        });
        const old = snapshot('wifi');
        const current = snapshot('wifi', true, {
            sections: {
                channels: {
                    status: 'ok',
                    truncated: false,
                    data: { '2g channel stat': [{ channel: 1, apNum: 2, clientNum: 1, channelUtilization: 20 }] },
                },
                interference: { status: 'ok', truncated: false, data: { apInterference2g: [{ mac: 'aabbccddeeff', interUtil: 10 }] } },
                wirelessRates: { status: 'ok', truncated: false, data: {} },
            },
        });
        expect(old.scope.inventory).toBe(current.scope.inventory);
        expect(compareDiagnosticSnapshots(old, current)).toMatchObject({ status: 'comparable', changedPoints: 0 });
    });
    it('retains safe partial comparisons when a previously available metric disappears', () => {
        const old = snapshot('wifi');
        const current = snapshot('wifi', true, {
            sections: {
                channels: {
                    status: 'partial',
                    truncated: false,
                    data: { channels2g: [{ channel: 1, apNum: 2, clientNum: 3 }] },
                    missing: ['channels2g:metrics'],
                },
                interference: { status: 'ok', truncated: false, data: { apInterference2g: [{ mac: MAC, interUtil: 15 }] } },
                wirelessRates: { status: 'ok', truncated: false, data: {} },
            },
        });
        const result = compareDiagnosticSnapshots(old, current);
        expect(result).toMatchObject({ status: 'partial', comparedMetrics: 3 });
        expect(result.excludedMetrics).toContainEqual({ metric: 'channel/2g/1/channelUtilization', reason: 'metric_availability_changed' });
        expect(result.changes.some((change) => change.metric.includes('channelUtilization'))).toBe(false);
    });
    it('refuses unit/semantic changes and null-availability changes per metric', () => {
        const old = snapshot('wan');
        old.metrics.find((metric) => metric.key === 'wan/1/latency')!.unit = 'percent';
        old.metrics.find((metric) => metric.key === 'wan/1/loss')!.points[0].value = null;
        const result = compareDiagnosticSnapshots(old, snapshot('wan', true));
        expect(result.status).toBe('partial');
        expect(result.comparedMetrics).toBe(1);
        expect(result.excludedMetrics).toEqual([
            { metric: 'wan/1/latency', reason: 'metric_semantics_changed' },
            { metric: 'wan/1/loss', reason: 'metric_availability_changed' },
        ]);
    });
    it('compares reordered observations deterministically and rejects changed sampling offsets', () => {
        const old = snapshot();
        const current = snapshot('traffic', true);
        old.metrics.reverse();
        expect(validateDiagnosticBaseline(old)!.metrics.map((metric) => metric.key)).toEqual(current.metrics.map((metric) => metric.key));
        old.metrics.find((metric) => metric.key.endsWith('txData'))!.points[0].offset++;
        expect(compareDiagnosticSnapshots(old, current).excludedMetrics).toContainEqual({
            metric: 'apTrafficActivities/txData',
            reason: 'sampling_offsets_changed',
        });
    });
    it('refuses ambiguous duplicate inventory instead of matching whichever row appeared first', () => {
        const current = snapshot('wan', true, {
            sections: {
                status: {
                    status: 'ok',
                    truncated: false,
                    data: [
                        { port: 1, latency: 1 },
                        { port: 1, latency: 99 },
                    ],
                },
            },
        });
        const result = compareDiagnosticSnapshots(current, { ...current, capturedAt: current.capturedAt + 100 });
        expect(result.status).toBe('not_comparable');
        expect(result.reasons).toContain('ambiguous_evidence_identity');
    });
    it('marks out-of-window and duplicate timestamps as uncomparable evidence without fabricated samples', () => {
        const result = snapshot('traffic', false, {
            sections: {
                traffic: {
                    status: 'ok',
                    truncated: false,
                    data: { apTrafficActivities: { data: [{ time: 101, txData: 2, rxData: 1 }] }, switchTrafficActivities: { data: [] } },
                },
            },
        });
        expect(result.metrics).toEqual([]);
        expect(result.incomplete).toBe(true);
        expect(compareDiagnosticSnapshots(result, { ...result, capturedAt: result.capturedAt + 100 }).reasons).toContain(
            'no_comparable_numeric_evidence'
        );
    });
    it('bounds detailed changes and discloses truncated comparison evidence', () => {
        const rows = (newer: boolean) => Array.from({ length: 200 }, (_, i) => ({ time: i, txData: newer ? i + 1 : i, rxData: 1 }));
        const make = (newer: boolean) =>
            snapshot('traffic', newer, {
                start: 0,
                end: 300,
                sections: {
                    traffic: {
                        status: 'ok',
                        truncated: false,
                        data: { apTrafficActivities: { data: rows(newer) }, switchTrafficActivities: { data: [] } },
                    },
                },
            });
        const result = compareDiagnosticSnapshots(make(false), make(true));
        expect(result).toMatchObject({ status: 'partial', changedPoints: 200, truncated: true });
        expect(result.changes).toHaveLength(100);
        expect(result.changes.every((change) => !Object.hasOwn(change, 'delta'))).toBe(true);
    });
    it('does not turn negative latency sentinels or invalid percentages into numeric deltas', () => {
        const current = snapshot('wan', true, {
            sections: {
                status: { status: 'ok', truncated: false, data: [{ port: 1, latency: -1, loss: 101 }] },
                ispHistory: { status: 'ok', truncated: false, data: [{ portId: 1, samples: { data: [{ time: 110, latency: 12 }] } }] },
            },
        });
        const result = compareDiagnosticSnapshots(snapshot('wan'), current);
        expect(result.status).toBe('partial');
        expect(result.comparedMetrics).toBe(1);
        expect(result.changes.every((change) => change.metric.startsWith('isp/'))).toBe(true);
        expect(current.exclusions.join(' ')).toContain('outside documented numeric domain');
    });
    it('rejects the total point budget before parsing or serializing nested point objects', () => {
        const point = {
            get offset() {
                throw new Error('Nested point was visited');
            },
            get value() {
                throw new Error('Nested point was visited');
            },
        };
        const value = { metrics: Array.from({ length: 11 }, () => ({ points: Array(1000).fill(point) })) };
        const parsed = networkDiagnosticSnapshotSchema.safeParse(value);
        expect(parsed.success).toBe(false);
        if (!parsed.success) expect(parsed.error.issues[0].message).toContain('total point budget');
        expect(() => validateDiagnosticBaseline(value)).toThrow('total point budget');
    });
    it('rejects a forged freshness/basis pair and excludes mismatched source or freshness semantics', () => {
        const old = snapshot('wan');
        const metric = old.metrics.find((row) => row.key === 'wan/1/loss')!;
        metric.freshness = 'sample-timestamps';
        expect(() => validateDiagnosticBaseline(old)).toThrow('metric evidence');
        const current = snapshot('wan', true);
        expect(compareDiagnosticSnapshots(old, current).excludedMetrics).toContainEqual({ metric: 'wan/1/loss', reason: 'metric_semantics_changed' });
        metric.freshness = 'unknown';
        metric.source = 'dashboard/isp-load';
        expect(compareDiagnosticSnapshots(old, current).excludedMetrics).toContainEqual({ metric: 'wan/1/loss', reason: 'metric_semantics_changed' });
    });
    it('validates portable JSON snapshots with explicit bounds, unique metric identities and supported units', () => {
        const old = snapshot();
        expect(validateDiagnosticBaseline(JSON.parse(JSON.stringify(old)))).toEqual(old);
        expect(validateDiagnosticBaseline(undefined)).toBeUndefined();
        const duplicate = structuredClone(old);
        duplicate.metrics.push(duplicate.metrics[0]);
        expect(() => validateDiagnosticBaseline(duplicate)).toThrow('duplicate evidence');
        const badUnit = structuredClone(old);
        Object.assign(badUnit.metrics[0], { unit: 'unknown-traffic-rate' });
        expect(() => validateDiagnosticBaseline(badUnit)).toThrow('Invalid diagnostic');
        expect(() => validateDiagnosticBaseline({ ...old, extra: 'x'.repeat(512 * 1024) })).toThrow('size limit');
    });
});
