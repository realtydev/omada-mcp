import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { NetworkDiagnosticSection } from './networkDiagnostics.js';

const MAX_METRICS = 1024;
const MAX_POINTS = 10_000;
const MAX_SNAPSHOT_BYTES = 512 * 1024;
const MAX_CHANGES = 100;
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const boundedText = z.string().min(1).max(256);
const pointSchema = z.object({ offset: z.number().int().nonnegative().max(86_400), value: z.number().finite().nullable() }).strict();
const metricSchema = z
    .object({
        key: boundedText,
        source: boundedText,
        unit: z.enum(['MB', 'ms', 'percent', 'count']),
        basis: z.enum(['window-samples', 'current-snapshot']),
        arithmetic: z.enum(['point-difference', 'observation-only']),
        freshness: z.enum(['sample-timestamps', 'unknown']),
        points: z.array(pointSchema).max(1000),
    })
    .strict();

const networkDiagnosticSnapshotShape = z
    .object({
        version: z.literal(1),
        kind: z.enum(['traffic', 'wifi', 'wan']),
        capturedAt: z.number().int().nonnegative(),
        completedAt: z.number().int().nonnegative(),
        source: z.literal('controller-api'),
        scope: z
            .object({
                controller: digest,
                site: digest,
                device: z
                    .string()
                    .regex(/^[A-F0-9]{12}$/)
                    .optional(),
                inventory: digest,
            })
            .strict(),
        window: z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), unit: z.literal('seconds') }).strict(),
        maxSamples: z.number().int().min(1).max(1000),
        sources: z.array(boundedText).min(1).max(4),
        metrics: z.array(metricSchema).max(MAX_METRICS),
        incomplete: z.boolean(),
        exclusions: z.array(boundedText).max(20),
    })
    .strict();
// Count shallow collections before visiting point objects or allocating the Zod parse result.
function diagnosticBudgetError(value: unknown): string | undefined {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const metrics = (value as { metrics?: unknown }).metrics;
        if (Array.isArray(metrics)) {
            if (metrics.length > MAX_METRICS) return 'Diagnostic baseline exceeds the metric budget';
            let points = 0;
            for (const metric of metrics) {
                const samples = metric && typeof metric === 'object' ? (metric as { points?: unknown }).points : undefined;
                if (!Array.isArray(samples)) continue;
                if (samples.length > 1000) return 'Diagnostic baseline exceeds the per-metric point budget';
                points += samples.length;
                if (points > MAX_POINTS) return 'Diagnostic baseline exceeds the total point budget';
            }
        }
    }
    try {
        if (Buffer.byteLength(JSON.stringify(value)) > MAX_SNAPSHOT_BYTES) return 'Diagnostic baseline exceeds the size limit';
    } catch {
        return 'Diagnostic baseline must be bounded JSON';
    }
    return undefined;
}
const snapshotJsonSchema = z.toJSONSchema(networkDiagnosticSnapshotShape, { target: 'draft-7', io: 'input' });
delete snapshotJsonSchema.$schema;
export const networkDiagnosticSnapshotSchema = z
    .preprocess((value, context) => {
        const error = diagnosticBudgetError(value);
        if (error) {
            context.addIssue({ code: 'custom', message: error });
            return z.NEVER;
        }
        return value;
    }, networkDiagnosticSnapshotShape)
    // Preprocessing is identity-preserving; keep the strict shape visible to MCP clients.
    .meta(snapshotJsonSchema);
export type NetworkDiagnosticSnapshot = z.infer<typeof networkDiagnosticSnapshotSchema>;
type DiagnosticMetric = NetworkDiagnosticSnapshot['metrics'][number];
type DiagnosticKind = NetworkDiagnosticSnapshot['kind'];
export interface NetworkDiagnosticComparison {
    status: 'comparable' | 'partial' | 'not_comparable';
    reasons: string[];
    baselineAgeMs: number;
    comparedMetrics: number;
    changedPoints: number;
    changes: { metric: string; offset: number; before: number; after: number; delta?: number; deltaUnit?: string }[];
    truncated: boolean;
    excludedMetrics: { metric: string; reason: string }[];
    notes: string[];
}
interface SnapshotContext {
    kind: DiagnosticKind;
    controller: string;
    site: string;
    device?: string;
    capturedAt: number;
    completedAt: number;
    start: number;
    end: number;
    maxSamples: number;
    sections: Record<string, NetworkDiagnosticSection>;
}
const SOURCES: Record<DiagnosticKind, string[]> = {
    traffic: ['dashboard/traffic-activities'],
    wifi: ['dashboard/channels', 'dashboard/top-interference', 'dashboard/retry-dropped-rate'],
    wan: ['gateways/{gatewayMac}/wan-status', 'dashboard/isp-load', 'health/gateways/{gatewayMac}/wans/details'],
};
const object = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const number = (value: unknown): number | null | undefined =>
    value === null || (typeof value === 'number' && Number.isFinite(value)) ? value : undefined;
