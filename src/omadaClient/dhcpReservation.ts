import { isDeepStrictEqual } from 'node:util';

import axios from 'axios';

import type { OmadaApiResponse } from '../types/index.js';
import { verifyWrite, type WriteVerification } from '../utils/write-verification.js';
import type { RequestHandler } from './request.js';
import type { SiteOperations } from './site.js';

export interface DhcpReservationOption {
    code: number;
    type: 0 | 1 | 2;
    value: string;
}

export interface DhcpReservationConfig {
    mac: string;
    netId: string;
    status: boolean;
    ip?: string;
    description?: string;
    options?: DhcpReservationOption[];
    confirmConflict?: boolean;
}

export type DhcpReservationUpdate = Partial<Omit<DhcpReservationConfig, 'mac'>>;

export interface DhcpReservation extends DhcpReservationConfig {
    id?: string;
    netName?: string;
    clientName?: string;
    exportToIpMacBinding?: boolean;
    [key: string]: unknown;
}

export interface DhcpReservationChange {
    field: string;
    before: unknown;
    after: unknown;
}

export interface DhcpReservationWriteResult {
    operation: 'create' | 'update' | 'delete';
    dryRun: boolean;
    written: boolean | 'unknown';
    changes: DhcpReservationChange[];
    before?: DhcpReservation;
    after?: DhcpReservation;
    requestBody?: DhcpReservationConfig;
    verification?: Omit<WriteVerification<DhcpReservation | undefined>, 'observed'>;
    writeError?: string;
}

const WRITABLE_FIELDS = ['mac', 'netId', 'status', 'ip', 'description', 'options'] as const;

function normalizeMac(mac: string): string {
    return mac.replaceAll(':', '-').toUpperCase();
}

function sameValue(left: unknown, right: unknown): boolean {
    return isDeepStrictEqual(left, right);
}

/** DHCP reservation CRUD using the documented Open API Service endpoints. */
export class DhcpReservationOperations {
    constructor(
        private readonly request: RequestHandler,
        private readonly site: SiteOperations,
        private readonly buildPath: (path: string) => string
    ) {}

    public async listDhcpReservations(siteId?: string, searchKey?: string): Promise<DhcpReservation[]> {
        const path = this.path(siteId);
        const reservations = await this.request.fetchPaginated<DhcpReservation>(path, searchKey ? { searchKey } : {});
        const seen = new Set<string>();
        for (const reservation of reservations) {
            if (
                reservation === null ||
                typeof reservation !== 'object' ||
                Array.isArray(reservation) ||
                typeof reservation.mac !== 'string' ||
                !/^[A-Fa-f0-9][02468aAcCeE]([-:][A-Fa-f0-9]{2}){5}$/.test(reservation.mac)
            ) {
                throw new Error('DHCP reservation evidence is incomplete: the controller returned a row without a valid unicast MAC address.');
            }
            const mac = normalizeMac(reservation.mac);
            if (seen.has(mac)) {
                throw new Error('DHCP reservation evidence is incomplete: overlapping controller pages returned duplicate MAC addresses.');
            }
            seen.add(mac);
        }
        return reservations;
    }

    public async createDhcpReservation(reservation: DhcpReservationConfig, siteId?: string, dryRun = false): Promise<DhcpReservationWriteResult> {
        const body = this.writableConfig(reservation);
        if (reservation.confirmConflict !== undefined) body.confirmConflict = reservation.confirmConflict;
        const existing = await this.find(body.mac, siteId);
        if (existing) {
            throw new Error('A DHCP reservation already exists for this MAC address. Use updateDhcpReservation.');
        }
        const changes = WRITABLE_FIELDS.filter((field) => body[field] !== undefined).map((field) => ({
            field,
            before: undefined,
            after: body[field],
        }));
        if (dryRun) {
            return { operation: 'create', dryRun: true, written: false, changes, requestBody: body };
        }
        return await this.mutate('create', this.path(siteId), body.mac, body, changes, undefined, siteId);
    }

