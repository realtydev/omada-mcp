import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { isValidHostname, isValidIpAddress, isValidIpv4Address, isValidIpv6Address } from './config-validations.js';

export const dnsChangeIdentifierSchema = z
    .string()
    .min(1)
    .max(256)
    .regex(/^[^/\\%?#\s]+$/)
    .refine((v) => v !== '.' && v !== '..');
export const dnsIpv4Schema = z.string().max(15).refine(isValidIpv4Address, 'Expected an IPv4 address');
export const dnsIpv6Schema = z
    .string()
    .max(45)
    .refine((v) => !v.includes('%') && isValidIpv6Address(v), 'Expected an IPv6 address');
export const dnsServerSchema = z
    .string()
    .max(45)
    .refine((v) => !v.includes('%') && isValidIpAddress(v), 'Expected a DNS server IPv4 or IPv6 address');
export const dnsNameSchema = z
    .string()
    .min(1)
    .max(253)
    .refine((value) => {
        const normalized = value.endsWith('.') ? value.slice(0, -1) : value;
        return normalized.includes('.') && isValidHostname(normalized);
    }, 'Expected a fully qualified DNS name');
export const lanDnsConfigSchema = z
    .object({
        enable: z.boolean(),
        name: z.string().min(1).max(128),
        domain: dnsNameSchema,
        type: z.number().int().min(0).max(2),
        aliases: z.array(dnsNameSchema).max(7).optional(),
        ipAddresses: z.array(dnsIpv4Schema).max(32).optional(),
        ipv6Addresses: z.array(dnsIpv6Schema).max(32).optional(),
        cname: dnsNameSchema.or(z.literal('')).optional(),
        dnsServers: z.array(dnsServerSchema).max(2).optional(),
        lanNetworkIds: z.array(dnsChangeIdentifierSchema).min(1).max(1000).optional(),
        customTtl: z.boolean().optional(),
        ttl: z.number().int().min(1).max(86400).optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
        if (value.type === 2 && value.lanNetworkIds !== undefined)
            ctx.addIssue({ code: 'custom', path: ['lanNetworkIds'], message: 'Forward DNS does not support a LAN selection' });
        if (value.type !== 2 && !value.lanNetworkIds?.length)
            ctx.addIssue({ code: 'custom', path: ['lanNetworkIds'], message: 'IP and CNAME DNS require a LAN selection' });
    });
const ids = z
    .array(dnsChangeIdentifierSchema)
    .min(1)
    .max(1000)
    .refine((v) => new Set(v).size === v.length, 'Duplicate IDs are not allowed');
const vlan = z
    .string()
    .regex(/^[1-9]\d{0,3}$/)
    .refine((v) => Number(v) <= 4094, 'VLAN must be 1–4094');
const vlanList = z
    .string()
    .min(1)
    .max(8192)
    .refine((value) => {
        const intervals = value.split(',').map((part) => part.split('-'));
        if (intervals.some((range) => range.length > 2 || range.some((x) => !vlan.safeParse(x).success))) return false;
        const pairs = intervals.map((range) => [Number(range[0]), Number(range[1] ?? range[0])]).sort((a, b) => a[0] - b[0]);
        return pairs.every(([start, end], index) => start <= end && (index === 0 || start > pairs[index - 1][1]));
    }, 'Client VLANs must be distinct, nonoverlapping comma-separated VLANs or increasing ranges within 1–4094');
export const mdnsConfigFieldsSchema = z
    .object({
        name: z.string().min(1).max(64),
        status: z.boolean(),
        profileIds: ids.max(256),
        type: z.union([z.literal(0), z.literal(1)]),
        ap: z.object({ serviceVlan: vlan, clientVlan: vlanList }).strict().optional(),
        osg: z.object({ serviceNetworks: ids, clientNetworks: ids }).strict().optional(),
    })
    .strict();
export const mdnsConfigSchema = mdnsConfigFieldsSchema.superRefine((v, ctx) => {
    if (v.type === 0 && !v.ap) ctx.addIssue({ code: 'custom', path: ['ap'], message: 'VLAN rules require AP configuration' });
    if (v.type === 1 && !v.osg) ctx.addIssue({ code: 'custom', path: ['osg'], message: 'Network rules require gateway configuration' });
});
const scope = {
    version: z.literal(1),
    controllerId: dnsChangeIdentifierSchema,
    siteId: dnsChangeIdentifierSchema,
    beforeId: dnsChangeIdentifierSchema.nullable(),
    appliedId: dnsChangeIdentifierSchema.nullable(),
};
// Field presence must survive a preserving PATCH; omitted optional fields cannot be removed reliably.
export function sameDnsShape(left: unknown, right: unknown): boolean {
    if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right);
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return typeof left === typeof right;
    const a = left as Record<string, unknown>,
        b = right as Record<string, unknown>;
    const keys = Object.keys(a)
        .filter((k) => a[k] !== undefined)
        .sort();
    return (
        isDeepStrictEqual(
            keys,
            Object.keys(b)
                .filter((k) => b[k] !== undefined)
                .sort()
        ) && keys.every((k) => sameDnsShape(a[k], b[k]))
    );
}
function validReceipt(value: { before: unknown; applied: unknown; beforeId: string | null; appliedId: string | null }, ctx: z.RefinementCtx) {
    if ((value.before === null) !== (value.beforeId === null) || (value.applied === null) !== (value.appliedId === null))
        ctx.addIssue({ code: 'custom', message: 'DNS row identity must match presence' });
    if (value.before === null && value.applied === null) ctx.addIssue({ code: 'custom', message: 'Receipt must describe a change' });
    if (value.before !== null && value.applied !== null && (value.beforeId !== value.appliedId || !sameDnsShape(value.before, value.applied)))
        ctx.addIssue({ code: 'custom', message: 'DNS updates require stable identity and field presence' });
}
const lanDnsChangeConfigSchema = lanDnsConfigSchema.superRefine((value, ctx) => {
    if (value.type === 0 && !(value.ipAddresses?.length || value.ipv6Addresses?.length))
        ctx.addIssue({ code: 'custom', message: 'IP records require an address' });
    if (value.type === 1 && !value.cname) ctx.addIssue({ code: 'custom', message: 'CNAME records require a target' });
    if (value.type === 2 && !value.dnsServers?.length) ctx.addIssue({ code: 'custom', message: 'Forward records require a DNS server' });
    if (value.customTtl === true && value.ttl === undefined) ctx.addIssue({ code: 'custom', message: 'Custom TTL must be reported' });
});
export const lanDnsChangeReceiptSchema = z
    .object({ ...scope, resource: z.literal('lan-dns'), before: lanDnsChangeConfigSchema.nullable(), applied: lanDnsChangeConfigSchema.nullable() })
    .strict()
    .superRefine(validReceipt)
    .superRefine((value, ctx) => {
        if (value.before && value.applied && value.before.type !== value.applied.type)
            ctx.addIssue({ code: 'custom', message: 'LAN DNS receipts cannot restore record-type transitions' });
    });
export const mdnsChangeReceiptSchema = z
    .object({ ...scope, resource: z.literal('mdns-rule'), before: mdnsConfigSchema.nullable(), applied: mdnsConfigSchema.nullable() })
    .strict()
    .superRefine(validReceipt);
export const dnsChangeReceiptSchema = z.discriminatedUnion('resource', [lanDnsChangeReceiptSchema, mdnsChangeReceiptSchema]);
export type DnsChangeReceipt = z.infer<typeof dnsChangeReceiptSchema>;
export interface DnsWriteScope {
    controllerId: string;
    siteId: string;
}
export interface DnsWriteSafety {
    scope?: DnsWriteScope;
    expected?: { id: string; config: Record<string, unknown> };
}
export function dnsChangeReceipt(
    resource: DnsChangeReceipt['resource'],
    scope: DnsWriteScope | undefined,
    before: Record<string, unknown> | undefined,
    applied: Record<string, unknown> | undefined
): DnsChangeReceipt | undefined {
    if (!scope) return undefined;
    const config = (row: Record<string, unknown> | undefined) => (row ? Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'id')) : null);
    const candidate = dnsChangeReceiptSchema.safeParse({
        ...scope,
        version: 1,
        resource,
        before: config(before),
        applied: config(applied),
        beforeId: before?.id ?? null,
        appliedId: applied?.id ?? null,
    });
    return candidate.success ? candidate.data : undefined;
}

function canonicalDns(value: unknown, field = ''): unknown {
    if (Array.isArray(value)) return value.map((v) => canonicalDns(v, field)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (value && typeof value === 'object')
        return Object.fromEntries(
            Object.entries(value)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, v]) => [k, canonicalDns(v, k)])
        );
    if (typeof value === 'string' && ['domain', 'cname', 'aliases'].includes(field)) return value.toLowerCase().replace(/\.$/, '');
    return value;
}
export function sameDnsConfig(left: unknown, right: unknown): boolean {
    return isDeepStrictEqual(canonicalDns(left), canonicalDns(right));
}
