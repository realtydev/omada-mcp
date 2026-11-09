import { isDeepStrictEqual } from 'node:util';
import axios from 'axios';
import { z } from 'zod';
import type { OmadaApiResponse } from '../types/index.js';
import { verifyWrite } from '../utils/write-verification.js';
import type { InternalRequestHandler } from './internalRequest.js';
import type { RequestHandler } from './request.js';
import type { SiteOperations } from './site.js';

export const apMacSchema = z.string().regex(/^(?:[\da-f]{12}|(?:[\da-f]{2}[:-]){5}[\da-f]{2})$/i);
export const ssidEntryIdSchema = z.number().int().min(0).max(2_147_483_647);
const nameSchema = z
    .string()
    .min(1)
    .refine((value) => Buffer.byteLength(value, 'utf8') <= 32, 'SSID name must fit 32 UTF-8 bytes');
const passwordSchema = z
    .string()
    .min(8)
    .max(63)
    .refine((value) => [...value].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) <= 126), 'Password must be printable ASCII');
export const apSsidOverrideUpdateSchema = z
    .object({
        ssidEnable: z.boolean().optional(),
        overrideSsidEnable: z.boolean().optional(),
        overrideSsidName: nameSchema.optional(),
        overrideSsidPassword: passwordSchema.optional(),
        overrideVlanEnable: z.boolean().optional(),
        vlanId: z.number().int().min(1).max(4094).optional(),
        vlanPoolIds: z.string().min(1).max(2048).optional(),
    })
    .strict()
    .refine((value) => Object.values(value).some((v) => v !== undefined), 'At least one override setting is required');
export type ApSsidOverrideUpdate = z.infer<typeof apSsidOverrideUpdateSchema>;
type Row = Record<string, unknown>;
interface Entry {
    ssidEntryId: number;
    overrideSsidEnable: boolean;
    overrideVlanEnable: boolean;
    ssidEnable: boolean;
    overrideSsidName?: string;
    overrideSsidPassword?: string;
    vlanId?: number;
    vlanPoolIds?: string;
}
interface Snapshot {
    effective: Row[];
    entries: Entry[];
    writable: Map<number, boolean>;
    group: unknown;
}
const effectiveSchema = z.object({
    ssidEntryId: ssidEntryIdSchema,
    ssidId: z.string().min(1).max(256),
    ssidName: z.string().max(128),
    security: z.number().int().min(0).max(64),
    ssidEnable: z.boolean(),
    band: z.array(z.number().int().min(0).max(2)).max(3).optional(),
    vlanEnable: z.boolean().optional(),
    vlanId: z.number().int().optional(),
    vlanPoolIds: z.string().max(2048).optional(),
});
const hidden = (value: unknown) => typeof value !== 'string' || !value || /^\*+$/.test(value) || value === '[redacted]';
const row = (value: unknown): Row => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AP override evidence is not an object');
    return value as Row;
};
function rows(value: unknown, id: string): Row[] {
    if (!Array.isArray(value) || value.length > 256) throw new Error('AP override evidence must contain at most 256 entries');
    const seen = new Set<number>();
    return value
        .map((value) => {
            const item = row(value);
            const key = ssidEntryIdSchema.parse(item[id]);
            if (seen.has(key)) throw new Error('AP override evidence contains duplicate SSID entry IDs');
            seen.add(key);
            return item;
        })
        .sort((a, b) => Number(a[id]) - Number(b[id]));
}
function redact(entry: Entry): Row {
    const { overrideSsidPassword, ...other } = entry;
    return { ...other, ...(overrideSsidPassword !== undefined ? { overrideSsidPassword: '[redacted]' } : {}) };
}
function canonical(entry: Entry): Entry {
    const result = { ...entry };
    if (!result.overrideSsidEnable) {
        delete result.overrideSsidName;
        delete result.overrideSsidPassword;
    }
    if (!result.overrideVlanEnable) {
        delete result.vlanId;
        delete result.vlanPoolIds;
    }
    return result;
}
function verificationEntries(entries: Entry[]): Entry[] {
    return entries.map((entry) => {
        const result = { ...entry };
        // Controller 6.3 echoes a scalar VLAN ID in vlanPoolIds as well.
        // Only this exact redundant representation is equivalent to an omitted pool.
        if (result.vlanId !== undefined && result.vlanPoolIds === String(result.vlanId)) delete result.vlanPoolIds;
        return result;
    });
}
function normalize(entry: Entry, security: unknown): Entry {
    const result = { ...entry };
    if (result.overrideSsidEnable) {
        result.overrideSsidName = nameSchema.parse(result.overrideSsidName);
        if (security === 3) {
            if (hidden(result.overrideSsidPassword))
                throw new Error('Cannot preserve an active personal-security override: supply the actual overrideSsidPassword');
            result.overrideSsidPassword = passwordSchema.parse(result.overrideSsidPassword);
        } else {
            if (![0, 2, 4, 5].includes(Number(security))) throw new Error('Cannot preserve an unknown SSID security mode');
            delete result.overrideSsidPassword;
        }
    } else {
        delete result.overrideSsidName;
        delete result.overrideSsidPassword;
    }
    if (result.overrideVlanEnable) {
        if (result.vlanId === undefined && !result.vlanPoolIds) throw new Error('An enabled VLAN override requires vlanId or vlanPoolIds');
        if (result.vlanId !== undefined) z.number().int().min(1).max(4094).parse(result.vlanId);
        if (result.vlanPoolIds !== undefined) z.string().min(1).max(2048).parse(result.vlanPoolIds);
    } else {
        delete result.vlanId;
        delete result.vlanPoolIds;
    }
    return result;
}