const validDomain = (value: number | null, unit: DiagnosticMetric['unit']): boolean =>
    value === null || (value >= 0 && (unit !== 'percent' || value <= 100) && (unit !== 'count' || Number.isSafeInteger(value)));
const mac = (value: unknown): string | undefined =>
    typeof value === 'string' && /^(?:[\da-f]{12}|(?:[\da-f]{2}[:-]){5}[\da-f]{2})$/i.test(value)
        ? value.replace(/[:-]/g, '').toUpperCase()
        : undefined;

/** Parse independently of the MCP adapter so direct callers cannot bypass snapshot bounds. */
export function validateDiagnosticBaseline(value: unknown): NetworkDiagnosticSnapshot | undefined {
    if (value === undefined) return undefined;
    const budgetError = diagnosticBudgetError(value);
    if (budgetError) throw new Error(budgetError);
    const parsed = networkDiagnosticSnapshotShape.safeParse(value);
    if (!parsed.success) throw new Error('Invalid diagnostic baseline snapshot');
    const result = parsed.data;
    if (
        result.completedAt < result.capturedAt ||
        result.window.start >= result.window.end ||
        result.window.end - result.window.start > 86_400 ||
        result.window.end * 1000 > result.capturedAt ||
        new Set(result.sources).size !== result.sources.length ||
        new Set(result.metrics.map((metric) => metric.key)).size !== result.metrics.length ||
        result.metrics.reduce((sum, metric) => sum + metric.points.length, 0) > MAX_POINTS
    )
        throw new Error('Invalid diagnostic baseline snapshot bounds or duplicate evidence');
    for (const metric of result.metrics) {
        if (
            !result.sources.includes(metric.source) ||
            new Set(metric.points.map((point) => point.offset)).size !== metric.points.length ||
            metric.points.some((point) => point.offset > result.window.end - result.window.start || !validDomain(point.value, metric.unit)) ||
            (metric.basis === 'current-snapshot' && (metric.points.length !== 1 || metric.points[0].offset !== 0)) ||
            (metric.basis === 'current-snapshot' && metric.freshness !== 'unknown') ||
            (metric.basis === 'window-samples' && metric.freshness !== 'sample-timestamps')
        )
            throw new Error('Invalid diagnostic baseline metric evidence');
    }
    result.sources.sort();
    result.metrics.sort((a, b) => a.key.localeCompare(b.key));
    for (const metric of result.metrics) metric.points.sort((a, b) => a.offset - b.offset);
    return result;
}

