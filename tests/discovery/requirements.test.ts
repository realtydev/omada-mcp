import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { OperationCatalog } from '../../src/discovery/catalog.js';
import { executeDiscoveredOperation } from '../../src/discovery/execute.js';
import { validateWriteRequirements } from '../../src/discovery/requirements.js';
import type { RequestHandler } from '../../src/omadaClient/request.js';

const document = JSON.parse(readFileSync(new URL('../../docs/openapi/00-all.json', import.meta.url), 'utf8'));
const catalog = new OperationCatalog(document, 'bundled');
const context = { omadacId: 'controller', siteId: 'site', readOnly: false };
const dns = { enable: false, name: 'Validation', domain: 'validation.invalid', type: 0, ipAddresses: ['192.0.2.1'], lanNetworkIds: ['net'] };
const ddns = { service: 0, status: false, username: 'user', password: 'sentinel-secret', interfacePortId: 'wan', interval: { updateInterval: 1 } };
const profile = {
    name: 'Validation',
    nativeNetworkId: 'net',
    poe: 2,
    dot1x: 1,
    bandWidthCtrlType: 0,
    lldpMedEnable: false,
    spanningTreeEnable: true,
    loopbackDetectEnable: true,
    portIsolationEnable: false,
    untagNetworkIds: [],
};
const voucher = {
    name: 'Validation',
    amount: 1,
    codeLength: 6,
    codeForm: [0],
    duration: 60,
    durationType: 0,
    limitType: 2,
    timingType: 0,
    rateLimit: { mode: 1, rateLimitProfileId: 'profile' },
    trafficLimitEnable: false,
    applyToAllPortals: true,
};

function setup() {
    const request = { request: vi.fn(), ensureSuccess: vi.fn() };
    const run = (operationId: string, body: unknown, dryRun = true) =>
        executeDiscoveredOperation(
            catalog,
            request as unknown as RequestHandler,
            {
                operationId,
                body: JSON.parse(JSON.stringify(body)),
                dryRun,
                params:
                    operationId === 'modifyLanProfile'
                        ? { profileId: 'profile' }
                        : operationId === 'modifyDdns'
                          ? { ddnsId: 'ddns' }
                          : operationId === 'modifyLanDns'
                            ? { dnsId: 'dns' }
                            : operationId === 'modifyPowerSavingConfig'
                              ? { apMac: 'AA-BB-CC-DD-EE-FF' }
                              : {},
            },
            context
        );
    return { request, run };
}

