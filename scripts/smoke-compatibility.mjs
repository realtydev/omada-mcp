import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { installReadOnlyGuard } from './read-only-guard.mjs';

const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let guard;
const observers = [];
let originalCreate;
let axios;
const errors = [];
try {
    const { values } = parseArgs({ options: { expect: { type: 'string', multiple: true }, help: { type: 'boolean' } } });
    if (values.help) {
        process.stdout.write(
            'Read-only controller compatibility qualification. Run yarn build first.\nUse OMADA_ENV_FILE=/private/controller.env yarn smoke:compatibility --expect classic|msp|fusion|openapi31. Repeat --expect for multiple surfaces.\nExit 0: requested checks passed; 1: validation/request failure; 2: required hardware or live specification unavailable. Output omits identifiers, URLs, credentials and response bodies. Fusion expiry recovery still requires real expired-session evidence.\n'
        );
        process.exit(0);
    }
    const expected = values.expect ?? [];
    if (expected.some((value) => !['classic', 'msp', 'fusion', 'openapi31'].includes(value))) throw new Error('invalid_expectation');
    if (!existsSync(resolve(root, 'dist/omadaClient/index.js'))) throw new Error('build_required');
    await import(pathToFileURL(resolve(root, 'dist/env.js')).href);
    const { initLogger } = await import(pathToFileURL(resolve(root, 'dist/utils/logger.js')).href);
    initLogger('silent');
    const { loadConfigFromEnv } = await import(pathToFileURL(resolve(root, 'dist/config.js')).href);
    const { OmadaClient } = await import(pathToFileURL(resolve(root, 'dist/omadaClient/index.js')).href);
    ({ default: axios } = await import('axios'));
    const config = loadConfigFromEnv({ ...process.env, MCP_TOOL_PROFILE: 'read-only', OMADA_TIMEOUT: '10000' });
    const observe = (response) => {
        const code = response?.data?.errorCode;
        if (errors.length < 10 && (response?.status >= 400 || (Number.isSafeInteger(code) && code !== 0))) {
            errors.push({ httpStatus: response.status, ...(Number.isSafeInteger(code) ? { controllerErrorCode: code } : {}) });
        }
    };
    guard = installReadOnlyGuard(axios, config);
    originalCreate = axios.create;
    axios.create = function (...args) {
        const instance = originalCreate.apply(axios, args);
        const id = instance.interceptors.response.use(
            (response) => {
                observe(response);
                return response;
            },
            (error) => {
                observe(error.response);
                return Promise.reject(error);
            }
        );
        observers.push({ instance, id });
        return instance;
    };
    const api = new OmadaClient(config);
    const capabilities = await api.getControllerCapabilities();
    const search = await api.searchApiOperations({ query: 'site list', method: 'GET', limit: 50 });
    const normal = search.operations.find((op) => op.path === '/openapi/v1/{omadacId}/sites');
    const msp = search.operations.find((op) => /^\/openapi\/v[12]\/msp\/\{mspId\}\/sites$/.test(op.path));
    const checks = {
        classic: { status: 'not_tested', reason: 'classic_mode_not_observed' },
        msp: { status: 'not_tested', reason: 'msp_not_configured' },
        fusion: { status: 'not_tested', reason: 'web_auth_not_configured' },
        openapi31: { status: 'not_tested', reason: 'live_3_1_specification_unavailable' },
        expiredFusionSession: { status: 'not_tested', reason: 'real_expired_session_response_required' },
    };
    let normalRead = false;
    let mspRead = false;
    if (normal && (!config.mspId || expected.includes('classic') || expected.includes('fusion'))) {
        const result = await api.executeApiOperation({ operationId: normal.operationId });
        if (result.written !== false || result.dryRun !== false) throw new Error('read_contract_failed');
        normalRead = true;
        if (capabilities.controller.mode === 'classic') checks.classic = { status: 'pass' };
        if (config.authMode === 'web' && expected.includes('fusion'))
            checks.fusion = { status: 'pass', scope: 'operator_identified_fusion_web_auth_read', expiredSessionRecovery: 'not_tested' };
    }
    if (config.mspId) {
        if (!msp) checks.msp = { status: 'not_tested', reason: 'msp_site_operation_unavailable' };
        else {
            const result = await api.executeApiOperation({ operationId: msp.operationId });
            if (result.written !== false || result.dryRun !== false) throw new Error('read_contract_failed');
            mspRead = true;
            checks.msp = { status: 'pass', scope: 'configured_msp_site_read' };
        }
    }
    if (capabilities.catalog.source === 'live' && /^3\.1(?:\.|$)/.test(capabilities.catalog.openapiVersion) && (normalRead || mspRead)) {
        checks.openapi31 = { status: 'pass', scope: 'live_schema_validated_site_read' };
    }
    const missing = expected.filter((name) => checks[name].status !== 'pass');
    emit({
        checks,
        source: search.source,
        observations: { controllerMode: capabilities.controller.mode ?? 'unknown', authenticationMode: config.authMode, errors },
        requests: guard.counts,
        requiredMissing: missing,
    });
    process.exitCode = guard.counts.blocked ? 1 : missing.length || (!normalRead && !mspRead) ? 2 : 0;
} catch {
    emit({
        status: 'failed',
        reason: 'configuration_build_or_read_validation_failed',
        observations: { errors },
        ...(guard ? { requests: guard.counts } : {}),
    });
    process.exitCode = 1;
} finally {
    if (axios && originalCreate) axios.create = originalCreate;
    for (const { instance, id } of observers) instance.interceptors.response.eject(id);
    guard?.restore();
}
