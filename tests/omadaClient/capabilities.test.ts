import type { AxiosInstance } from 'axios';
import { describe, expect, it, vi } from 'vitest';

import { OperationCatalog } from '../../src/discovery/catalog.js';
import { ControllerCapabilityOperations } from '../../src/omadaClient/capabilities.js';
import { RequestHandler } from '../../src/omadaClient/request.js';

const BASE = '/openapi/v1/{omadacId}/sites/{siteId}';
const snapshot = {
    name: 'Private SSID name',
    band: 3,
    broadcast: true,
    enable11r: false,
    guestNetEnable: false,
    mloEnable: false,
    pmfMode: 2,
    security: 3,
    vlanEnable: false,
    pskSetting: { securityKey: 'private-wireless-password' },
};

function setup(metadata: unknown = { controllerVer: '6.3.0.45', apiVer: '3', configured: true, mspMode: false }, mspId?: string) {
    const http = {
        defaults: { timeout: 30_000 },
        request: vi.fn().mockResolvedValue({ status: 200, data: { errorCode: 0, result: metadata } }),
    };
    const config = {
        authMode: 'oauth' as const,
        mspId,
        requestTimeout: 15_000,
        webUsername: 'private-user',
        webPassword: 'private-web-password',
        clientSecret: 'private-client-secret',
        siteId: 'configured-site',
    };
    const catalog = new OperationCatalog(
        {
            openapi: '3.0.1',
            paths: {
                '/openapi/v1/{omadacId}/sites': { get: { operationId: 'listSites' } },
                '/openapi/v1/msp/{mspId}/sites': { get: { operationId: 'listMspSites' } },
                [`${BASE}/wireless-network/wlans/{wlanId}/ssids/{ssidId}/update-basic-config`]: { patch: { operationId: 'updateSsid' } },
                '/openapi/v3/{omadacId}/sites/{siteId}/clients/{clientMac}/health/timeline': { get: { operationId: 'futureHealth' } },
            },
        },
        'bundled',
        'Live controller specification unavailable or invalid'
    );
    const discovery = { getCatalog: vi.fn().mockResolvedValue(catalog) };
    const evidence = { getSsidDetail: vi.fn().mockResolvedValue(snapshot) };
    const service = new ControllerCapabilityOperations(http as unknown as AxiosInstance, discovery, config, evidence);
    return { service, http, discovery, evidence, config, catalog };
}

