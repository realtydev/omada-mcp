import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SwitchPortReadOperations } from '../../src/omadaClient/switchPortRead.js';

const A = 'AA-BB-CC-DD-EE-01',
    B = 'AA-BB-CC-DD-EE-02';
const config = (mac: string) => ({
    mac,
    portList: [
        { port: 1, name: 'Uplink', status: 1 },
        { port: 2, name: 'Spare', status: 1 },
    ],
});
const web = (mac: string) => ({
    mac,
    ports: [
        {
            port: 1,
            name: 'Uplink',
            disable: false,
            portStatus: { port: 1, linkStatus: 1, linkSpeed: 4, duplex: 2, rx: 10, tx: 20 },
            portSpeedCap: [{ linkSpeed: { name: '2.5G', value: 4 } }],
        },
        {
            port: 2,
            name: 'Spare',
            disable: false,
            portStatus: { port: 2, linkStatus: 0, linkSpeed: 1, duplex: 2 },
            portSpeedCap: [{ linkSpeed: { name: '10M', value: 1 } }],
        },
    ],
});
describe('managed switch port coverage', () => {
    let request: { fetchPaginated: ReturnType<typeof vi.fn> };
    let inventory: { listDevices: ReturnType<typeof vi.fn> };
    let detail: { getSwitch: ReturnType<typeof vi.fn> };
    let internal: { get: ReturnType<typeof vi.fn>; ensureSuccess: ReturnType<typeof vi.fn> };
    let ops: SwitchPortReadOperations;
    beforeEach(() => {
        request = {
            fetchPaginated: vi.fn().mockResolvedValue([
                {
                    switchMac: A,
                    port: 1,
                    portName: 'Uplink',
                    supportPoe: true,
                    connectedStatus: 1,
                    portStatus: { port: 1, linkStatus: 1, linkSpeed: 4, duplex: 2 },
                },
            ]),
        };
        inventory = {
            listDevices: vi.fn().mockResolvedValue([
                { mac: A, name: 'PoE', type: 'switch' },
                { mac: B, name: 'Office non-PoE', type: 'switch' },
                { mac: 'AP', type: 'ap' },
            ]),
        };
        detail = { getSwitch: vi.fn(async (mac) => config(mac)) };
        internal = { get: vi.fn(async (path) => ({ errorCode: 0, result: web(path.split('/').at(-1)) })), ensureSuccess: vi.fn((r) => r.result) };
        ops = new SwitchPortReadOperations(
            request as never,
            { resolveSiteId: (id?: string) => id ?? 'site' } as never,
            (p) => `/openapi/v1/controller${p}`,
            inventory as never,
            detail as never
        );
        ops.setInternalRequest(internal as never);
    });
    it('returns every configured port including non-PoE telemetry; merges sources by physical identity', async () => {
        const r = await ops.getSwitchPortOverview();
        expect(r.collectionComplete).toBe(true);
        expect(r.ports).toHaveLength(4);
        expect(r.switches).toEqual([
            expect.objectContaining({ switchMac: A, status: 'complete', knownPorts: 2, telemetryPorts: 2 }),
            expect.objectContaining({ switchMac: B, status: 'complete', knownPorts: 2, telemetryPorts: 2 }),
        ]);
        expect(r.ports.find((p) => p.switchMac === B && p.port === 1)).toMatchObject({
            operational: { status: 'available', linkUp: true, negotiatedSpeedMbps: 2500, source: 'internal-web-api' },
        });
        expect(r.ports[0]).toMatchObject({ connectedStatus: 1, supportPoe: true, evidence: { telemetrySource: 'open-api-poe-info' } });
        expect(inventory.listDevices).toHaveBeenCalledWith('site', { maxRecords: 1000 });
    });
    it('keeps the legacy array result and distinguishes configured enablement from a down link', async () => {
        const ports = await ops.listSwitchPorts('aabbccddee02');
        expect(ports).toHaveLength(2);
        expect(ports[1]).toMatchObject({ configured: { status: 1, disable: false }, operational: { linkUp: false, status: 'available' } });
        expect(ports[1].operational as object).not.toHaveProperty('negotiatedSpeedMbps');
        expect(detail.getSwitch).toHaveBeenCalledTimes(1);
        expect(internal.get).toHaveBeenCalledExactlyOnceWith(`/sites/site/switches/${B}`);
    });
    it('uses configuration-only rows when web credentials are absent without inventing link state', async () => {
        const bare = new SwitchPortReadOperations(
            request as never,
            { resolveSiteId: () => 'site' } as never,
            (p) => p,
            inventory as never,
            detail as never
        );
        const r = await bare.getSwitchPortOverview();
        expect(r.collectionComplete).toBe(false);
        expect(r.ports).toHaveLength(4);
        expect(r.ports.find((p) => p.switchMac === B && p.port === 1)).toMatchObject({
            operational: { status: 'unavailable', source: 'unavailable' },
        });
        expect(r.ports.find((p) => p.switchMac === B && p.port === 1)).not.toHaveProperty('portStatus');
        expect(await bare.listSwitchPorts(B)).toHaveLength(2);
    });
    it('supports web-only/Agile inventories when the public detail or PoE endpoint is unsupported', async () => {
        detail.getSwitch.mockRejectedValue(Object.assign(new Error('private error'), { status: 404 }));
        request.fetchPaginated.mockRejectedValue(Object.assign(new Error('private error'), { status: 404 }));
        const r = await ops.getSwitchPortOverview();
        expect(r.collectionComplete).toBe(true);
        expect(r.ports).toHaveLength(4);
        expect(r.switches[0].sources).toMatchObject({ configuration: 'unsupported', poe: 'unsupported', internal: 'ok' });
        expect(JSON.stringify(r)).not.toContain('private error');
    });
    it('retains primary-only Agile rows while reporting unestablished inventory', async () => {
        detail.getSwitch.mockRejectedValue(new Error('unsupported'));
        internal.get.mockRejectedValue(new Error('unsupported'));
        const r = await ops.getSwitchPortOverview();
        expect(r.ports).toHaveLength(1);
        expect(r.collectionComplete).toBe(false);
        await expect(ops.listSwitchPorts()).rejects.toThrow('getSwitchPortOverview');
    });
    it('does not infer a complete site from a successful primary endpoint when inventory fails', async () => {
        inventory.listDevices.mockRejectedValue(Object.assign(new Error('private'), { status: 403 }));
        const r = await ops.getSwitchPortOverview();
        expect(r.inventoryStatus).toBe('forbidden');
        expect(r.collectionComplete).toBe(false);
        expect(r.ports).toHaveLength(2);
        await expect(ops.listSwitchPorts()).rejects.toThrow('incomplete');
    });
    it.each(['duplicate', 'mismatched-mac', 'missing-ports', 'oversized'])('rejects malformed web evidence: %s', async (mode) => {
        internal.get.mockImplementation((path) => {
            const v = web(path.split('/').at(-1));
            if (mode === 'duplicate') v.ports.push(v.ports[0]);
            if (mode === 'mismatched-mac') v.mac = '11-22-33-44-55-66';
            if (mode === 'missing-ports') Object.assign(v, { ports: undefined });
            if (mode === 'oversized') v.ports = Array.from({ length: 513 }, (_, i) => ({ ...v.ports[0], port: i + 1 }));
            return Promise.resolve({ errorCode: 0, result: v });
        });
        const r = await ops.getSwitchPortOverview();
        expect(r.collectionComplete).toBe(false);
        expect(r.switches[1].sources.internal).toBe('unknown');
        expect(r.ports).toHaveLength(4);
    });
    it('exposes mismatching source inventories and refuses a silently incomplete legacy array', async () => {
        detail.getSwitch.mockImplementation(async (mac) => ({ mac, portList: [{ port: 1 }] }));
        const r = await ops.getSwitchPortOverview();
        expect(r.ports).toHaveLength(4);
        expect(r.collectionComplete).toBe(false);
        await expect(ops.listSwitchPorts()).rejects.toThrow('incomplete');
    });
    it('rejects primary duplicates and wrong standard identities instead of guessing', async () => {
        request.fetchPaginated.mockResolvedValue([
            { switchMac: A, port: 1 },
            { switchMac: A, port: 1 },
        ]);
        expect((await ops.getSwitchPortOverview()).collectionComplete).toBe(false);
        request.fetchPaginated.mockResolvedValue([{ switchMac: A, port: 1, oswStandPort: { unit: 1, slot: 0, port: 2 } }]);
        expect((await ops.getSwitchPortOverview()).switches[0].sources.poe).toBe('unknown');
    });
    it('keeps stack unit/slot identities distinct', async () => {
        request.fetchPaginated.mockResolvedValue([]);
        detail.getSwitch.mockImplementation(async (mac) => ({
            mac,
            portList: [
                { port: 1, standardPort: { unit: 1, slot: 0, port: 1 } },
                { port: 1, standardPort: { unit: 2, slot: 0, port: 1 } },
            ],
        }));
        internal.get.mockImplementation(async (path) => ({
            errorCode: 0,
            result: {
                mac: path.split('/').at(-1),
                ports: [
                    { port: 1, standardPort: { unit: 1, slot: 0, port: 1 }, portStatus: { linkStatus: 1 } },
                    { port: 1, standardPort: { unit: 2, slot: 0, port: 1 }, portStatus: { linkStatus: 0 } },
                ],
            },
        }));
        const r = await ops.getSwitchPortOverview(B);
        expect(r.ports).toHaveLength(2);
        expect(r.collectionComplete).toBe(true);
        expect(r.ports.map((p) => p.standardPort)).toEqual([
            { unit: 1, slot: 0, port: 1 },
            { unit: 2, slot: 0, port: 1 },
        ]);
    });
    it('does not convert unknown speed codes or return unselected internal configuration', async () => {
        request.fetchPaginated.mockResolvedValue([]);
        internal.get.mockImplementation(async (path) => ({
            errorCode: 0,
            result: {
                ...web(path.split('/').at(-1)),
                password: 'secret',
                ports: web(path.split('/').at(-1)).ports.map((p) => ({
                    ...p,
                    password: 'secret',
                    name: { password: 'secret' },
                    portStatus: { ...p.portStatus, linkSpeed: 999, password: 'secret' },
                })),
            },
        }));
        const r = await ops.getSwitchPortOverview(B);
        expect(JSON.stringify(r)).not.toContain('secret');
        expect(r.ports[0].operational).not.toHaveProperty('negotiatedSpeedMbps');
    });
    it('reports no managed switches as a complete empty inventory and validates filter MACs before reads', async () => {
        inventory.listDevices.mockResolvedValue([]);
        request.fetchPaginated.mockResolvedValue([]);
        expect(await ops.getSwitchPortOverview()).toMatchObject({ collectionComplete: true, ports: [], switches: [] });
        inventory.listDevices.mockClear();
        await expect(ops.getSwitchPortOverview('../invalid')).rejects.toThrow();
        expect(inventory.listDevices).not.toHaveBeenCalled();
    });
    it('bounds managed switch collection and reports truncation', async () => {
        inventory.listDevices.mockResolvedValue(
            Array.from({ length: 65 }, (_, i) => ({ type: 'switch', mac: `AA-BB-CC-DD-00-${i.toString(16).padStart(2, '0')}` }))
        );
        request.fetchPaginated.mockResolvedValue([]);
        const r = await ops.getSwitchPortOverview();
        expect(r.switches).toHaveLength(64);
        expect(r.inventoryTruncated).toBe(true);
        expect(r.collectionComplete).toBe(false);
    });
});