describe('curated discovered write requirements', () => {
    it('requires declared AP modes and permits disabled/smart modes without inventing trigger settings', async () => {
        const { run, request } = setup();
        for (const mode of [0, 2, 3]) await expect(run('modifyPowerSavingConfig', { mode })).resolves.toMatchObject({ written: false });
        for (const body of [{ timeEnable: false, bandEnable: false }, { mode: 4 }, { mode: 2, timeEnable: true }, { mode: 0, bandEnable: true }])
            await expect(run('modifyPowerSavingConfig', body)).rejects.toThrow('write requirements');
        await expect(run('modifyPowerSavingConfig', { mode: 1, bandEnable: true, bands: [0], idleDuration: 60 })).resolves.toMatchObject({
            written: false,
        });
        expect(request.request).not.toHaveBeenCalled();
    });
    it('retains the legacy AP contract when its selected schema has no mode', async () => {
        const legacy = new OperationCatalog(
            JSON.parse(readFileSync(new URL('../../docs/openapi/03-device.json', import.meta.url), 'utf8')),
            'bundled'
        );
        const request = { request: vi.fn() };
        const run = (body: unknown) =>
            executeDiscoveredOperation(
                legacy,
                request as unknown as RequestHandler,
                { operationId: 'modifyPowerSavingConfig', params: { apMac: 'AA-BB-CC-DD-EE-FF' }, body },
                context
            );
        await expect(run({ timeEnable: false, bandEnable: false })).resolves.toMatchObject({ written: false });
        await expect(run({ timeEnable: true, bandEnable: false })).rejects.toThrow('write requirements');
        await expect(run({ mode: 0 })).rejects.toThrow();
        expect(request.request).not.toHaveBeenCalled();
    });
    it('requires a bounded TTL only when custom TTL is enabled in the selected DNS contract', async () => {
        const { run, request } = setup();
        for (const settings of [{ customTtl: true }, { customTtl: true, ttl: 0 }, { customTtl: true, ttl: 86401 }])
            await expect(run('createLanDns', { ...dns, ...settings })).rejects.toThrow('write requirements');
        await expect(run('createLanDns', { ...dns, customTtl: true, ttl: 1 })).resolves.toMatchObject({ written: false });
        await expect(run('createLanDns', { ...dns, customTtl: true, ttl: 86400 })).resolves.toMatchObject({ written: false });
        expect(request.request).not.toHaveBeenCalled();
    });
    it.each(['createDdns', 'modifyDdns'])('rejects missing, conflicting and unsupported intervals for %s before I/O', async (id) => {
        const { run, request } = setup();
        for (const interval of [
            undefined,
            {},
            { updateInterval: 1, customInterval: 5 },
            { updateInterval: 2 },
            { customInterval: 0 },
            { customInterval: 61 },
        ]) {
            await expect(run(id, { ...ddns, interval })).rejects.toThrow('write requirements');
        }
        await expect(run(id, { ...ddns, service: 2, interval: { customInterval: 5 } })).rejects.toThrow('write requirements');
        expect(request.request).not.toHaveBeenCalled();
    });
    it.each([0, 1, 2, 3, 4, 5])('preserves valid DDNS service %s previews and secrets', async (service) => {
        const { run, request } = setup();
        const body = { ...ddns, service, ...(service === 5 ? { interval: undefined } : {}) };
        const result = await run('createDdns', body);
        expect(result).toMatchObject({ dryRun: true, written: false });
        expect(result.request.body).toEqual(JSON.parse(JSON.stringify(body)));
        expect(request.request).not.toHaveBeenCalled();
    });
    it.each(['createLanDns', 'modifyLanDns'])('requires network selections for %s and validates DNS type dependencies', async (id) => {
        const { run, request } = setup();
        for (const body of [
            { ...dns, lanNetworkIds: undefined },
            { ...dns, lanNetworkIds: [] },
            { ...dns, type: 1, cname: undefined },
            { ...dns, type: 2, dnsServers: [] },
        ])
            await expect(run(id, body)).rejects.toThrow('write requirements');
        expect(request.request).not.toHaveBeenCalled();
        await expect(run(id, dns)).resolves.toMatchObject({ written: false });
    });
    it('requires explicit untagged networks on LAN profile replacement, accepting an empty selection', async () => {
        const { run, request } = setup();
        await expect(run('modifyLanProfile', { ...profile, untagNetworkIds: undefined })).rejects.toThrow('write requirements');
        await expect(run('modifyLanProfile', profile)).resolves.toMatchObject({ written: false });
        expect(request.request).not.toHaveBeenCalled();
    });
    it('requires the source matching voucher rate-limit mode', async () => {
        const { run, request } = setup();
        for (const rateLimit of [
            { mode: 1 },
            { mode: 0 },
            { mode: 1, rateLimitProfileId: 'profile', customRateLimit: { upLimitEnable: false, downLimitEnable: false } },
        ])
            await expect(run('createVoucherGroup', { ...voucher, rateLimit })).rejects.toThrow('write requirements');
        expect(request.request).not.toHaveBeenCalled();
        await expect(run('createVoucherGroup', voucher)).resolves.toMatchObject({ written: false });
    });
    it('enforces documented power-saving schedule dependencies and bounds without inventing mode', async () => {
        const { run, request } = setup();
        for (const body of [
            { timeEnable: true, bandEnable: false },
            { timeEnable: true, bandEnable: false, startTimeH: 24, startTimeM: 0, endTimeH: 1, endTimeM: 0 },
            { timeEnable: false, bandEnable: true, bands: [1] },
            { timeEnable: false, bandEnable: true, bands: [1], idleDuration: 59 },
        ])
            await expect(run('modifyPowerSavingConfig', { mode: 1, ...body })).rejects.toThrow('write requirements');
        await expect(
            run('modifyPowerSavingConfig', { mode: 1, timeEnable: true, bandEnable: false, startTimeH: 0, startTimeM: 0, endTimeH: 23, endTimeM: 59 })
        ).resolves.toMatchObject({ written: false });
        await expect(
            run('modifyPowerSavingConfig', { mode: 1, timeEnable: false, bandEnable: true, bands: [1], idleDuration: 60 })
        ).resolves.toMatchObject({
            written: false,
        });
        expect(request.request).not.toHaveBeenCalled();
    });
    it('enforces the same requirements for actual writes and keeps submitted credentials out of validation errors', async () => {
        const { run, request } = setup();
        await expect(run('createDdns', { ...ddns, interval: {} }, false)).rejects.toThrow('write requirements');
        try {
            await run('createDdns', { ...ddns, interval: {} });
        } catch (error) {
            expect(String(error)).not.toContain(ddns.password);
        }
        expect(request.request).not.toHaveBeenCalled();
    });
    it('preserves the DDNS ASCII credential restrictions after converting the vendor regex', async () => {
        const { run, request } = setup();
        for (const password of ['', ' leading', 'trailing ', 'nonasciié', 'x'.repeat(129)])
            await expect(run('createDdns', { ...ddns, password })).rejects.toThrow('Invalid operation input');
        await expect(run('createDdns', { ...ddns, password: 'a b' })).resolves.toMatchObject({ written: false });
        expect(request.request).not.toHaveBeenCalled();
    });
    it('uses canonical routes rather than names, without extending rules to reads or other API versions', () => {
        const original = catalog.get('createLanDns')!;
        expect(() => validateWriteRequirements({ ...original, operationId: 'renamed' }, { ...dns, lanNetworkIds: [] })).toThrow('write requirements');
        expect(() => validateWriteRequirements({ ...original, method: 'GET' }, {})).not.toThrow();
        expect(() => validateWriteRequirements({ ...original, path: original.path.replace('/v1/', '/v2/') }, {})).not.toThrow();
        expect(() =>
            validateWriteRequirements({ ...original, path: original.path.replace('/sites/{siteId}', '/sitetemplates/{siteTemplateId}') }, {})
        ).not.toThrow();
    });
    it('accepts documented conditional boundaries without rewriting submitted values', async () => {
        const { run } = setup();
        for (const interval of [{ customInterval: 1 }, { customInterval: 60 }, { updateInterval: 0 }, { updateInterval: 72 }])
            await expect(run('createDdns', { ...ddns, interval })).resolves.toMatchObject({ request: { body: { interval } } });
        await expect(run('createLanDns', { ...dns, type: 1, cname: 'target.invalid' })).resolves.toMatchObject({ written: false });
        await expect(run('createLanDns', { ...dns, ipAddresses: [], ipv6Addresses: ['2001:db8::1'] })).resolves.toMatchObject({ written: false });
        await expect(
            run('createVoucherGroup', { ...voucher, rateLimit: { mode: 0, customRateLimit: { upLimitEnable: false, downLimitEnable: false } } })
        ).resolves.toMatchObject({ written: false });
        await expect(
            run('modifyPowerSavingConfig', { mode: 1, timeEnable: false, bandEnable: true, bands: [1], idleDuration: 1440 })
        ).resolves.toMatchObject({
            written: false,
        });
    });
});

