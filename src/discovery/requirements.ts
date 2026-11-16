import { z } from 'zod';
import type { ApiOperation } from './catalog.js';

const ids = z.array(z.string().trim().min(1)).min(1);
const interval = z
    .object({
        updateInterval: z.union([z.literal(0), z.literal(1), z.literal(6), z.literal(12), z.literal(24), z.literal(48), z.literal(72)]).optional(),
        customInterval: z.number().int().min(1).max(60).optional(),
    })
    .loose()
    .refine((v) => (v.updateInterval !== undefined) !== (v.customInterval !== undefined), 'Choose exactly one DDNS interval');
const ddns = z
    .object({ service: z.number().int().min(0).max(5), interval: interval.optional() })
    .loose()
    .superRefine((v, ctx) => {
        if (v.service !== 5 && !v.interval) ctx.addIssue({ code: 'custom', path: ['interval'], message: 'This service requires an interval' });
        if ((v.service === 2 || v.service === 3) && v.interval?.customInterval !== undefined)
            ctx.addIssue({ code: 'custom', path: ['interval'], message: 'This service requires updateInterval' });
    });
const lanDns = z
    .object({
        type: z.number().int().min(0).max(2),
        lanNetworkIds: ids,
        ipAddresses: z.array(z.string()).optional(),
        ipv6Addresses: z.array(z.string()).optional(),
        cname: z.string().min(1).optional(),
        dnsServers: ids.max(2).optional(),
    })
    .loose()
    .superRefine((v, ctx) => {
        if (v.type === 0 && !(v.ipAddresses?.length || v.ipv6Addresses?.length))
            ctx.addIssue({ code: 'custom', path: ['ipAddresses'], message: 'IP records require an IPv4 or IPv6 address' });
        if (v.type === 1 && !v.cname) ctx.addIssue({ code: 'custom', path: ['cname'], message: 'CNAME records require a target' });
        if (v.type === 2 && !v.dnsServers?.length)
            ctx.addIssue({ code: 'custom', path: ['dnsServers'], message: 'Forward records require a DNS server' });
    });
const rateLimit = z
    .object({
        mode: z.union([z.literal(0), z.literal(1)]),
        customRateLimit: z.object({}).loose().optional(),
        rateLimitProfileId: z.string().min(1).optional(),
    })
    .loose()
    .superRefine((v, ctx) => {
        if (
            (v.mode === 0 && (!v.customRateLimit || v.rateLimitProfileId !== undefined)) ||
            (v.mode === 1 && (!v.rateLimitProfileId || v.customRateLimit !== undefined))
        )
            ctx.addIssue({ code: 'custom', message: 'Provide only the rate-limit source selected by mode' });
    });
const powerSaving = z
    .object({
        timeEnable: z.boolean(),
        bandEnable: z.boolean(),
        startTimeH: z.number().int().min(0).max(23).optional(),
        startTimeM: z.number().int().min(0).max(59).optional(),
        endTimeH: z.number().int().min(0).max(23).optional(),
        endTimeM: z.number().int().min(0).max(59).optional(),
        bands: z.array(z.number().int()).min(1).optional(),
        idleDuration: z.number().int().min(60).max(1440).optional(),
    })
    .loose()
    .superRefine((v, ctx) => {
        for (const field of ['startTimeH', 'startTimeM', 'endTimeH', 'endTimeM'] as const)
            if (v.timeEnable && v[field] === undefined) ctx.addIssue({ code: 'custom', path: [field], message: 'Required when timeEnable is true' });
        for (const field of ['bands', 'idleDuration'] as const)
            if (v.bandEnable && v[field] === undefined) ctx.addIssue({ code: 'custom', path: [field], message: 'Required when bandEnable is true' });
    });

/** Explicit contracts supplement vendor JSON; prose is never parsed into executable rules. */
export function validateWriteRequirements(operation: ApiOperation, body: unknown): void {
    const route = operation.path.replace(/^\/openapi\/v1\/\{omadacId\}\/sites\/\{siteId\}/, '');
    let schema: z.ZodType | undefined;
    if (['POST', 'PATCH'].includes(operation.method) && /^\/setting\/service\/ddns(?:\/\{ddnsId\})?$/.test(route)) schema = ddns;
    if (['POST', 'PATCH'].includes(operation.method) && /^\/setting\/lan\/dns(?:\/\{dnsId\})?$/.test(route)) schema = lanDns;
    if (operation.method === 'PATCH' && route === '/lan-profiles/{profileId}')
        schema = z.object({ untagNetworkIds: z.array(z.string().min(1)) }).loose();
    if (operation.method === 'POST' && route === '/hotspot/voucher-groups') schema = z.object({ rateLimit }).loose();
    if (operation.method === 'PUT' && route === '/aps/{apMac}/power-saving') schema = powerSaving;
    if (!schema) return;
    const result = schema.safeParse(body);
    if (!result.success)
        throw new Error(
            `Invalid documented write requirements: ${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`
        );
}
