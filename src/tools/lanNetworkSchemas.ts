import { z } from 'zod';

const dhcpRangeSchema = z.object({
    ipaddrStart: z.string().min(1).describe('DHCP range start IP (e.g. "192.168.10.100")'),
    ipaddrEnd: z.string().min(1).describe('DHCP range end IP (e.g. "192.168.10.200")'),
});

const dhcpOptionSchema = z
    .object({
        code: z.number().int().min(1).max(254).describe('DHCP option code (e.g. 15 = domain name, 42 = NTP servers, 43 = vendor-specific)'),
        type: z.union([z.literal(0), z.literal(1), z.literal(2)]).describe('Value type: 0 = string, 1 = IP address, 2 = hex array'),
        value: z.string().min(1).describe('Option value'),
    })
    .strict();

/** DHCP server settings shared by createLanNetwork and updateLanNetwork (Open API DhcpSettingConfig). */
export const dhcpSettingsSchema = z
    .object({
        enable: z.boolean().describe('Whether DHCP is enabled'),
        ipRangePool: z.array(dhcpRangeSchema).describe('DHCP address ranges'),
        leasetime: z.number().int().describe('DHCP lease time in minutes (2-10080)'),
        dhcpns: z.enum(['auto', 'manual']).optional().describe('DNS servers handed to clients: "auto" uses the gateway, "manual" uses priDns/sndDns'),
        priDns: z.string().min(1).optional().describe('Primary DNS server when dhcpns is "manual" (e.g. "1.1.1.1")'),
        sndDns: z.string().min(1).optional().describe('Secondary DNS server when dhcpns is "manual"'),
        gateway: z.string().min(1).optional().describe('Override the default gateway handed to clients'),
        options: z.array(dhcpOptionSchema).optional().describe('Custom DHCP options'),
    })
    .strict()
    .refine((dhcp) => dhcp.dhcpns !== 'manual' || Boolean(dhcp.priDns), {
        message: 'priDns is required when dhcpns is "manual"',
        path: ['priDns'],
    });
