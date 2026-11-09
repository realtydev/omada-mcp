import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { installReadOnlyGuard } from './read-only-guard.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv.includes('--help')) {
    process.stdout.write(
        'Read-only live MCP smoke checks. Run yarn build first, then yarn smoke:readonly with controller credentials in .env/.env.local.\nOnly GET/HEAD and exact authentication POST endpoints are allowed. No RF scans or speed tests are started.\nExit 0: all checks passed; 1: failure; 2: incomplete because a capability or device is unavailable. Output contains counts and status, not network identifiers.\n'
    );
    process.exit(0);
}
if (!existsSync(resolve(root, 'dist/server/common.js'))) {
    process.stderr.write('Build output is missing. Run yarn build before live smoke checks.\n');
    process.exit(1);
}

process.chdir(root);
await import(pathToFileURL(resolve(root, 'dist/env.js')).href);
const { initLogger } = await import(pathToFileURL(resolve(root, 'dist/utils/logger.js')).href);
initLogger('silent');
const { loadConfigFromEnv } = await import(pathToFileURL(resolve(root, 'dist/config.js')).href);
const { OmadaClient } = await import(pathToFileURL(resolve(root, 'dist/omadaClient/index.js')).href);
const { createServer } = await import(pathToFileURL(resolve(root, 'dist/server/common.js')).href);
const { default: axios } = await import('axios');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

const checks = [];
let protocolClient;
let server;
let guard;
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const assert = (condition, message) => {
    if (!condition) throw new Error(message);
};

function errorSummary(error) {
    const message = String(error?.message ?? '');
    const httpStatus = Number(message.match(/HTTP\s+(\d{3})/i)?.[1]) || undefined;
    const controllerErrorCode = Number(message.match(/errorCode[:\s]+(-?\d+)/i)?.[1]) || undefined;
    const credentialsMissing = /web.*credentials|OMADA_WEB_USERNAME|OMADA_WEB_PASSWORD/i.test(message);
    const unavailable =
        httpStatus === 404 || controllerErrorCode === -1600 || credentialsMissing || /not supported|unsupported|not available/i.test(message);
    return {
        unavailable,
        reason: credentialsMissing ? 'web_credentials_unavailable' : unavailable ? 'capability_unavailable' : 'request_or_contract_failed',
        httpStatus,
        controllerErrorCode,
    };
}

async function check(name, run) {
    try {
        const detail = await run();
        const result = {
            name,
            status: detail?.collectionComplete === false ? 'unavailable' : 'pass',
            ...detail,
            ...(detail?.collectionComplete === false ? { reason: 'partial_collection' } : {}),
        };
        checks.push(result);
        emit(result);
        return detail;
    } catch (error) {
        const { unavailable, ...detail } = errorSummary(error);
        const result = { name, status: unavailable ? 'unavailable' : 'fail', ...detail };
        checks.push(result);
        emit(result);
        return undefined;
    }
}

function unavailable(name, reason) {
    const result = { name, status: 'unavailable', reason };
    checks.push(result);
    emit(result);
}

async function call(name, args = {}) {
    const response = await protocolClient.callTool({ name, arguments: args }, undefined, { timeout: 45_000 });
    const text = response.content
        ?.filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n');
    if (response.isError) throw new Error(text || 'Controller read failed');
    return text ? JSON.parse(text) : undefined;
}