/** Summarize only documented numeric units; retain raw controller evidence in the parent result. */
export function diagnosticSnapshot(context: SnapshotContext): NetworkDiagnosticSnapshot {
    const metrics: DiagnosticMetric[] = [];
    const inventory: string[] = [];
    const exclusions = new Set<string>();
    let points = 0;
    let metricBytes = 0;
    let incomplete = Object.values(context.sections).some((section) => section.status !== 'ok' || section.truncated);
    const section = (name: string): unknown => {
        const value = context.sections[name];
        if (value?.status === 'ok' || value?.status === 'partial') return value.data;
        exclusions.add(`${name}: evidence unavailable`);
        return undefined;
    };
    const add = (metric: DiagnosticMetric): void => {
        if (metrics.some((item) => item.key === metric.key)) {
            exclusions.add('Duplicate metric identities cannot be compared');
            incomplete = true;
            return;
        }
        const bytes = Buffer.byteLength(JSON.stringify(metric));
        if (metrics.length >= MAX_METRICS || points + metric.points.length > MAX_POINTS || metricBytes + bytes > 400 * 1024) {
            exclusions.add('Snapshot evidence limit reached');
            incomplete = true;
            return;
        }
        metrics.push(metric);
        points += metric.points.length;
        metricBytes += bytes;
    };
    const current = (key: string, source: string, unit: DiagnosticMetric['unit'], value: unknown): void => {
        const parsed = number(value);
        if (parsed === undefined) return;
        if (!validDomain(parsed, unit)) {
            exclusions.add(`${key}: value outside documented numeric domain`);
            incomplete = true;
            return;
        }
        add({
            key,
            source,
            unit,
            basis: 'current-snapshot',
            arithmetic: 'point-difference',
            freshness: 'unknown',
            points: [{ offset: 0, value: parsed }],
        });
    };
    const timed = (
        key: string,
        source: string,
        unit: DiagnosticMetric['unit'],
        rows: unknown,
        field: string,
        arithmetic: DiagnosticMetric['arithmetic']
    ): void => {
        const samples = list(rows).map((item) => {
            const row = object(item);
            const value = number(row?.[field]);
            const time = row?.time;
            return typeof time === 'number' && Number.isSafeInteger(time) && value !== undefined
                ? { offset: time - context.start, value }
                : undefined;
        });
        if (
            samples.some((point) => !point || !validDomain(point.value, unit) || point.offset < 0 || point.offset > context.end - context.start) ||
            new Set(samples.map((point) => point?.offset)).size !== samples.length
        ) {
            exclusions.add(`${key}: invalid numeric values, duplicate or out-of-window sample timestamps`);
            incomplete = true;
            return;
        }
        add({
            key,
            source,
            unit,
            basis: 'window-samples',
            arithmetic,
            freshness: 'sample-timestamps',
            points: samples.filter((point) => point !== undefined).sort((a, b) => a.offset - b.offset),
        });
    };
    if (context.kind === 'traffic') {
        const data = object(section('traffic'));
        for (const group of ['apTrafficActivities', 'switchTrafficActivities']) {
            const series = object(data?.[group]);
            if (!series) continue;
            inventory.push(group);
            for (const field of ['txData', 'rxData', 'dxData']) {
                if (!list(series.data).some((row) => Object.hasOwn(object(row) ?? {}, field))) continue;
                timed(`${group}/${field}`, SOURCES.traffic[0], 'MB', series.data, field, 'observation-only');
            }
        }
        exclusions.add('Traffic accumulation/reset semantics are unknown; no traffic deltas or interval totals are calculated');
    }
    if (context.kind === 'wifi') {
        const channels = object(section('channels'));
        for (const [band, legacy, modern] of [
            ['2g', '2g channel stat', 'channels2g'],
            ['5g', '5g channel stat', 'channels5g'],
            ['6g', '6g channel stat', 'channels6g'],
        ]) {
            for (const item of list(channels?.[modern] ?? channels?.[legacy])) {
                const row = object(item);
                if (!Number.isSafeInteger(row?.channel)) continue;
                const id = `channel/${band}/${row!.channel}`;
                inventory.push(id);
                for (const field of ['apNum', 'clientNum']) current(`${id}/${field}`, SOURCES.wifi[0], 'count', row?.[field]);
                current(`${id}/channelUtilization`, SOURCES.wifi[0], 'percent', row?.channelUtilization);
            }
        }
        const interference = object(section('interference'));
        for (const band of ['apInterference2g', 'apInterference5g', 'apInterference5g2', 'apInterference6g']) {
            for (const item of list(interference?.[band])) {
                const row = object(item);
                const identity = mac(row?.mac);
                if (!identity) {
                    exclusions.add('Interference rows without a full MAC cannot be matched');
                    incomplete = true;
                    continue;
                }
                const id = `interference/${band}/${identity}`;
                inventory.push(id);
                current(`${id}/interUtil`, SOURCES.wifi[1], 'percent', row?.interUtil);
            }
        }
        exclusions.add('Retry/drop rates and mesh telemetry retain controller-native semantics and are not numerically compared');
    }
    if (context.kind === 'wan') {
        for (const item of list(section('status'))) {
            const row = object(item);
            if (!Number.isSafeInteger(row?.port)) continue;
            const id = `wan/${row!.port}`;
            inventory.push(id);
            current(`${id}/latency`, SOURCES.wan[0], 'ms', row?.latency);
            current(`${id}/loss`, SOURCES.wan[0], 'percent', row?.loss);
        }
        for (const item of list(section('ispHistory'))) {
            const row = object(item);
            if (!Number.isSafeInteger(row?.portId)) continue;
            const id = `isp/${row!.portId}`;
            inventory.push(id);
            timed(`${id}/latency`, SOURCES.wan[1], 'ms', object(row?.samples)?.data, 'latency', 'point-difference');
        }
        exclusions.add('ISP totalRate and health-detail units are not specified; those values are not numerically compared');
    }
    const sources = [...SOURCES[context.kind], ...(context.kind === 'wifi' && context.device ? ['aps/{apMac}/mesh/statistics'] : [])].sort();
    if (new Set(inventory).size !== inventory.length) {
        incomplete = true;
        exclusions.add('Duplicate inventory identities cannot establish a comparable scope');
    }
    return {
        version: 1,
        kind: context.kind,
        capturedAt: context.capturedAt,
        completedAt: context.completedAt,
        source: 'controller-api',
        scope: {
            controller: hash(context.controller),
            site: hash(context.site),
            ...(context.device ? { device: mac(context.device)! } : {}),
            inventory: hash(inventory.sort()),
        },
        window: { start: context.start, end: context.end, unit: 'seconds' },
        maxSamples: context.maxSamples,
        sources,
        metrics: metrics.sort((a, b) => a.key.localeCompare(b.key)),
        incomplete,
        exclusions: [...exclusions].sort().slice(0, 20),
    };
}

