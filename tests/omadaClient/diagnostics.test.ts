import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DiagnosticsClient, DiagnosticsOperations } from '../../src/omadaClient/diagnostics.js';

const NOW = 1_800_000_000_000;
const MAC = 'DD-DD-DD-DD-DD-DD';
const AP = 'CC-CC-CC-CC-CC-CC';
const SWITCH = 'BB-BB-BB-BB-BB-BB';
const GATEWAY = 'AA-AA-AA-AA-AA-AA';
function sources() {
    return {
        listClients: vi.fn().mockResolvedValue([{ mac: 'dd:dd:dd:dd:dd:dd', apMac: AP, wireless: true }]),
        listDevices: vi.fn().mockResolvedValue([{ mac: AP, type: 'ap', model: 'EAP773', status: 'connected' }]),
        getSiteTopology: vi.fn().mockResolvedValue({
            lastUpdateTime: NOW / 1000,
            topologyArray: [
                {
                    mac: GATEWAY,
                    type: 'gateway',
                    successors: [
                        {
                            mac: SWITCH,
                            type: 'switch',
                            successors: [{ mac: AP, type: 'ap', wireUpLink: { linkSpeed: 2500, duplex: 1, upLinkPort: { port: 8 } } }],
                        },
                    ],
                },
            ],
        }),
        getClientHistory: vi.fn().mockResolvedValue({ clientMac: MAC, sessions: [], roams: [] }),
        listEvents: vi.fn().mockResolvedValue({ data: [], totalRows: 0 }),
        listAlerts: vi.fn().mockResolvedValue({ data: [], totalRows: 0 }),
    } satisfies DiagnosticsClient;
}