try {
    const config = loadConfigFromEnv({ ...process.env, MCP_SERVER_LOG_LEVEL: 'error', OMADA_TIMEOUT: '15000' });
    guard = installReadOnlyGuard(axios, config);
    server = createServer(new OmadaClient(config), { toolProfile: 'read-only' });
    protocolClient = new Client({ name: 'omada-readonly-smoke', version: '1.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), protocolClient.connect(ct)]);
    const { tools } = await protocolClient.listTools();
    const registered = new Set(tools.map((tool) => tool.name));
    const required = ['listDhcpReservations', 'getSiteTopology', 'getSiteDashboard', 'listVpnConnections', 'getGatewayWanSpeedTestResults'];
    await check('registered-read-tools', async () => {
        assert(
            required.every((name) => registered.has(name)),
            'Missing required read tools'
        );
        const info = await call('getServerInfo');
        return { tools: tools.length, commit: info.gitCommit, version: info.packageVersion };
    });
    const sites = await call('listSites');
    assert(Array.isArray(sites) && sites.length > 0, 'No accessible sites');
    const siteId = config.siteId ?? sites[0].siteId ?? sites[0].id;
    assert(typeof siteId === 'string' && siteId.length > 0, 'Site ID unavailable');
    const devices = await call('listDevices', { siteId });
    assert(Array.isArray(devices), 'Device list is not an array');
    const aps = devices.filter((device) => device.type === 'ap' && device.status === 1);
    const gateways = devices.filter((device) => device.type === 'gateway' && device.status === 1);
    emit({ inventory: { sites: sites.length, devices: devices.length, aps: aps.length, gateways: gateways.length } });
    await check('site-dashboard', async () => {
        const dashboard = await call('getSiteDashboard', { siteId });
        assert(dashboard?.sections && typeof dashboard.collectionComplete === 'boolean', 'Unexpected dashboard result');
        const sections = Object.fromEntries(Object.entries(dashboard.sections).map(([name, section]) => [name, section.status]));
        return { collectionComplete: dashboard.collectionComplete, sections };
    });
    await check('switch-ports', async () => {
        const ports = await call('listSwitchPorts', { siteId });
        assert(Array.isArray(ports), 'Unexpected port result');
        return { ports: ports.length };
    });
    await check('dhcp-reservations', async () => {
        const rows = await call('listDhcpReservations', { siteId });
        assert(Array.isArray(rows), 'Unexpected reservation result');
        return { reservations: rows.length };
    });
    await check('site-topology', async () => {
        const topology = await call('getSiteTopology', { siteId });
        assert(topology && typeof topology === 'object', 'Unexpected topology');
        return { returned: true };
    });
    for (const query of [
        { kind: 'tunnel' },
        { kind: 'ipsec' },
        { kind: 's2s', vpnType: 2 },
        { kind: 'server', vpnType: 0 },
        { kind: 'client', vpnType: 0 },
    ]) {
        await check(`vpn-${query.kind}`, async () => {
            const rows = await call('listVpnConnections', { siteId, ...query });
            assert(Array.isArray(rows), 'Unexpected VPN result');
            return { connections: rows.length };
        });
    }
    if (aps.length === 0) unavailable('ap-diagnostics', 'no_online_ap');
    for (let index = 0; index < aps.length; index++) {
        const args = { siteId, apMac: aps[index].mac };
        await check(`ap-${index + 1}-channels`, async () => {
            const radios = await call('getApAvailableChannels', args);
            assert(
                Array.isArray(radios) && radios.length > 0 && radios.every((radio) => Array.isArray(radio.apChannelDetailList)),
                'Unexpected available channels'
            );
            return { radios: radios.length, channels: radios.reduce((total, radio) => total + radio.apChannelDetailList.length, 0) };
        });
        await check(`ap-${index + 1}-rf-results`, async () => {
            const scan = await call('getApRfScanResults', args);
            assert(scan && typeof scan === 'object', 'Unexpected RF result');
            return { scanStatus: Number.isInteger(scan.status) ? scan.status : null };
        });
        await check(`ap-${index + 1}-afc`, async () => {
            const afc = await call('getApAfcStatus', args);
            assert(typeof afc?.status === 'boolean', 'Unexpected AFC result');
            return { working: afc.status };
        });
    }
    if (gateways.length === 0) unavailable('gateway-diagnostics', 'no_online_gateway');
    for (let index = 0; index < gateways.length; index++) {
        const args = { siteId, gatewayMac: gateways[index].mac };
        await check(`gateway-${index + 1}-wan`, async () => {
            const rows = await call('getGatewayWanStatus', args);
            assert(Array.isArray(rows), 'Unexpected WAN result');
            return { ports: rows.length };
        });
        await check(`gateway-${index + 1}-speed-results`, async () => {
            const result = await call('getGatewayWanSpeedTestResults', args);
            assert(result !== undefined, 'Missing speed result');
            return { returned: true };
        });
    }
    const clients = await call('listClients', { siteId });
    assert(Array.isArray(clients), 'Unexpected client list');
    emit({ clientInventory: { clients: clients.length } });
    if (registered.has('diagnoseClient')) {
        if (clients.length === 0) unavailable('client-diagnostics', 'no_clients');
        else
            await check('client-diagnostics', async () => {
                const timeEnd = Date.now();
                const result = await call('diagnoseClient', { siteId, clientMac: clients[0].mac, timeStart: timeEnd - 3_600_000, timeEnd });
                assert(result && typeof result === 'object', 'Unexpected diagnosis');
                assert(
                    typeof result.collectionComplete === 'boolean' && result.sections && typeof result.sections === 'object',
                    'Missing diagnostic completeness'
                );
                return {
                    returned: true,
                    collectionComplete: result.collectionComplete,
                    pathComplete: result.pathComplete,
                    sections: Object.fromEntries(Object.entries(result.sections).map(([name, section]) => [name, section.status])),
                };
            });
    }
    if (registered.has('diagnoseLogs')) {
        const timeEnd = Date.now();
        await check('log-diagnostics', async () => {
            const result = await call('diagnoseLogs', { siteId, timeStart: timeEnd - 3_600_000, timeEnd });
            assert(result && typeof result === 'object', 'Unexpected diagnosis');
            assert(
                typeof result.collectionComplete === 'boolean' && result.sections && typeof result.sections === 'object',
                'Missing diagnostic completeness'
            );
            return {
                returned: true,
                collectionComplete: result.collectionComplete,
                sections: Object.fromEntries(Object.entries(result.sections).map(([name, section]) => [name, section.status])),
            };
        });
    }
} catch (error) {
    const { unavailable: missing, ...detail } = errorSummary(error);
    const result = { name: 'smoke-setup', status: missing ? 'unavailable' : 'fail', ...detail };
    checks.push(result);
    emit(result);
} finally {
    await Promise.allSettled([protocolClient?.close(), server?.close()]);
    guard?.restore();
}
const summary = {
    passed: checks.filter((check) => check.status === 'pass').length,
    failed: checks.filter((check) => check.status === 'fail').length,
    unavailable: checks.filter((check) => check.status === 'unavailable').length,
    requests: guard?.counts,
};
emit({ summary });
process.exitCode = summary.failed > 0 || (summary.requests?.blocked ?? 0) > 0 ? 1 : summary.unavailable > 0 ? 2 : 0;