describe('controller capability evidence', () => {
    it('reports classic metadata without equating metadata API v3 with execution support', async () => {
        const { service, http, evidence } = setup();
        const report = await service.getControllerCapabilities();
        expect(report.controller).toMatchObject({
            status: 'ok',
            source: '/api/info',
            version: '6.3.0.45',
            apiVersion: '3',
            mode: 'classic',
            mspRouting: 'not_applicable',
        });
        expect(report.configuration).toEqual({
            authenticationMode: 'oauth',
            openApi: 'configured',
            internalWebApi: 'configured',
            siteSelected: true,
        });
        expect(report.ssidEvidence.status).toBe('not_requested');
        expect(evidence.getSsidDetail).not.toHaveBeenCalled();
        expect(http.request).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
                method: 'GET',
                url: '/api/info',
                maxRedirects: 0,
                maxContentLength: 256 * 1024,
                timeout: expect.any(Number),
            })
        );
        expect(http.request.mock.calls[0][0].timeout).toBeLessThanOrEqual(10_000);
        expect(http.request.mock.calls[0][0]).not.toHaveProperty('headers');
    });

    it('identifies explicit MSP mode and reports missing scope configuration without inferring an ID', async () => {
        const { service } = setup({ controllerVer: '6.1.0', mspMode: true });
        expect((await service.getControllerCapabilities()).controller).toMatchObject({
            mode: 'msp',
            mspRouting: 'not_configured',
            limitations: expect.arrayContaining([expect.stringContaining('not automatically rewritten')]),
        });
    });

    it('reports configured MSP routing separately from tested controller support and does not reveal the identifier', async () => {
        const { service } = setup({ controllerVer: '6.1.0', mspMode: true }, 'private-msp-id');
        const report = await service.getControllerCapabilities();
        expect(report.controller).toMatchObject({
            mode: 'msp',
            mspRouting: 'configured',
            limitations: expect.arrayContaining([expect.stringContaining('have not been tested')]),
        });
        expect(report.catalog).toMatchObject({
            features: expect.arrayContaining([
                expect.objectContaining({ feature: 'mspSiteListing', structurallyExecutable: 1, controllerSupport: 'not_tested' }),
            ]),
        });
        expect(JSON.stringify(report)).not.toContain('private-msp-id');
    });

    it.each([undefined, null, 0, 'false', 'true'])('does not infer classic mode from mspMode=%s', async (mspMode) => {
        const { service } = setup({ controllerVersion: '5.15.20', mspMode });
        expect((await service.getControllerCapabilities()).controller).toMatchObject({
            status: 'ok',
            version: '5.15.20',
            mode: 'unknown',
            mspRouting: 'unknown',
        });
    });

    it('accepts legacy raw metadata and numeric API version without exposing arbitrary fields', async () => {
        const { service, http } = setup();
        http.request.mockResolvedValue({
            status: 200,
            data: { controllerVer: '5.9.31', apiVer: 2, secret: 'do-not-return', omadacId: 'private-id', mspMode: false },
        });
        const report = await service.getControllerCapabilities();
        expect(report.controller).toMatchObject({ status: 'ok', version: '5.9.31', apiVersion: '2' });
        expect(JSON.stringify(report)).not.toMatch(/do-not-return|private-id|private-user|private-web-password|private-client-secret/);
    });

    it('counts structural eligibility and features independently of actual controller/hardware support', async () => {
        const { service, discovery } = setup();
        const report = await service.getControllerCapabilities();
        expect(discovery.getCatalog).toHaveBeenCalledTimes(1);
        expect(report.catalog).toMatchObject({
            status: 'ok',
            source: 'bundled',
            fallback: true,
            loadedAt: expect.any(Number),
            operations: { total: 4, structurallyExecutable: 3, unsupported: 1, getOperations: 3, nonGetOperations: 1 },
            unsupportedReasons: [{ reason: 'unsupported_path_scope', operations: 1 }],
            features: expect.arrayContaining([
                expect.objectContaining({
                    feature: 'mspSiteListing',
                    advertisement: 'bundled_documented',
                    structurallyExecutable: 1,
                    controllerSupport: 'not_tested',
                }),
                expect.objectContaining({ feature: 'healthAndHistory', apiVersions: ['v3'], controllerSupport: 'not_tested' }),
                expect.objectContaining({ feature: 'switchPorts', advertisement: 'not_documented', controllerSupport: 'not_tested' }),
            ]),
        });
        expect(JSON.stringify(report).length).toBeLessThan(10_000);
    });

    it('distinguishes live documentation from a bundled snapshot without claiming tested support', async () => {
        const { service, discovery, catalog } = setup();
        discovery.getCatalog.mockResolvedValue(new OperationCatalog(catalog.document, 'live'));
        expect((await service.getControllerCapabilities()).catalog).toMatchObject({
            source: 'live',
            fallback: false,
            features: expect.arrayContaining([
                expect.objectContaining({ feature: 'siteListing', advertisement: 'live_documented', controllerSupport: 'not_tested' }),
            ]),
        });
    });

    it.each([
        [403, 'forbidden'],
        [404, 'unsupported'],
        [500, 'unavailable'],
    ])('preserves usable catalog evidence when metadata returns HTTP %s', async (status, expected) => {
        const { service, http } = setup();
        http.request.mockRejectedValue(
            Object.assign(new Error('secret vendor payload'), { isAxiosError: true, response: { status, data: { password: 'private' } } })
        );
        const report = await service.getControllerCapabilities();
        expect(report.controller).toMatchObject({ status: expected, httpStatus: status });
        expect(report.catalog.status).toBe('ok');
        expect(JSON.stringify(report)).not.toMatch(/secret vendor payload|password|"private"/);
    });

    it('reports unreachable metadata without invalidating catalog evidence', async () => {
        const { service, http } = setup();
        http.request.mockRejectedValue(Object.assign(new Error('private host'), { isAxiosError: true, code: 'ENOTFOUND' }));
        const report = await service.getControllerCapabilities();
        expect(report.controller.status).toBe('unavailable');
        expect(report.catalog.status).toBe('ok');
        expect(JSON.stringify(report)).not.toContain('private host');
    });

    it.each([{}, null, [], { controllerVer: 'x'.repeat(129) }, { controllerVer: '6.0\nsecret' }])(
        'marks unusable metadata unknown: %j',
        async (metadata) => {
            expect((await setup(metadata).service.getControllerCapabilities()).controller.status).toBe('unknown');
        }
    );

    it('rejects oversized metadata without echoing it', async () => {
        const { service } = setup({ controllerVer: '6.0', blob: 'x'.repeat(256 * 1024) });
        expect((await service.getControllerCapabilities()).controller.status).toBe('unknown');
    });

    it('does not mistake application rejection for successful evidence', async () => {
        const { service, http } = setup();
        http.request.mockResolvedValue({ status: 200, data: { errorCode: -1600, result: { controllerVer: '6.0', mspMode: false }, msg: 'private' } });
        const report = await service.getControllerCapabilities();
        expect(report.controller).toMatchObject({ status: 'unsupported', errorCode: -1600 });
        expect(JSON.stringify(report)).not.toContain('private');
    });

    it('keeps metadata when a live-only catalogue load fails', async () => {
        const { service, discovery } = setup();
        discovery.getCatalog.mockRejectedValue(new Error('private controller URL and response'));
        const report = await service.getControllerCapabilities();
        expect(report.controller.status).toBe('ok');
        expect(report.catalog).toMatchObject({ status: 'unknown', reason: 'API catalogue evidence could not be collected.' });
        expect(JSON.stringify(report)).not.toContain('private controller');
    });

    it('inspects only the explicit SSID and preserves false versus missing MLO evidence', async () => {
        const { service, evidence } = setup();
        const report = await service.getControllerCapabilities({ wlanId: 'wlan', ssidId: 'ssid', siteId: 'chosen-site' });
        expect(evidence.getSsidDetail).toHaveBeenCalledExactlyOnceWith('wlan', 'ssid', 'chosen-site');
        expect(report.ssidEvidence).toMatchObject({
            status: 'ok',
            sampleOnly: true,
            missingRequiredFields: [],
            invalidRequiredFields: [],
            mloEnable: { availability: 'present', value: false },
            securityKey: 'present',
        });
        expect(JSON.stringify(report)).not.toMatch(/Private SSID name|private-wireless-password|chosen-site|"ssid"/);
        const missing = setup();
        const withoutMlo: Record<string, unknown> = { ...snapshot };
        delete withoutMlo.mloEnable;
        missing.evidence.getSsidDetail.mockResolvedValue(withoutMlo);
        expect((await missing.service.getControllerCapabilities({ wlanId: 'wlan', ssidId: 'ssid' })).ssidEvidence).toMatchObject({
            missingRequiredFields: ['mloEnable'],
            mloEnable: { availability: 'missing' },
        });
    });

    it('reports invalid required fields and masked security keys without their values', async () => {
        const { service, evidence } = setup();
        evidence.getSsidDetail.mockResolvedValue({ ...snapshot, mloEnable: null, band: 999, pskSetting: { securityKey: '********' } });
        const report = await service.getControllerCapabilities({ wlanId: 'wlan', ssidId: 'ssid' });
        expect(report.ssidEvidence).toMatchObject({
            invalidRequiredFields: ['band', 'mloEnable'],
            mloEnable: { availability: 'invalid' },
            securityKey: 'hidden',
        });
        expect(JSON.stringify(report)).not.toContain('********');
    });

    it('reports missing site prerequisites without inspecting an arbitrary site', async () => {
        const { http, discovery, evidence, config } = setup();
        const service = new ControllerCapabilityOperations(
            http as unknown as AxiosInstance,
            discovery,
            { ...config, authMode: 'web', webPassword: undefined, siteId: undefined },
            evidence
        );
        const report = await service.getControllerCapabilities({ wlanId: 'wlan', ssidId: 'ssid' });
        expect(report.configuration).toMatchObject({ authenticationMode: 'web', internalWebApi: 'not_configured', siteSelected: false });
        expect(report.ssidEvidence).toMatchObject({ status: 'unknown', reason: expect.stringContaining('OMADA_SITE_ID') });
        expect(evidence.getSsidDetail).not.toHaveBeenCalled();
    });

    it('retains other evidence when the chosen SSID is forbidden', async () => {
        const { service, evidence } = setup();
        evidence.getSsidDetail.mockRejectedValue(Object.assign(new Error('private'), { status: 403 }));
        const report = await service.getControllerCapabilities({ wlanId: 'wlan', ssidId: 'ssid' });
        expect(report.ssidEvidence.status).toBe('forbidden');
        expect(report.controller.status).toBe('ok');
        expect(report.catalog.status).toBe('ok');
    });

    it.each([
        [-1600, 'unsupported'],
        [-44106, 'forbidden'],
    ])('classifies a real request-handler application failure %s without returning vendor text', async (errorCode, status) => {
        const { http, discovery, config } = setup();
        const request = new RequestHandler(http as unknown as AxiosInstance, {
            getAuthHeaders: vi.fn().mockResolvedValue({}),
            clearToken: vi.fn(),
        });
        const evidence = {
            getSsidDetail: async () => request.ensureSuccess({ errorCode, msg: 'private vendor response' }),
        };
        const service = new ControllerCapabilityOperations(http as unknown as AxiosInstance, discovery, config, evidence);
        const report = await service.getControllerCapabilities({ wlanId: 'wlan', ssidId: 'ssid' });
        expect(report.ssidEvidence).toMatchObject({ status, errorCode });
        expect(report.controller.status).toBe('ok');
        expect(JSON.stringify(report)).not.toContain('private vendor response');
    });

    it.each([{ wlanId: 'wlan' }, { ssidId: 'ssid' }, { siteId: '' }, { siteId: 'x'.repeat(129) }])(
        'rejects invalid options before network calls: %j',
        async (options) => {
            const { service, http, evidence, discovery } = setup();
            await expect(service.getControllerCapabilities(options)).rejects.toThrow();
            expect(http.request).not.toHaveBeenCalled();
            expect(evidence.getSsidDetail).not.toHaveBeenCalled();
            expect(discovery.getCatalog).not.toHaveBeenCalled();
        }
    );
});