/** Public v2 writes with web-configuration evidence for flags absent from the public GET. */
export class ApSsidOverrideOperations {
    private internal?: InternalRequestHandler;
    constructor(
        private readonly request: RequestHandler,
        private readonly site: SiteOperations,
        private readonly buildPath: (path: string, version?: string) => string
    ) {}
    public setInternalRequest(request: InternalRequestHandler): void {
        this.internal = request;
    }
    private path(apMac: string, siteId?: string): { mac: string; siteId: string; relative: string; path: string } {
        const mac = apMacSchema.parse(apMac).replace(/[:-]/g, '').match(/.{2}/g)!.join('-').toUpperCase();
        const resolved = this.site.resolveSiteId(siteId);
        const relative = `/sites/${encodeURIComponent(resolved)}/aps/${encodeURIComponent(mac)}/override`;
        return { mac, siteId: resolved, relative, path: this.buildPath(relative, 'v2') };
    }
    private async effective(path: string): Promise<{ entries: Row[]; group: unknown }> {
        const response = await this.request.get<OmadaApiResponse<unknown>>(path);
        const value = row(this.request.ensureSuccess(response));
        return { entries: rows(value.ssidOverrides, 'ssidEntryId').map((entry) => effectiveSchema.parse(entry)), group: value.apGroupId };
    }
    private async snapshot(
        target: ReturnType<ApSsidOverrideOperations['path']>,
        effective?: Awaited<ReturnType<ApSsidOverrideOperations['effective']>>
    ): Promise<Snapshot> {
        const current = effective ?? (await this.effective(target.path));
        if (!this.internal)
            throw new Error('Preserving AP overrides requires configured internal web API credentials; the public GET omits override flags');
        const config = row(
            this.internal.ensureSuccess(
                await this.internal.get<OmadaApiResponse<unknown>>(
                    `/sites/${encodeURIComponent(target.siteId)}/eaps/${encodeURIComponent(target.mac)}`
                )
            )
        );
        const raw = rows(config.ssidOverrides, 'index');
        if (raw.length !== current.entries.length || raw.some((e, i) => e.index !== current.entries[i].ssidEntryId))
            throw new Error('Public and configuration SSID inventories do not match');
        const writable = new Map<number, boolean>();
        const entries = raw.map((e, i): Entry => {
            if (typeof e.enable !== 'boolean' || typeof e.vlanEnable !== 'boolean' || typeof e.ssidEnable !== 'boolean')
                throw new Error('AP configuration omitted required override flags');
            if (e.security !== current.entries[i].security) throw new Error('Public and configuration SSID security evidence does not match');
            writable.set(Number(e.index), e.ssidConfigurable === true);
            return {
                ssidEntryId: Number(e.index),
                overrideSsidEnable: e.enable,
                overrideVlanEnable: e.vlanEnable,
                ssidEnable: e.ssidEnable,
                ...(typeof e.ssid === 'string' ? { overrideSsidName: e.ssid } : {}),
                ...(!hidden(e.psk) ? { overrideSsidPassword: e.psk as string } : {}),
                ...(typeof e.vlanId === 'number' ? { vlanId: e.vlanId } : {}),
                ...(typeof e.vlanPoolIds === 'string' && e.vlanPoolIds ? { vlanPoolIds: e.vlanPoolIds } : {}),
            };
        });
        return { effective: current.entries, entries, writable, group: { apGroupId: current.group, wlanId: config.wlanId } };
    }
    public async getApSsidOverrides(apMac: string, siteId?: string): Promise<unknown> {
        const target = this.path(apMac, siteId);
        const effective = await this.effective(target.path);
        let state: Snapshot | undefined;
        try {
            state = await this.snapshot(target, effective);
        } catch {
            /* Effective reads remain useful without complete preservation evidence. */
        }
        return {
            apMac: target.mac,
            siteId: target.siteId,
            capturedAt: Date.now(),
            configurationSource: state ? 'internal-web-api' : 'unavailable',
            ssidOverrides: effective.entries.map((e, i) => {
                const safe = Object.fromEntries(
                    ['ssidEntryId', 'ssidId', 'ssidName', 'band', 'security', 'vlanEnable', 'vlanId', 'vlanPoolIds', 'ssidEnable']
                        .filter((k) => e[k] !== undefined)
                        .map((k) => [k, e[k]])
                );
                return {
                    ...safe,
                    ...(state ? { configured: redact(state.entries[i]), configurable: state.writable.get(Number(e.ssidEntryId)) } : {}),
                    password: 'redacted',
                };
            }),
            limitations: [
                state
                    ? 'Override state is configured-state evidence, not a guarantee of live AP broadcast or connectivity.'
                    : 'Public effective settings do not establish override flags. Writes require matching internal configuration evidence.',
            ],
        };
    }
    public async updateApSsidOverride(
        apMac: string,
        ssidEntryId: number,
        settings: ApSsidOverrideUpdate,
        siteId?: string,
        dryRun = true
    ): Promise<unknown> {
        const target = this.path(apMac, siteId);
        const id = ssidEntryIdSchema.parse(ssidEntryId);
        const update = apSsidOverrideUpdateSchema.parse(settings);
        if (typeof dryRun !== 'boolean') throw new Error('dryRun must be boolean');
        const before = await this.snapshot(target);
        const index = before.entries.findIndex((e) => e.ssidEntryId === id);
        if (index < 0) throw new Error('SSID entry does not exist on this AP');
        if (!before.writable.get(id)) throw new Error('Controller did not affirm that this SSID is configurable on the AP');
        const desired = before.entries.map((e, i) =>
            normalize(
                i === index ? { ...e, ...Object.fromEntries(Object.entries(update).filter(([, v]) => v !== undefined)) } : e,
                before.effective[i].security
            )
        );
        const normalizedBefore = before.entries.map(canonical);
        if ((update.overrideSsidName !== undefined || update.overrideSsidPassword !== undefined) && !desired[index].overrideSsidEnable)
            throw new Error('Name/password changes require overrideSsidEnable');
        if ((update.vlanId !== undefined || update.vlanPoolIds !== undefined) && !desired[index].overrideVlanEnable)
            throw new Error('VLAN changes require overrideVlanEnable');
        const changes = Object.keys(update)
            .filter((k) => !isDeepStrictEqual(normalizedBefore[index][k as keyof Entry], desired[index][k as keyof Entry]))
            .map((field) => ({
                field,
                before: field === 'overrideSsidPassword' ? '[redacted]' : normalizedBefore[index][field as keyof Entry],
                after: field === 'overrideSsidPassword' ? '[redacted]' : desired[index][field as keyof Entry],
            }));
        const base = {
            apMac: target.mac,
            siteId: target.siteId,
            ssidEntryId: id,
            dryRun,
            changes,
            before: redact(normalizedBefore[index]),
            desired: redact(desired[index]),
            verificationScope: 'configured_ap_ssid_overrides',
        };
        if (isDeepStrictEqual(normalizedBefore, desired)) return { ...base, written: false, verified: true };
        if (dryRun) return { ...base, written: false, verified: false };
        const checked = await this.snapshot(target);
        if (!isDeepStrictEqual(before, checked)) throw new Error('AP override configuration changed during preflight; read and preview again');
        let writeError = false;
        let response: OmadaApiResponse<unknown> | undefined;
        try {
            response = await this.request.request<OmadaApiResponse<unknown>>(
                { method: 'PATCH', url: target.path, data: { ssidOverrides: desired } },
                false
            );
        } catch (error) {
            const status = axios.isAxiosError(error)
                ? error.response?.status
                : Number((error instanceof Error ? error.message : '').match(/HTTP\s+(\d{3})/)?.[1]);
            if (status !== undefined && status >= 400 && status < 500 && status !== 408) throw error;
            writeError = true;
        }
        if (response !== undefined) this.request.ensureSuccess(response);
        const verification = await verifyWrite(
            async () => {
                const observed = await this.snapshot(target);
                return { entries: observed.entries.map((e, i) => normalize(e, observed.effective[i].security)), group: observed.group };
            },
            (observed) =>
                isDeepStrictEqual(verificationEntries(observed.entries), verificationEntries(desired)) &&
                isDeepStrictEqual(observed.group, before.group)
        );
        return {
            ...base,
            written: writeError ? 'unknown' : true,
            verified: verification.status === 'verified',
            verification: { status: verification.status, attempts: verification.attempts },
            ...(writeError ? { acknowledgement: 'unknown' } : {}),
        };
    }
}
