type Row = Record<string, unknown>;
export interface NetworkObservation {
    code: string;
    severity: 'warning' | 'info';
    basis: 'controller_snapshot' | 'historical_event' | 'candidate' | 'evidence_gap';
    message: string;
    evidence: string[];
    details?: Row;
    nextTool?: { name: string; arguments: Row };
}
export interface FindingsSection {
    status: string;
    data?: unknown;
}
const obj = (v: unknown): Row | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : undefined);
const list = (v: unknown): Row[] => (Array.isArray(v) ? (v.filter((x) => obj(x)) as Row[]) : []);
const mac = (v: unknown) => (typeof v === 'string' ? v.replace(/[:-]/g, '').toLowerCase() : '');
const number = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const blocks80 = [
    [36, 40, 44, 48],
    [52, 56, 60, 64],
    [100, 104, 108, 112],
    [116, 120, 124, 128],
    [132, 136, 140, 144],
    [149, 153, 157, 161],
];
function occupied(channel: number, width: number): number[] | undefined {
    if (width === 20 && blocks80.some((b) => b.includes(channel))) return [channel];
    if (width === 40) {
        for (const b of blocks80) for (const pair of [b.slice(0, 2), b.slice(2)]) if (pair.includes(channel)) return pair;
    }
    if (width === 80) return blocks80.find((b) => b.includes(channel));
    if (width === 160)
        return [
            [36, 40, 44, 48, 52, 56, 60, 64],
            [100, 104, 108, 112, 116, 120, 124, 128],
        ].find((b) => b.includes(channel));
    return undefined;
}
function loopIdentity(content: unknown): { switchMac: string; port: string } | undefined {
    if (typeof content !== 'string') return undefined;
    const sw = content.match(/\[switch:([a-f\d:-]{12,17})\]/i);
    const port = content.match(/(?:Tw|Gi|Te|Fo)?(\d+)\/(\d+)\/(\d+)/i) ?? content.match(/\bport\s+(\d+)/i);
    if (!sw || !port || !/^[a-f\d]{12}$/.test(mac(sw[1])) || Number(port.at(-1)) < 1) return undefined;
    return { switchMac: mac(sw[1]), port: port.length === 4 ? `${port[1]}:${port[2]}:${port[3]}` : `native:${port[1]}` };
}
export function networkFindings(sections: Partial<Record<string, FindingsSection>>, weakRssi: number): NetworkObservation[] {
    const findings: NetworkObservation[] = [];
    for (const [key, s] of Object.entries(sections))
        if (s && s.status !== 'ok')
            findings.push({
                code: 'evidence_incomplete',
                severity: 'info',
                basis: 'evidence_gap',
                message: `${key} evidence is ${s.status}; absence of findings is not proof of health.`,
                evidence: [`sections.${key}`],
            });
    const devices = list(sections.devices?.data),
        clients = list(sections.clients?.data);
    const names = new Map(devices.map((d) => [mac(d.mac), d.name]));
    devices.forEach((d, i) => {
        if (typeof d.status === 'number' && d.status >= 0 && d.status !== 1)
            findings.push({
                code: 'device_not_connected',
                severity: 'warning',
                basis: 'controller_snapshot',
                message: 'The controller reports a device outside its connected state.',
                evidence: [`sections.devices.data[${i}]`],
                details: { name: d.name, mac: d.mac, status: d.status },
            });
    });
    clients.forEach((c, i) => {
        const rssi = number(c.rssi);
        if (c.wireless !== true || c.active === false || rssi === undefined || rssi < -126 || rssi >= 0 || rssi > weakRssi) return;
        findings.push({
            code: 'weak_client_signal',
            severity: 'warning',
            basis: 'controller_snapshot',
            message: 'Reported client signal meets the configured review threshold; this does not establish the cause of a connection problem.',
            evidence: [`sections.clients.data[${i}].rssi`],
            details: {
                name: c.name,
                mac: c.mac,
                apName: c.apName,
                apMac: c.apMac,
                ssid: c.ssid,
                rssiDbm: rssi,
                snrDb: c.snr,
                thresholdDbm: weakRssi,
            },
            nextTool: { name: 'diagnoseClient', arguments: { clientMac: c.mac } },
        });
    });
    const wifi = obj(sections.wifi?.data);
    const radios: Array<{ ap: Row; radio: Row; path: string }> = [];
    list(wifi?.aps).forEach((ap, i) => {
        const evidence = obj(ap.radios),
            data = obj(evidence?.data);
        list(data?.radios).forEach((radio, j) => {
            const path = `sections.wifi.data.aps[${i}].radios.data.radios[${j}]`;
            radios.push({ ap, radio, path });
            if (/^5g/.test(String(radio.band)) && number(obj(radio.metrics)?.actualChannelNumber) === undefined)
                findings.push({
                    code: 'operating_channel_unknown',
                    severity: 'info',
                    basis: 'evidence_gap',
                    message: 'An operating 5 GHz channel could not be qualified; overlap assessment is incomplete.',
                    evidence: [path + '.metrics'],
                });
            if (radio.band === '2g' && obj(radio.metrics)?.channelWidth === '40MHz')
                findings.push({
                    code: 'wide_2g_channel',
                    severity: 'info',
                    basis: 'candidate',
                    message: 'A 2.4 GHz radio reports 40 MHz operation; review shared-spectrum use before selecting changes.',
                    evidence: [path],
                    details: { apMac: ap.mac, apName: names.get(mac(ap.mac)) },
                });
        });
        if (obj(ap.rf)?.status !== 'ok')
            findings.push({
                code: 'rf_evidence_incomplete',
                severity: 'info',
                basis: 'evidence_gap',
                message: 'Saved RF evidence is missing, stale or incomplete. No scan was started.',
                evidence: [`sections.wifi.data.aps[${i}].rf`],
            });
    });
    for (let i = 0; i < radios.length; i++)
        for (let j = i + 1; j < radios.length; j++) {
            const a = radios[i],
                b = radios[j];
            if (mac(a.ap.mac) === mac(b.ap.mac) || !/^5g/.test(String(a.radio.band)) || !/^5g/.test(String(b.radio.band))) continue;
            const am = obj(a.radio.metrics),
                bm = obj(b.radio.metrics),
                ac = number(am?.actualChannelNumber),
                bc = number(bm?.actualChannelNumber);
            const aw = typeof am?.channelWidth === 'string' ? Number(am.channelWidth.match(/^(20|40|80|160)MHz$/)?.[1]) : NaN,
                bw = typeof bm?.channelWidth === 'string' ? Number(bm.channelWidth.match(/^(20|40|80|160)MHz$/)?.[1]) : NaN;
            const ao = ac === undefined ? undefined : occupied(ac, aw),
                bo = bc === undefined ? undefined : occupied(bc, bw);
            if (!ao || !bo) continue;
            const shared = ao.filter((c) => bo.includes(c));
            if (!shared.length) continue;
            findings.push({
                code: 'shared_5g_spectrum',
                severity: 'warning',
                basis: 'candidate',
                message:
                    'Two AP radios occupy overlapping 5 GHz spectrum. This is a contention candidate, not proof of interference or a throughput bottleneck.',
                evidence: [a.path + '.metrics', b.path + '.metrics'],
                details: {
                    apMacs: [a.ap.mac, b.ap.mac],
                    apNames: [names.get(mac(a.ap.mac)) ?? null, names.get(mac(b.ap.mac)) ?? null],
                    primaryChannels: [ac, bc],
                    widthsMHz: [aw, bw],
                    shared20MHzChannels: shared,
                },
            });
        }
    const sw = obj(sections.switchPorts?.data);
    list(sw?.ports).forEach((p, i) => {
        if (obj(p.portStatus)?.stpDiscarding === true)
            findings.push({
                code: 'switch_port_discarding',
                severity: 'warning',
                basis: 'controller_snapshot',
                message: 'A returned switch port is reported as STP discarding; this alone does not establish a loop.',
                evidence: [`sections.switchPorts.data.ports[${i}].portStatus`],
                details: { switchMac: p.switchMac, switchName: p.switchName ?? names.get(mac(p.switchMac)), port: p.port },
            });
    });
    const topology = obj(sections.topology?.data);
    if (topology && topology.freshness !== 'fresh')
        findings.push({
            code: 'topology_not_fresh',
            severity: 'info',
            basis: 'evidence_gap',
            message: 'The topology timestamp is stale or unknown; physical paths are not established by this report.',
            evidence: ['sections.topology.data'],
            details: { freshness: topology.freshness, updatedAt: topology.updatedAt },
        });
    const events = list(obj(sections.events?.data)?.records),
        alerts = list(obj(sections.alerts?.data)?.records);
    const loops = [
        ...events.map((e, i) => ({ e, path: `sections.events.data.records[${i}]` })),
        ...alerts.map((e, i) => ({ e, path: `sections.alerts.data.records[${i}]` })),
    ].filter((x) => x.e.key === 'OSW_DET_LOOP');
    const seen = new Set<string>();
    for (const item of loops) {
        const incident = loopIdentity(item.e.content),
            time = number(item.e.time);
        const key = `${incident?.switchMac}:${incident?.port}:${time}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const clear =
            incident && time !== undefined
                ? events
                      .map((e, i) => ({ e, path: `sections.events.data.records[${i}]` }))
                      .find((x) => {
                          const observedTime = number(x.e.time);
                          return (
                              x.e.key === 'OSW_LOOP_C' &&
                              observedTime !== undefined &&
                              observedTime > time &&
                              loopIdentity(x.e.content)?.switchMac === incident.switchMac &&
                              loopIdentity(x.e.content)?.port === incident.port
                          );
                      })
                : undefined;
        findings.push({
            code: clear ? 'historical_loop_cleared' : 'historical_loop_reported',
            severity: clear ? 'info' : 'warning',
            basis: 'historical_event',
            message: clear
                ? 'A loop event has a later matching clear event in the requested window. This does not prove that unrelated ports or paths are healthy.'
                : 'A loop was reported in the requested window; no matching later clear was returned. This does not establish an active loop.',
            evidence: [item.path, ...(clear ? [clear.path] : [])],
            details: {
                ...incident,
                switchName: incident ? names.get(incident.switchMac) : undefined,
                reportedAt: time,
                ...(clear ? { clearedAt: clear.e.time } : {}),
            },
        });
    }
    events.forEach((e, i) => {
        if (e.key === 'AP_RADAR')
            findings.push({
                code: 'radar_reported',
                severity: 'info',
                basis: 'historical_event',
                message: 'The controller recorded radar detection; inspect channel-change events when reviewing the channel plan.',
                evidence: [`sections.events.data.records[${i}]`],
                details: { reportedAt: e.time },
            });
    });
    const wan = obj(sections.wan?.data);
    list(wan?.gateways).forEach((g, i) => {
        const report = obj(g.report),
            parts = obj(report?.sections),
            status = obj(parts?.status);
        list(status?.data).forEach((p, j) => {
            if ((typeof p.status === 'number' && p.status !== 1) || (typeof p.internetState === 'number' && p.internetState !== 1))
                findings.push({
                    code: 'wan_not_online',
                    severity: 'warning',
                    basis: 'controller_snapshot',
                    message:
                        'A reported WAN port is outside the connected/internet-up state; configuration intent and failover have not been tested.',
                    evidence: [`sections.wan.data.gateways[${i}].report.sections.status.data[${j}]`],
                    details: { gatewayMac: g.gatewayMac, port: p.port, name: p.name, status: p.status, internetState: p.internetState },
                });
        });
    });
    return findings.sort((a, b) => Number(a.severity === 'info') - Number(b.severity === 'info'));
}
