import type { OmadaApiResponse } from '../types/index.js';
import {
    normalizeMac,
    portNumber,
    type SwitchPortField,
    type SwitchPortOutcome,
    type SwitchPortState,
    type SwitchWriteOptions,
    type SwitchWriteResult,
    switchPortListSchema,
    switchPortNameSchema,
    switchSnapshot,
    switchWriteOptionsSchema,
    validateSwitchMac,
} from '../utils/switch-port-safety.js';
import { verifyWrite } from '../utils/write-verification.js';

import type { RequestHandler } from './request.js';
import type { SiteOperations } from './site.js';

interface SwitchPortTelemetry {
    switchMac?: string;
    [key: string]: unknown;
}

/**
 * Switch port and cable test operations for the Omada API.
 * Covers single-port config, batch operations, cable tests, and switch networks.
 */
export class SwitchOperations {
    constructor(
        private readonly request: RequestHandler,
        private readonly site: SiteOperations,
        private readonly buildPath: (path: string, version?: string) => string
    ) {}

    /**
     * Get full switch info including portList array (v1 API).
     */
    public async getSwitch(switchMac: string, siteId?: string): Promise<unknown> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/switches/${encodeURIComponent(switchMac)}`);
        const response = await this.request.get<OmadaApiResponse<unknown>>(path);
        return this.request.ensureSuccess(response);
    }

    /**
     * List site-wide switch port telemetry, optionally filtered by switch MAC.
     *
     * Unlike the per-switch detail endpoint, this endpoint supports Omada
     * Agile Series switches and includes live link, traffic, STP, LLDP and PoE
     * fields. Omada requires pagination parameters, supplied by fetchPaginated.
     */
    public async listSwitchPorts(switchMac?: string, siteId?: string): Promise<SwitchPortTelemetry[]> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/switches/ports/poe-info`);
        const ports = await this.request.fetchPaginated<SwitchPortTelemetry>(path);

        if (!switchMac) {
            return ports;
        }

        const normalizedMac = normalizeMac(switchMac);
        return ports.filter((port) => typeof port.switchMac === 'string' && normalizeMac(port.switchMac) === normalizedMac);
    }

    public async setSwitchPortProfile(
        switchMac: string,
        port: number,
        profileId: string,
        siteId?: string,
        options?: SwitchWriteOptions
    ): Promise<SwitchWriteResult> {
        return await this.writePorts(switchMac, [{ port, value: profileId }], 'profileId', 'profile', siteId, options);
    }

    public async setSwitchPortPoe(
        switchMac: string,
        port: number,
        poeMode: number,
        siteId?: string,
        options?: SwitchWriteOptions
    ): Promise<SwitchWriteResult> {
        return await this.writePorts(switchMac, [{ port, value: poeMode }], 'poeMode', 'poe-mode', siteId, options);
    }

    public async setSwitchPortName(
        switchMac: string,
        port: number,
        name: string,
        siteId?: string,
        options?: SwitchWriteOptions
    ): Promise<SwitchWriteResult> {
        return await this.writePorts(switchMac, [{ port, value: name }], 'name', 'name', siteId, options);
    }

    public async setSwitchPortStatus(
        switchMac: string,
        port: number,
        status: number,
        siteId?: string,
        options?: SwitchWriteOptions
    ): Promise<SwitchWriteResult> {
        return await this.writePorts(switchMac, [{ port, value: status }], 'status', 'status', siteId, options);
    }

    public async setSwitchPortProfileOverride(
        switchMac: string,
        port: number,
        profileOverrideEnable: boolean,
        siteId?: string,
        options?: SwitchWriteOptions
    ): Promise<SwitchWriteResult> {
        return await this.writePorts(
            switchMac,
            [{ port, value: profileOverrideEnable }],
            'profileOverrideEnable',
            'profile-override',
            siteId,
            options
        );
    }

    public async batchSetSwitchPortProfile(
        switchMac: string,
        portList: number[],
        profileOverrideEnable: boolean,
        siteId?: string,
        options?: SwitchWriteOptions
    ): Promise<SwitchWriteResult> {
        return await this.writePorts(
            switchMac,
            portList.map((port) => ({ port, value: profileOverrideEnable })),
            'profileOverrideEnable',
            'profile-override',
            siteId,
            options,
            true
        );
    }

    public async batchSetSwitchPortPoe(
        switchMac: string,
        portList: number[],
        poeMode: number,
        siteId?: string,
        options?: SwitchWriteOptions
    ): Promise<SwitchWriteResult> {
        return await this.writePorts(
            switchMac,
            portList.map((port) => ({ port, value: poeMode })),
            'poeMode',
            'poe-mode',
            siteId,
            options,
            true
        );
    }

    public async batchSetSwitchPortStatus(
        switchMac: string,
        portList: number[],
        status: number,
        siteId?: string,
        options?: SwitchWriteOptions
    ): Promise<SwitchWriteResult> {
        return await this.writePorts(
            switchMac,
            portList.map((port) => ({ port, value: status })),
            'status',
            'status',
            siteId,
            options,
            true
        );
    }

    public async batchSetSwitchPortName(
        switchMac: string,
        portNameList: Array<{ port: number; name: string }>,
        siteId?: string,
        options?: SwitchWriteOptions
    ): Promise<SwitchWriteResult> {
        return await this.writePorts(
            switchMac,
            portNameList.map(({ port, name }) => ({ port, value: name })),
            'name',
            'name',
            siteId,
            options,
            true
        );
    }

    /** The bundled API defines narrow setting endpoints, not a generic port PATCH. */
    public async updateSwitchPort(
        switchMac: string,
        portId: string,
        data: Record<string, unknown>,
        siteId?: string,
        options?: SwitchWriteOptions
    ): Promise<SwitchWriteResult> {
        const keys = Object.keys(data);
        if (keys.length !== 1 || !['profileId', 'poe'].includes(keys[0]))
            throw new Error(
                'updateSwitchPort supports one profileId or poe setting per call. Other fields and combined updates have no verified Open API contract; use the dedicated port tools.'
            );
        const port = portNumber(portId);
        if (port === undefined) throw new Error('portId must identify a positive physical port number.');
        if (keys[0] === 'profileId') {
            if (typeof data.profileId !== 'string') throw new Error('profileId must be a non-empty string.');
            return await this.setSwitchPortProfile(switchMac, port, data.profileId, siteId, options);
        }
        if (typeof data.poe !== 'boolean') throw new Error('poe must be a boolean.');
        return await this.setSwitchPortPoe(switchMac, port, data.poe ? 1 : 0, siteId, options);
    }

    private async writePorts(
        switchMac: string,
        targets: Array<{ port: number; value: string | number | boolean }>,
        field: SwitchPortField,
        endpoint: string,
        siteId?: string,
        options: SwitchWriteOptions = {},
        batch = false
    ): Promise<SwitchWriteResult> {
        validateSwitchMac(switchMac);
        const policy = switchWriteOptionsSchema.parse(options);
        switchPortListSchema.parse(targets.map(({ port }) => port));
        for (const { value } of targets) {
            if (field === 'name') switchPortNameSchema.parse(value);
            else if (field === 'profileId' && (typeof value !== 'string' || !value.trim())) throw new Error('profileId must be a non-empty string.');
            else if (field === 'profileOverrideEnable' && typeof value !== 'boolean') throw new Error('profileOverrideEnable must be a boolean.');
            else if ((field === 'status' || field === 'poeMode') && value !== 0 && value !== 1) throw new Error(`${field} must be 0 or 1.`);
        }
        const read = async () => switchSnapshot(await this.getSwitch(switchMac, siteId), switchMac);
        const readTelemetry = async () => {
            try {
                return await this.listSwitchPorts(switchMac, siteId);
            } catch {
                return undefined;
            }
        };
        const before = await read();
        const telemetry = await readTelemetry();
        const plan = (states: Map<number, SwitchPortState>, telemetry: SwitchPortTelemetry[] | undefined) =>
            targets.map(({ port, value }): SwitchPortOutcome => {
                const state = states.get(port);
                if (!state) throw new Error(`Port ${port} was not returned by the switch detail; no ports were written.`);
                const rows = telemetry?.filter((row) => portNumber(row.port) === port);
                const metadata = rows?.length === 1 ? rows[0] : undefined;
                const lag = state.lagPort ?? 'unknown';
                const stack =
                    state.configStack === true || metadata?.configStack === true
                        ? true
                        : typeof metadata?.configStack === 'boolean'
                          ? metadata.configStack
                          : (state.configStack ?? 'unknown');
                const uplink = state.uplinkPort ?? 'unknown';
                const mlag =
                    metadata?.configMlagPeerLink === true || metadata?.configMlagDad === true
                        ? true
                        : metadata?.configMlagPeerLink === false && metadata?.configMlagDad === false
                          ? false
                          : 'unknown';
                const changes = state[field] === value ? [] : [{ field, before: state[field], after: value }];
                const blockers: string[] = [];
                if (
                    changes.length &&
                    field !== 'name' &&
                    !policy.allowDisruption &&
                    (lag === true || stack === true || uplink === true || mlag === true)
                )
                    blockers.push('Observed LAG, uplink, stack or MLAG membership requires allowDisruption=true.');
                if (changes.length && field === 'status' && lag === true) blockers.push('The status endpoint only supports non-LAG ports.');
                if (field === 'poeMode') {
                    if (metadata?.supportPoe !== true)
                        blockers.push(
                            metadata?.supportPoe === false
                                ? 'This port explicitly does not support PoE.'
                                : 'PoE support could not be established from port telemetry.'
                        );
                    if (state.profileOverrideEnable !== true)
                        blockers.push('PoE changes require profileOverrideEnable=true; enable and verify it separately first.');
                }
                return {
                    port,
                    changes,
                    risk: { lag, uplink, stack, mlag },
                    blockers,
                    verification: {
                        status: changes.length || blockers.length ? 'not-run' : 'verified',
                        attempts: 0,
                        mismatchedFields: [],
                        unexpectedChanges: [],
                    },
                };
            });
        const outcomes = plan(before, telemetry);
        const warnings = [
            'Uplink/stack membership and PoE support may be unavailable. Unknown evidence is not a safe-port assertion; port names and live link state are not configuration evidence. Verification compares configured fields, not live link health or delivered PoE power.',
        ];
        if (field === 'profileId' || field === 'profileOverrideEnable')
            warnings.push(
                'Profile changes may alter inherited port settings; verification covers the requested field and stable identity/name, not unknown profile effects.'
            );
        const pending = outcomes.filter((outcome) => outcome.changes.length);
        const canApply = outcomes.every((outcome) => outcome.blockers.length === 0);
        if (policy.dryRun || !pending.length) {
            if (!policy.dryRun && !canApply)
                throw new Error(outcomes.flatMap((outcome) => outcome.blockers.map((blocker) => `Port ${outcome.port}: ${blocker}`)).join(' '));
            return {
                dryRun: policy.dryRun === true,
                written: false,
                acknowledged: false,
                verificationScope: 'configured_port_fields',
                canApply,
                ports: outcomes,
                warnings,
            };
        }
        if (!canApply)
            throw new Error(outcomes.flatMap((outcome) => outcome.blockers.map((blocker) => `Port ${outcome.port}: ${blocker}`)).join(' '));
        const fresh = await read();
        const freshPlan = plan(fresh, await readTelemetry());
        if (freshPlan.some((outcome) => outcome.blockers.length))
            throw new Error('Port safety prerequisites changed during preflight; no ports were written.');
        for (const { port } of targets) {
            if (JSON.stringify(before.get(port)) !== JSON.stringify(fresh.get(port)))
                throw new Error(`Port ${port} configuration changed during preflight; no ports were written.`);
        }
        for (let index = 0; index < outcomes.length; index += 1) outcomes[index].risk = freshPlan[index].risk;
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const suffix = batch ? `multi-ports/${endpoint}` : `ports/${pending[0].port}/${endpoint}`;
        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/switches/${encodeURIComponent(switchMac)}/${suffix}`);
        const data = batch
            ? field === 'name'
                ? { portNameList: pending.map((outcome) => ({ port: outcome.port, name: outcome.changes[0].after })) }
                : { portList: pending.map((outcome) => outcome.port), [field]: pending[0].changes[0].after }
            : { [field]: pending[0].changes[0].after };
        let acknowledged = false;
        try {
            const response = await this.request.request<OmadaApiResponse<unknown>>({ method: 'PUT', url: path, data }, false);
            if (typeof response?.errorCode === 'number' && response.errorCode !== 0) throw new PortWriteRejected(response.errorCode);
            acknowledged = response?.errorCode === 0;
        } catch (error) {
            if (error instanceof PortWriteRejected)
                throw new Error(`Switch port update rejected (errorCode: ${error.code}); no automatic retry was made.`);
            // Lost acknowledgement is reconciled with reads; never replay a port mutation.
        }
        let attempts = 0;
        const verification = await verifyWrite(
            () => {
                attempts += 1;
                return read();
            },
            (observed) => {
                let allMatch = true;
                for (const outcome of pending) {
                    const wanted = outcome.changes[0];
                    const state = observed.get(outcome.port);
                    const original = before.get(outcome.port) as SwitchPortState;
                    const preserved = (Object.keys(original) as Array<keyof SwitchPortState>).filter(
                        (key) =>
                            key !== field &&
                            key !== 'port' &&
                            !(
                                (field === 'profileId' || field === 'profileOverrideEnable') &&
                                ['status', 'poeMode', 'profileOverrideEnable'].includes(key)
                            )
                    );
                    const missing = state?.[field] === undefined || preserved.some((key) => state?.[key] === undefined);
                    const mismatchedFields = state?.[field] !== undefined && state[field] !== wanted.after ? [field] : [];
                    const unexpectedChanges = preserved.filter((key) => state?.[key] !== undefined && state[key] !== original[key]);
                    const status = mismatchedFields.length || unexpectedChanges.length ? 'mismatch' : missing ? 'unknown' : 'verified';
                    outcome.verification = { status, attempts, mismatchedFields, unexpectedChanges };
                    if (status !== 'verified') allMatch = false;
                }
                return allMatch;
            }
        );
        // If every read failed, preserve explicit unknown outcomes rather than the initial plan status.
        for (const outcome of pending) {
            if (outcome.verification.status === 'not-run' || (verification.status === 'unknown' && outcome.verification.status !== 'verified'))
                outcome.verification = { ...outcome.verification, status: 'unknown', attempts: verification.attempts };
        }
        return {
            dryRun: false,
            written: acknowledged ? true : 'unknown',
            acknowledged,
            verificationScope: 'configured_port_fields',
            canApply: true,
            ports: outcomes,
            warnings,
        };
    }

    /**
     * Start a cable test on a switch (v1 API).
     */
    public async startCableTest(switchMac: string, siteId?: string): Promise<unknown> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/cable-test/switches/${encodeURIComponent(switchMac)}/start`);
        const response = await this.request.post<OmadaApiResponse<unknown>>(path, {});
        return this.request.ensureSuccess(response);
    }

    /**
     * Get cable test results for a switch (v1 API).
     */
    public async getCableTestResults(switchMac: string, siteId?: string): Promise<unknown> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/cable-test/switches/${encodeURIComponent(switchMac)}/full-results`);
        const response = await this.request.get<OmadaApiResponse<unknown>>(path);
        return this.request.ensureSuccess(response);
    }

    /**
     * Get switch networks / VLAN trunking config (v1 API). `page`/`pageSize` are required by
     * this endpoint even though the OpenAPI spec doesn't say so explicitly (an unparameterized
     * GET returns HTTP 400) — `fetchPaginated` supplies them and loops until all VLANs are read.
     */
    public async getSwitchNetworks(switchMac: string, siteId?: string): Promise<unknown[]> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/switches/${encodeURIComponent(switchMac)}/networks`);
        return await this.request.fetchPaginated<unknown>(path);
    }

    /**
     * Set switch networks / VLAN trunking config (v1 API).
     */
    public async setSwitchNetworks(switchMac: string, data: Record<string, unknown>, siteId?: string): Promise<unknown> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/switches/${encodeURIComponent(switchMac)}/networks`);
        const response = await this.request.post<OmadaApiResponse<unknown>>(path, data);
        return this.request.ensureSuccess(response);
    }
}

class PortWriteRejected extends Error {
    constructor(public readonly code: number) {
        super('Controller rejected the port update');
    }
}
