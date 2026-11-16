import { describe, expect, it } from 'vitest';
import { MAX_POE_PORTS, MAX_POE_SWITCHES, parsePoeUsage } from '../../src/omadaClient/poeUsage.js';

const MAC = 'AA-BB-CC-DD-EE-01';
const powered = () => ({
    mac: MAC,
    portNum: 2,
    totalPower: 80,
    totalPowerUsed: 0,
    totalPercentUsed: 0,
    poePorts: [{ portId: 1, poeSupported: true, poeEnabled: true, poePower: 0, poePercent: 0 }],
});

describe('bounded dashboard PoE evidence', () => {
    it('preserves true zeroes and derives headroom only from a positive reported watt budget', () => {
        const result = parsePoeUsage([powered()]);
        expect(result).toMatchObject({
            truncated: false,
            partial: false,
            switches: [
                {
                    mac: MAC,
                    status: 'complete',
                    totalPowerUsed: 0,
                    totalPercentUsed: 0,
                    headroomWatts: 80,
                    poePorts: [
                        {
                            portId: 1,
                            poeSupported: true,
                            poeEnabled: true,
                            poePower: 0,
                            poePercent: 0,
                            status: 'complete',
                            source: 'dashboard-poe-usage',
                        },
                    ],
                },
            ],
        });
    });
    it('does not invent zero consumption for disabled or unreported ports', () => {
        const result = parsePoeUsage([{ ...powered(), poePorts: [{ portId: 2, poeSupported: true, poeEnabled: false }] }]);
        expect(result.partial).toBe(true);
        const port = result.switches[0].poePorts[0];
        expect(port).toMatchObject({ status: 'partial', missingFields: ['poePower', 'poePercent'], poeEnabled: false });
        expect(port).not.toHaveProperty('poePower');
        expect(port).not.toHaveProperty('poePercent');
        expect(result.switches[0].headroomWatts).toBe(80);
    });
    it('keeps explicit non-PoE switches without manufacturing switch or port power', () => {
        const result = parsePoeUsage([{ mac: MAC, portNum: 10, poePorts: [{ portId: 1, poeSupported: false, poePower: -1, poePercent: 0 }] }]);
        expect(result.switches[0]).toMatchObject({
            status: 'unsupported',
            supported: false,
            poePorts: [{ status: 'unsupported', poeSupported: false }],
        });
        expect(result.switches[0]).not.toHaveProperty('totalPower');
        expect(result.switches[0]).not.toHaveProperty('headroomWatts');
        expect(result.switches[0].poePorts[0]).not.toHaveProperty('poePower');
    });
    it.each([undefined, null, -1, Number.NaN, Number.POSITIVE_INFINITY, '1'])(
        'marks invalid or absent power %j as missing rather than zero',
        (power) => {
            const row = powered();
            const result = parsePoeUsage([{ ...row, totalPower: power, poePorts: [{ ...row.poePorts[0], poePower: power }] }]);
            expect(result.partial).toBe(true);
            expect(result.switches[0]).not.toHaveProperty('totalPower');
            expect(result.switches[0]).not.toHaveProperty('headroomWatts');
            expect(result.switches[0].poePorts[0]).not.toHaveProperty('poePower');
        }
    );
    it('preserves fractional port percentages separately from switch budget percentages', () => {
        const row = powered();
        const result = parsePoeUsage([{ ...row, totalPercentUsed: 8.31, poePorts: [{ ...row.poePorts[0], poePercent: 43.2 }] }]);
        expect(result.switches[0].totalPercentUsed).toBe(8.31);
        expect(result.switches[0].poePorts[0].poePercent).toBe(43.2);
    });
    it.each([-1, 101, Number.NaN])('excludes invalid percentage %j', (percent) => {
        const row = powered();
        const result = parsePoeUsage([{ ...row, totalPercentUsed: percent, poePorts: [{ ...row.poePorts[0], poePercent: percent }] }]);
        expect(result.switches[0]).not.toHaveProperty('totalPercentUsed');
        expect(result.switches[0].poePorts[0]).not.toHaveProperty('poePercent');
    });
    it('does not turn absent or empty port detail into a complete PoE report', () => {
        for (const poePorts of [undefined, []]) {
            const result = parsePoeUsage([{ ...powered(), poePorts }]);
            expect(result.partial).toBe(true);
            expect(result.switches[0].missingFields).toContain('poePorts');
            expect(result.switches[0].poePorts).toEqual([]);
            expect(result.switches[0]).not.toHaveProperty('supported');
        }
    });
    it('does not derive headroom from a zero or missing power budget', () => {
        expect(parsePoeUsage([{ ...powered(), totalPower: 0 }]).switches[0]).not.toHaveProperty('headroomWatts');
        const { totalPower: _, ...row } = powered();
        expect(parsePoeUsage([row]).switches[0]).not.toHaveProperty('headroomWatts');
    });
    it('drops every duplicate port identity and refuses duplicate switch identities', () => {
        const row = powered();
        const duplicate = parsePoeUsage([
            { ...row, poePorts: [row.poePorts[0], { ...row.poePorts[0], poePower: 15 }, { portId: 2, poeSupported: false }] },
        ]);
        expect(duplicate.switches[0].poePorts.map((port) => port.portId)).toEqual([2]);
        expect(duplicate.switches[0].missingFields).toContain('duplicate_port_identity');
        expect(() => parsePoeUsage([row, { ...row, mac: MAC.replaceAll('-', ':').toLowerCase() }])).toThrow('duplicate PoE switch');
    });
    it.each([undefined, null, {}, [{ totalPower: 0 }], [{ mac: '../invalid' }]])('refuses malformed endpoint/switch evidence %j', (value) => {
        expect(() => parsePoeUsage(value)).toThrow();
    });
    it('requires owned switch identities and does not accept inherited readings as controller evidence', () => {
        expect(() => parsePoeUsage([Object.create(powered())])).toThrow('switch identity');
        const result = parsePoeUsage([
            {
                ...powered(),
                poePorts: [Object.assign(Object.create({ poeSupported: false, poeEnabled: false, poePower: 0, poePercent: 0 }), { portId: 1 })],
            },
        ]);
        expect(result.switches[0].poePorts[0]).toMatchObject({
            status: 'partial',
            missingFields: ['poeSupported', 'poeEnabled', 'poePower', 'poePercent'],
        });
        expect(result.switches[0].poePorts[0]).not.toHaveProperty('poeSupported');
    });
    it('bounds switches and ports and does not use the reported count as inventory authority', () => {
        const switches = Array.from({ length: MAX_POE_SWITCHES + 1 }, (_, i) => ({
            ...powered(),
            mac: `AA-BB-CC-DD-00-${i.toString(16).padStart(2, '0')}`,
        }));
        expect(parsePoeUsage(switches)).toMatchObject({ truncated: true, partial: true });
        expect(parsePoeUsage(switches).switches).toHaveLength(MAX_POE_SWITCHES);
        const result = parsePoeUsage([
            { ...powered(), portNum: 1, poePorts: Array.from({ length: MAX_POE_PORTS + 1 }, (_, i) => ({ portId: i + 1, poeSupported: false })) },
        ]);
        expect(result).toMatchObject({ truncated: true, partial: true });
        expect(result.switches[0].portNum).toBe(1);
        expect(result.switches[0].poePorts).toHaveLength(MAX_POE_PORTS);
    });
});
