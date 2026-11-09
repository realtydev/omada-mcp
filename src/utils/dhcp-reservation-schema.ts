import { z } from 'zod';

import { isValidIpv4Address } from './config-validations.js';

export const reservationMacSchema = z
    .string()
    .regex(/^[A-Fa-f0-9][02468aAcCeE]([-:][A-Fa-f0-9]{2}){5}$/, 'A unicast MAC address is required, e.g. AA-BB-CC-DD-EE-FF')
    .describe('Unicast client MAC address; colon or hyphen separators are accepted and normalized');

export const dhcpReservationConfigSchema = z
    .object({
        mac: reservationMacSchema,
        netId: z.string().min(1).describe('LAN network ID from getLanNetworkList; the network must be an interface'),
        status: z.boolean().describe('Whether the reservation is enabled'),
        ip: z
            .string()
            .refine(isValidIpv4Address, 'A valid IPv4 address is required')
            .optional()
            .describe('Reserved IPv4 address within the LAN subnet'),
        description: z
            .string()
            .max(128)
            .regex(/^$|^[^ +\-@=]$|^[^ +\-@=].{0,126}[^ ]$/, 'Description must not start with space, +, -, @, or =, or end with a space')
            .optional(),
        options: z
            .array(
                z
                    .object({
                        code: z.number().int().min(1).max(254),
                        type: z.union([z.literal(0), z.literal(1), z.literal(2)]).describe('0 = string, 1 = IP address, 2 = hex array'),
                        value: z.string().min(1),
                    })
                    .strict()
            )
            .optional()
            .describe('Custom DHCP options; support depends on the controller and gateway'),
        confirmConflict: z.boolean().optional().describe('Explicitly confirm an IP/IP-MAC binding conflict only after reviewing it'),
    })
    .strict();

export const dhcpReservationUpdateSchema = dhcpReservationConfigSchema
    .omit({ mac: true })
    .partial()
    .strict()
    .refine((settings) => Object.keys(settings).length > 0, 'At least one reservation setting is required');
