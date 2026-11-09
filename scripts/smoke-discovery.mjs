// Read-only acceptance against a real controller. Run yarn build first.
import '../dist/env.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import axios from 'axios';
import { loadConfigFromEnv } from '../dist/config.js';
import { OmadaClient } from '../dist/omadaClient/index.js';
import { createServer } from '../dist/server/common.js';
import { initLogger } from '../dist/utils/logger.js';
import { installReadOnlyGuard } from './read-only-guard.mjs';

initLogger('silent');
const config = loadConfigFromEnv({ ...process.env, OMADA_TIMEOUT: '10000', MCP_TOOL_PROFILE: 'read-only' });
const guard = installReadOnlyGuard(axios, config);
const api = new OmadaClient(config);
const server = createServer(api, { toolProfile: 'read-only' });
const client = new Client({ name: 'discovery-readonly-smoke', version: '1.0.0' });
const [ct, st] = InMemoryTransport.createLinkedPair();
let passed = 0;
const assert = (condition, message) => {
    if (!condition) throw new Error(message);
};
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
async function call(name, args) {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 45000 });
    if (result.isError) throw new Error('Discovery tool failed');
    return JSON.parse(
        result.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('')
    );
}
async function find(query, path) {
    const result = await call('searchApiOperations', { query, method: 'GET', limit: 50 });
    const operation = result.operations.find((op) => op.path === path);
    assert(operation, `Required discovery operation unavailable for ${query}`);
    const description = await call('describeApiOperation', { operationId: operation.operationId });
    assert(description.method === 'GET' && description.path === path, 'Description does not match discovered operation');
    return { operation, source: result.source, fallback: Boolean(result.fallbackReason) };
}
async function read(query, path, params = {}) {
    const { operation, source, fallback } = await find(query, path);
    const result = await call('executeApiOperation', { operationId: operation.operationId, params });
    assert(result.written === false && result.dryRun === false, 'Read result incorrectly reports a write');
    passed++;
    const count = Array.isArray(result.result) ? result.result.length : Array.isArray(result.result?.data) ? result.result.data.length : undefined;
    emit({ check: query, status: 'pass', source, fallback, count });
    return result.result;
}
try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    const { tools } = await client.listTools();
    assert(
        ['searchApiOperations', 'describeApiOperation', 'executeApiOperation', 'getSiteDashboard'].every((name) =>
            tools.some((tool) => tool.name === name)
        ),
        'Missing discovery or existing tools'
    );
    emit({ registeredReadTools: tools.length });
    const root = '/openapi/v1/{omadacId}';
    const sites = await read('site list', `${root}/sites`);
    const site = Array.isArray(sites) ? sites[0] : sites?.data?.[0];
    const siteId = config.siteId ?? site?.siteId ?? site?.id;
    assert(typeof siteId === 'string', 'No site accessible');
    await read('device list', `${root}/sites/{siteId}/devices`, { siteId });
    await read('client list', `${root}/sites/{siteId}/clients`, { siteId });
    await read('wifi summary', `${root}/sites/{siteId}/dashboard/wifi-summary`, {
        siteId,
        start: Math.floor(Date.now() / 1000) - 3600,
        end: Math.floor(Date.now() / 1000),
    });
    await read('rate limit profile list', `${root}/sites/{siteId}/rate-limit-profiles`, { siteId });
    const rejection = await client.callTool({
        name: 'executeApiOperation',
        arguments: { operationId: 'rebootDevice', params: { siteId, deviceMac: 'AA-BB-CC-DD-EE-FF' }, dryRun: false },
    });
    assert(rejection.isError === true, 'Read-only discovered write was not rejected');
    passed++;
    const invalid = await client.callTool({ name: 'executeApiOperation', arguments: { operationId: 'missing-operation', params: {} } });
    assert(invalid.isError === true, 'Unknown operation was not rejected');
    passed++;
    assert(guard.counts.blocked === 0, 'A write reached the network guard instead of being rejected by policy');
    emit({ summary: { passed, failed: 0, requests: guard.counts } });
} catch {
    emit({
        summary: { passed, failed: 1, requests: guard.counts },
        reason: 'Discovery read or contract check failed; no network identifiers are printed',
    });
    process.exitCode = 1;
} finally {
    await client.close();
    await server.close();
    guard.restore();
}