    public async updateDhcpReservation(
        mac: string,
        settings: DhcpReservationUpdate,
        siteId?: string,
        dryRun = false
    ): Promise<DhcpReservationWriteResult> {
        if (Object.keys(settings).length === 0) {
            throw new Error('At least one DHCP reservation setting must be provided.');
        }
        const normalizedMac = normalizeMac(mac);
        const before = await this.requireExisting(normalizedMac, siteId);
        const current = this.writableConfig(before);
        const body = { ...current, ...settings, mac: normalizedMac };
        const changes = WRITABLE_FIELDS.filter((field) => !sameValue(current[field], body[field])).map((field) => ({
            field,
            before: before[field],
            after: body[field],
        }));
        if (changes.length === 0) {
            return { operation: 'update', dryRun, written: false, changes, before, after: before };
        }
        if (dryRun) {
            return { operation: 'update', dryRun: true, written: false, changes, before, requestBody: body };
        }
        return await this.mutate('update', `${this.path(siteId)}/${encodeURIComponent(normalizedMac)}`, normalizedMac, body, changes, before, siteId);
    }

    public async deleteDhcpReservation(mac: string, siteId?: string, dryRun = false): Promise<DhcpReservationWriteResult> {
        const normalizedMac = normalizeMac(mac);
        const before = await this.requireExisting(normalizedMac, siteId);
        const changes = [{ field: 'reservation', before, after: undefined }];
        if (dryRun) {
            return { operation: 'delete', dryRun: true, written: false, changes, before };
        }
        return await this.mutate(
            'delete',
            `${this.path(siteId)}/${encodeURIComponent(normalizedMac)}`,
            normalizedMac,
            undefined,
            changes,
            before,
            siteId
        );
    }

    private path(siteId?: string): string {
        return this.buildPath(`/sites/${encodeURIComponent(this.site.resolveSiteId(siteId))}/setting/service/dhcp`);
    }

    private async find(mac: string, siteId?: string): Promise<DhcpReservation | undefined> {
        const reservations = await this.listDhcpReservations(siteId);
        return reservations.find((entry) => typeof entry.mac === 'string' && normalizeMac(entry.mac) === normalizeMac(mac));
    }

    private async requireExisting(mac: string, siteId?: string): Promise<DhcpReservation> {
        const reservation = await this.find(mac, siteId);
        if (!reservation) {
            throw new Error('No DHCP reservation exists for this MAC address.');
        }
        return reservation;
    }

    private writableConfig(reservation: DhcpReservationConfig): DhcpReservationConfig {
        if (typeof reservation.netId !== 'string' || !reservation.netId || typeof reservation.status !== 'boolean') {
            throw new Error('Controller reservation is missing required netId or status; refusing an incomplete update.');
        }
        const body: DhcpReservationConfig = { mac: normalizeMac(reservation.mac), netId: reservation.netId, status: reservation.status };
        if (reservation.ip !== undefined) body.ip = reservation.ip;
        if (reservation.description !== undefined) body.description = reservation.description;
        if (reservation.options !== undefined) {
            body.options = reservation.options.map(({ code, type, value }) => ({ code, type, value }));
        }
        return body;
    }

    private async mutate(
        operation: DhcpReservationWriteResult['operation'],
        path: string,
        mac: string,
        body: DhcpReservationConfig | undefined,
        changes: DhcpReservationChange[],
        before: DhcpReservation | undefined,
        siteId?: string
    ): Promise<DhcpReservationWriteResult> {
        let response: OmadaApiResponse<unknown> | undefined;
        let writeError: string | undefined;
        try {
            response = await this.request.request<OmadaApiResponse<unknown>>({
                method: operation === 'create' ? 'POST' : operation === 'update' ? 'PATCH' : 'DELETE',
                url: path,
                ...(body ? { data: body } : {}),
            });
        } catch (error) {
            // A controller rejection is definite. A lost transport response is uncertain, so only re-read state.
            if (!axios.isAxiosError(error) || error.response) {
                throw error;
            }
            writeError = error instanceof Error ? error.message : String(error);
        }
        if (response) {
            this.request.ensureSuccess(response);
        }
        const verification = await verifyWrite(
            () => this.find(mac, siteId),
            (entry) =>
                operation === 'delete'
                    ? entry === undefined
                    : entry !== undefined &&
                      WRITABLE_FIELDS.every((field) => body?.[field] === undefined || sameValue(this.writableConfig(entry)[field], body[field]))
        );
        return {
            operation,
            dryRun: false,
            written: writeError && verification.status !== 'verified' ? 'unknown' : true,
            changes,
            before,
            after: verification.observed,
            requestBody: body,
            verification: { status: verification.status, attempts: verification.attempts, message: verification.message },
            ...(writeError ? { writeError } : {}),
        };
    }
}