describe('DiagnosticsOperations', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
    });
    afterEach(() => vi.useRealTimers());

    it('correlates an exact MAC across formats and traces its attachment to the controller root', async () => {
        const client = sources();
        const result = await new DiagnosticsOperations(client).diagnoseClient(MAC, 'site-1');
        expect(result.collectionComplete).toBe(true);
        expect(result.pathComplete).toBe(true);
        expect(result.path.nodes.map((node) => node.mac)).toEqual(['dd:dd:dd:dd:dd:dd', AP, SWITCH, GATEWAY]);
        expect(result.path.nodes[1]).toMatchObject({ model: 'EAP773', wireUpLink: { linkSpeed: 2500, duplex: 1, upLinkPort: { port: 8 } } });
        expect(result.path).toMatchObject({ direction: 'client_to_root', scope: 'controller_discovery', topologyUpdatedAt: NOW, staleness: 'fresh' });
        expect(client.getClientHistory).toHaveBeenCalledWith({
            clientMac: MAC,
            siteId: 'site-1',
            timeStart: NOW - 86_400_000,
            timeEnd: NOW,
            roamTimeline: true,
        });
    });

    it('uses a wired attachment rather than a stale AP field', async () => {
        const client = sources();
        client.listClients.mockResolvedValue([{ mac: MAC, wireless: false, connectDevType: 'switch', switchMac: SWITCH, apMac: AP, port: 2 }]);
        const result = await new DiagnosticsOperations(client).diagnoseClient(MAC);
        expect(result.path.nodes.map((node) => node.mac)).toEqual([MAC, SWITCH, GATEWAY]);
        expect(result.path.nodes[0].wireUpLink).toEqual({ upLinkPort: 2 });
    });

    it('reports a disconnected or absent client without treating history as current attachment evidence', async () => {
        const client = sources();
        client.listClients.mockResolvedValue([{ mac: 'EE-EE-EE-EE-EE-EE', apMac: AP }]);
        const result = await new DiagnosticsOperations(client).diagnoseClient(MAC);
        expect(result.sections.client.status).toBe('not_found');
        expect(result.sections.history.status).toBe('ok');
        expect(result.pathComplete).toBe(false);
        expect(result.collectionComplete).toBe(false);
        expect(result.path.nodes).toEqual([]);
    });

    it('preserves successful sections when topology and history fail', async () => {
        const client = sources();
        client.getSiteTopology.mockRejectedValue(new Error('Web credentials missing'));
        client.getClientHistory.mockRejectedValue(new Error('History unavailable'));
        const result = await new DiagnosticsOperations(client).diagnoseClient(MAC);
        expect(result.sections.client.status).toBe('ok');
        expect(result.sections.devices.status).toBe('ok');
        expect(result.sections.topology).toEqual({ status: 'error', message: 'Web credentials missing' });
        expect(result.sections.history).toEqual({ status: 'error', message: 'History unavailable' });
        expect(result.collectionComplete).toBe(false);
        expect(result.pathComplete).toBe(false);
    });

    it('marks truncated history as incomplete even when the attachment path is available', async () => {
        const client = sources();
        client.getClientHistory.mockResolvedValue({ clientMac: MAC, sessions: [], truncated: true });
        const result = await new DiagnosticsOperations(client).diagnoseClient(MAC);
        expect(result.collectionComplete).toBe(false);
        expect(result.pathComplete).toBe(true);
    });

    it.each([NOW - 3_600_000, undefined, NOW + 3_600_000])(
        'never labels stale or undated topology as a complete current path (%s)',
        async (lastUpdateTime) => {
            const client = sources();
            client.getSiteTopology.mockResolvedValue({ lastUpdateTime, topologyArray: [{ mac: AP }] });
            const result = await new DiagnosticsOperations(client).diagnoseClient(MAC);
            expect(result.path.nodes.length).toBe(2);
            expect(result.pathComplete).toBe(false);
            expect(result.path.staleness).toBe(lastUpdateTime === undefined ? 'unknown' : 'stale');
        }
    );

    it('reports malformed topology as a section failure', async () => {
        const client = sources();
        client.getSiteTopology.mockResolvedValue({});
        const result = await new DiagnosticsOperations(client).diagnoseClient(MAC);
        expect(result.sections.topology.status).toBe('error');
        expect(result.collectionComplete).toBe(false);
    });

    it('bounds cyclic topology traversal and records incomplete evidence', async () => {
        const client = sources();
        const root: { mac: string; successors: unknown[] } = { mac: AP, successors: [] };
        root.successors.push(root);
        client.getSiteTopology.mockResolvedValue({ lastUpdateTime: NOW, topologyArray: [root] });
        const result = await new DiagnosticsOperations(client).diagnoseClient(MAC);
        expect(result.path.traversalTruncated).toBe(true);
        expect(result.pathComplete).toBe(false);
        expect(result.collectionComplete).toBe(false);
    });

    it('bounds very large topology responses', async () => {
        const client = sources();
        client.getSiteTopology.mockResolvedValue({
            lastUpdateTime: NOW,
            topologyArray: Array.from({ length: 2100 }, (_, index) => ({ name: `node-${index}` })),
        });
        const result = await new DiagnosticsOperations(client).diagnoseClient(MAC);
        expect(result.sections.topology).toMatchObject({ status: 'ok', data: { nodesVisited: 2000, traversalTruncated: true } });
        expect(result.pathComplete).toBe(false);
    });

    it('bounds path depth and flags unreachable attachment evidence', async () => {
        const client = sources();
        let node: { mac: string; successors: unknown[] } = { mac: AP, successors: [] };
        for (let depth = 0; depth < 70; depth += 1) node = { mac: GATEWAY, successors: [node] };
        client.getSiteTopology.mockResolvedValue({ lastUpdateTime: NOW, topologyArray: [node] });
        const result = await new DiagnosticsOperations(client).diagnoseClient(MAC);
        expect(result.path.traversalTruncated).toBe(true);
        expect(result.pathComplete).toBe(false);
        expect(result.collectionComplete).toBe(false);
    });

    it('uses one explicit bounded window for both log sources', async () => {
        const client = sources();
        const result = await new DiagnosticsOperations(client).diagnoseLogs('site-1');
        expect(result.queryWindow).toEqual({ timeStart: NOW - 86_400_000, timeEnd: NOW });
        expect(client.listEvents).toHaveBeenCalledWith('site-1', 1, 100, NOW - 86_400_000, NOW);
        expect(client.listAlerts).toHaveBeenCalledWith('site-1', 1, 100, NOW - 86_400_000, NOW);
        expect(result.collectionComplete).toBe(true);
    });

    it('reports log truncation from totals and scan caps', async () => {
        const client = sources();
        client.listEvents.mockResolvedValue({ data: [{ key: 'DEV_TEST' }], totalRows: 20 });
        client.listAlerts.mockResolvedValue({ data: [], totalRows: 0, scanTruncated: true });
        const result = await new DiagnosticsOperations(client).diagnoseLogs('site-1', NOW - 1000, NOW, 10);
        expect(result.sections.events).toMatchObject({ status: 'ok', data: { truncated: true, totalRows: 20 } });
        expect(result.sections.alerts).toMatchObject({ status: 'ok', data: { truncated: true } });
        expect(result.collectionComplete).toBe(false);
    });

    it('does not claim completeness for a full page without a known total', async () => {
        const client = sources();
        client.listEvents.mockResolvedValue({ data: [{ key: 'DEV_TEST' }] });
        const result = await new DiagnosticsOperations(client).diagnoseLogs(undefined, undefined, undefined, 1);
        expect(result.sections.events).toMatchObject({ status: 'ok', data: { truncated: true, completenessKnown: false } });
        expect(result.collectionComplete).toBe(false);
    });

    it('distinguishes missing log data from a successful empty result and preserves the other source', async () => {
        const client = sources();
        client.listEvents.mockResolvedValue({});
        client.listAlerts.mockRejectedValue(new Error('Permission denied'));
        const result = await new DiagnosticsOperations(client).diagnoseLogs();
        expect(result.sections.events.status).toBe('error');
        expect(result.sections.alerts).toEqual({ status: 'error', message: 'Permission denied' });
        expect(result.collectionComplete).toBe(false);
    });

    it('rejects invalid windows and page sizes before making requests', async () => {
        const client = sources();
        const ops = new DiagnosticsOperations(client);
        await expect(ops.diagnoseClient('not-a-mac')).rejects.toThrow('full MAC');
        await expect(ops.diagnoseClient(MAC, undefined, NOW, NOW - 1)).rejects.toThrow('timeStart <= timeEnd');
        await expect(ops.diagnoseLogs(undefined, NOW, NOW - 1)).rejects.toThrow('timeStart <= timeEnd');
        await expect(ops.diagnoseLogs(undefined, undefined, undefined, 201)).rejects.toThrow('between 1 and 200');
        expect(client.listClients).not.toHaveBeenCalled();
        expect(client.listEvents).not.toHaveBeenCalled();
    });
});