export function compareDiagnosticSnapshots(baseline: NetworkDiagnosticSnapshot, current: NetworkDiagnosticSnapshot): NetworkDiagnosticComparison {
    const reasons: string[] = [];
    const baselineAgeMs = current.capturedAt - baseline.capturedAt;
    const output: NetworkDiagnosticComparison = {
        status: 'not_comparable',
        reasons,
        baselineAgeMs,
        comparedMetrics: 0,
        changedPoints: 0,
        changes: [],
        truncated: false,
        excludedMetrics: [],
        notes: [
            'Snapshot capture time is not proof of telemetry freshness; current-snapshot measurements have unknown source freshness.',
            'Changes describe observed values only, without health scores, root-cause claims or inferred improvement.',
        ],
    };
    if (baseline.kind !== current.kind) reasons.push('workflow_changed');
    if (baseline.source !== current.source || JSON.stringify(baseline.sources) !== JSON.stringify(current.sources)) reasons.push('sources_changed');
    if (baseline.scope.controller !== current.scope.controller) reasons.push('controller_changed');
    if (baseline.scope.site !== current.scope.site) reasons.push('site_changed');
    if (baseline.scope.device !== current.scope.device) reasons.push('device_changed');
    if (baseline.scope.inventory !== current.scope.inventory) reasons.push('evidence_inventory_changed');
    if (baseline.window.end - baseline.window.start !== current.window.end - current.window.start) reasons.push('window_duration_changed');
    if (baseline.maxSamples !== current.maxSamples) reasons.push('sample_limit_changed');
    if (baselineAgeMs < 0 || baseline.completedAt > current.capturedAt) reasons.push('baseline_is_in_the_future');
    if (baseline.window.end > current.window.end) reasons.push('baseline_window_is_later');
    if ([...baseline.exclusions, ...current.exclusions].some((reason) => reason.startsWith('Duplicate ')))
        reasons.push('ambiguous_evidence_identity');
    if (reasons.length) return output;
    const previous = new Map(baseline.metrics.map((metric) => [metric.key, metric]));
    const now = new Map(current.metrics.map((metric) => [metric.key, metric]));
    for (const key of [...new Set([...previous.keys(), ...now.keys()])].sort()) {
        const before = previous.get(key);
        const after = now.get(key);
        let reason: string | undefined;
        if (!before || !after) reason = 'metric_availability_changed';
        else if (
            before.unit !== after.unit ||
            before.basis !== after.basis ||
            before.arithmetic !== after.arithmetic ||
            before.source !== after.source ||
            before.freshness !== after.freshness
        )
            reason = 'metric_semantics_changed';
        else if (JSON.stringify(before.points.map((point) => point.offset)) !== JSON.stringify(after.points.map((point) => point.offset)))
            reason = 'sampling_offsets_changed';
        else if (before.points.some((point, index) => (point.value === null) !== (after.points[index].value === null)))
            reason = 'metric_availability_changed';
        else if (!before.points.length || before.points.every((point) => point.value === null)) reason = 'no_numeric_samples';
        if (reason || !before || !after) {
            if (output.excludedMetrics.length < MAX_METRICS) output.excludedMetrics.push({ metric: key, reason: reason! });
            else output.truncated = true;
            continue;
        }
        output.comparedMetrics++;
        for (const [index, point] of before.points.entries()) {
            const value = after.points[index].value;
            if (point.value === null || value === null || point.value === value) continue;
            output.changedPoints++;
            if (output.changes.length >= MAX_CHANGES) {
                output.truncated = true;
                continue;
            }
            output.changes.push({
                metric: key,
                offset: point.offset,
                before: point.value,
                after: value,
                ...(after.arithmetic === 'point-difference'
                    ? { delta: value - point.value, deltaUnit: after.unit === 'percent' ? 'percentage-points' : after.unit }
                    : {}),
            });
        }
    }
    if (!output.comparedMetrics) reasons.push('no_comparable_numeric_evidence');
    else output.status = baseline.incomplete || current.incomplete || output.excludedMetrics.length || output.truncated ? 'partial' : 'comparable';
    if (baseline.incomplete || current.incomplete) reasons.push('partial_or_truncated_source_evidence');
    output.notes.push(...current.exclusions);
    return output;
}