describe('LAN DNS address trust boundary', () => {
    it.each([
        { ipAddresses: ['not-an-ip'] },
        { ipAddresses: ['256.1.2.3'] },
        { ipAddresses: ['192.0.2.1/24'] },
        { ipAddresses: [], ipv6Addresses: ['not-ipv6'] },
        { ipAddresses: [], ipv6Addresses: ['fe80::1%eth0'] },
        { type: 2, dnsServers: ['x'] },
        { type: 2, dnsServers: ['resolver.invalid'] },
        { domain: 'bad_name.invalid' },
        { aliases: ['not-a-qualified-name'] },
        { type: 1, cname: 'bad_target.invalid' },
    ])('rejects invalid address configuration before requests %j', async (settings) => {
        const operation = catalog.get('createLanDns')!;
        expect(() => validateWriteRequirements(operation, { ...dns, ...settings })).toThrow('write requirements');
        const request = { request: vi.fn() };
        await expect(
            executeDiscoveredOperation(
                catalog,
                request as unknown as RequestHandler,
                { operationId: 'createLanDns', body: { ...dns, ...settings }, dryRun: false },
                context
            )
        ).rejects.toThrow();
        expect(request.request).not.toHaveBeenCalled();
    });
    it('accepts hardware-qualified array items without weakening unknown vendor constraints', async () => {
        const operation = catalog.get('createLanDns')!;
        for (const config of [
            { ...dns },
            { ...dns, ipAddresses: [], ipv6Addresses: ['2001:db8::1'] },
            { ...dns, type: 2, dnsServers: ['192.0.2.53'], lanNetworkIds: undefined },
            { ...dns, type: 2, dnsServers: ['2001:db8::53'], lanNetworkIds: undefined },
        ])
            expect(() => validateWriteRequirements(operation, config)).not.toThrow();
        const request = { request: vi.fn() };
        for (const config of [
            { ...dns, type: 2, dnsServers: ['192.0.2.53'], lanNetworkIds: undefined },
            { ...dns, ipAddresses: [], ipv6Addresses: ['2001:db8:1111:2222:3333:4444:5555:6666'] },
            { ...dns, aliases: ['long-hardware-qualification-alias.invalid'] },
        ])
            await expect(
                executeDiscoveredOperation(
                    catalog,
                    request as unknown as RequestHandler,
                    { operationId: 'createLanDns', body: JSON.parse(JSON.stringify(config)), dryRun: true },
                    context
                )
            ).resolves.toMatchObject({ written: false, dryRun: true });
        const changed = structuredClone(document);
        changed.components.schemas.LanDnsOpenApiVO.properties.dnsServers.items.maxLength = 3;
        await expect(
            executeDiscoveredOperation(
                new OperationCatalog(changed, 'live'),
                request as unknown as RequestHandler,
                {
                    operationId: 'createLanDns',
                    body: JSON.parse(JSON.stringify({ ...dns, type: 2, dnsServers: ['192.0.2.53'], lanNetworkIds: undefined })),
                    dryRun: true,
                },
                context
            )
        ).rejects.toThrow('must NOT have more than 3 characters');
        expect(request.request).not.toHaveBeenCalled();
    });
});
