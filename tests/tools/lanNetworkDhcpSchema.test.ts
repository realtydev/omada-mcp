import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

import { registerCreateLanNetworkTool } from '../../src/tools/createLanNetwork.js';
import { registerUpdateLanNetworkTool } from '../../src/tools/updateLanNetwork.js';

type Register = typeof registerCreateLanNetworkTool;

function inputSchemaOf(register: Register): z.ZodTypeAny {
    const mockServer = { registerTool: vi.fn() };
    register(mockServer as never, {} as never);
    return mockServer.registerTool.mock.calls[0][1].inputSchema;
}

const network = {
    name: 'Guest Network',
    vlan: 20,
    gatewaySubnet: '192.168.20.1/24',
    purpose: 1,
    igmpSnoopEnable: false,
    interfaceIds: ['2_e144ec2260ca4f3da50e7912b0b9947e'],
};

const baseDhcp = { enable: true, ipRangePool: [{ ipaddrStart: '192.168.20.100', ipaddrEnd: '192.168.20.200' }], leasetime: 1440 };

describe.each([
    ['createLanNetwork', registerCreateLanNetworkTool, {}],
    ['updateLanNetwork', registerUpdateLanNetworkTool, { networkId: 'net-1' }],
] as const)('%s DHCP settings', (_name, register, extra) => {
    const schema = inputSchemaOf(register);
    const parse = (dhcpSettingsVO: Record<string, unknown>) => schema.safeParse({ ...extra, ...network, dhcpSettingsVO });

    it('accepts manual DNS servers', () => {
        const result = parse({ ...baseDhcp, dhcpns: 'manual', priDns: '1.1.1.1', sndDns: '8.8.8.8' });
        expect(result.success).toBe(true);
    });

    it('accepts custom DHCP options typed as string, IP address, or hex', () => {
        const result = parse({
            ...baseDhcp,
            options: [
                { code: 15, type: 0, value: 'office.lan' },
                { code: 42, type: 1, value: '192.168.20.1' },
                { code: 43, type: 2, value: '0104c0a80001' },
            ],
        });
        expect(result.success).toBe(true);
    });

    it('rejects an option type outside 0-2', () => {
        expect(parse({ ...baseDhcp, options: [{ code: 6, type: 'ip', value: '1.1.1.1' }] }).success).toBe(false);
    });

    it('rejects manual DNS without a primary server', () => {
        expect(parse({ ...baseDhcp, dhcpns: 'manual' }).success).toBe(false);
    });
});
