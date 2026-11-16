import { isIP } from 'node:net';
import { z } from 'zod';

const key = z
    .string()
    .refine(
        (value) => /^[A-Za-z0-9+/]{43}=$/.test(value) && Buffer.from(value, 'base64').toString('base64') === value,
        'Expected a 32-byte base64 WireGuard key'
    );
const port = z.number().int().min(1).max(65535);
const cidr = z.string().refine((value) => {
    const [address, prefix, extra] = value.split('/');
    const version = isIP(address);
    return extra === undefined && version !== 0 && /^\d{1,3}$/.test(prefix ?? '') && Number(prefix) <= (version === 4 ? 32 : 128);
}, 'Expected an IPv4 or IPv6 CIDR');
const interfaceSchema = z
    .object({
        name: z.string(),
        status: z.boolean(),
        mtu: z.number().int().min(576).max(1440),
        listenPort: port,
        privateKey: key,
        localIp: z.string().refine((value) => isIP(value) === 4, 'Expected an IPv4 address'),
    })
    .strict();
const peerSchema = z
    .object({
        name: z.string(),
        status: z.boolean(),
        interfaceId: z.string().min(1),
        publicKey: key,
        endPoint: z.string().optional(),
        endPointPort: port.optional(),
        allowAddress: z
            .array(cidr)
            .min(1)
            .max(1000)
            .refine((values) => new Set(values.map((value) => value.toLowerCase())).size === values.length, 'Allowed addresses must be unique'),
        // Require intent explicitly: an omitted or masked stored key must never be copied into a PUT.
        presharedKey: z.union([z.literal(''), key]),
        keepAlive: z.number().int().min(0).max(65535),
        comment: z.string().max(128).optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
        if (Boolean(value.endPoint) !== (value.endPointPort !== undefined))
            ctx.addIssue({ code: 'custom', message: 'Supply endpoint and port together', path: ['endPoint'] });
        if (
            value.endPoint &&
            !isIP(value.endPoint) &&
            (/^[\d.]+$/.test(value.endPoint) ||
                value.endPoint.length > 253 ||
                !value.endPoint.split('.').every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)))
        )
            ctx.addIssue({ code: 'custom', message: 'Expected an IP address or hostname without scheme or port', path: ['endPoint'] });
    });

export function validateWireguard(kind: 'wireguard' | 'wireguard-peer', body: unknown): void {
    (kind === 'wireguard' ? interfaceSchema : peerSchema).parse(body);
}
