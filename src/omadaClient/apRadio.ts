import type { ApRadioBand, ApRadioChange, ApRadioField, ApRadioSettings, OmadaApiResponse, SetApRadioResult } from '../types/index.js';

import type { RequestHandler } from './request.js';
import type { SiteOperations } from './site.js';

type RadioBand = Record<string, unknown>;
type RadioConfig = Record<string, RadioBand | undefined>;

interface AvailableChannelRadio {
    radioId?: number;
    apChannelDetailList?: { channel?: number; freq?: number; index?: number }[];
}

const BAND_KEYS: Record<ApRadioBand, string> = {
    '2g': 'radioSetting2g',
    '5g': 'radioSetting5g',
    '5g2': 'radioSetting5g2',
    '6g': 'radioSetting6g',
};

/** `radioId` values used by the available-channel endpoint. */
const BAND_RADIO_IDS: Record<ApRadioBand, number> = { '2g': 0, '5g': 1, '5g2': 2, '6g': 3 };

/** Band fields the PATCH schema accepts. The GET also returns others (e.g. autoSwitchOffWifi) that are not sent back. */
const WRITABLE_FIELDS = ['radioEnable', 'channelRange', 'channelWidth', 'channel', 'txPower', 'txPowerLevel', 'freq', 'wirelessMode'] as const;

const REQUESTABLE_FIELDS: ApRadioField[] = ['radioEnable', 'channel', 'channelWidth', 'txPowerLevel', 'txPower'];

const VERIFY_ATTEMPTS = 3;
const VERIFY_DELAY_MS = 2000;

/**
 * AP radio operations (v1 API).
 */
export class ApRadioOperations {
    constructor(
        private readonly request: RequestHandler,
        private readonly site: SiteOperations,
        private readonly buildPath: (path: string) => string
    ) {}

    /**
     * Change one radio band of an AP via `PATCH /aps/{apMac}/radio-config`, then verify it stuck.
     *
     * Reads the current radio-config, overlays the requested fields on the band's current writable
     * fields and PATCHes that complete band object (the spec marks every field optional but does not
     * say whether omitted ones keep their value; a partial body was accepted with errorCode 0 yet not
     * applied on at least one EAP245). It then re-reads radio-config and throws if a requested field
     * did not take, so a controller that answers "success" without applying is not reported as done.
     *
     * `channel` is the channel INDEX from the available-channel list (0 = auto), not the channel
     * number: on a 5 GHz radio index 1 is typically channel 36. It is validated against that list and
     * `freq` is set to match, since the API corrects `channel` from `freq` when they disagree.
     * `channelWidth` is a code (2=20MHz, 3=40MHz, 4=2.4G auto, 5=80MHz, 6=5G auto, 7=160MHz,
     * 8=160/80/40/20, 9=240MHz, 10=320MHz). `txPower` needs `txPowerLevel` 3 (custom), set implicitly.
     * Reconfiguring a radio can drop every client on that band. With `dryRun`, nothing is written.
     */
    public async setApRadio(apMac: string, band: ApRadioBand, settings: ApRadioSettings, siteId?: string, dryRun = false): Promise<SetApRadioResult> {
        const requested = ApRadioOperations.buildRequested(settings);

        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const base = `/sites/${encodeURIComponent(resolvedSiteId)}/aps/${encodeURIComponent(apMac)}`;
        const configPath = this.buildPath(`${base}/radio-config`);
        const bandKey = BAND_KEYS[band];

        const before = await this.readConfig(configPath);
        const current = before[bandKey];
        if (current === undefined) {
            const present = Object.keys(before).filter((key) => key.startsWith('radioSetting'));
            throw new Error(`AP ${apMac} has no ${band} radio (radio-config has: ${present.join(', ') || 'none'}).`);
        }

        const derived: RadioBand = {};
        if (requested.channel !== undefined && requested.channel !== '0') {
            derived.freq = await this.resolveFreq(`${base}/available-channel`, apMac, band, requested.channel);
        }

        const merged: RadioBand = {};
        for (const field of WRITABLE_FIELDS) {
            if (current[field] !== undefined) {
                merged[field] = current[field];
            }
        }
        Object.assign(merged, requested, derived);
        if (requested.channel === '0') {
            // Auto channel: a stale freq would make the controller correct the channel back from it.
            delete merged.freq;
        }

        const changes: ApRadioChange[] = REQUESTABLE_FIELDS.filter(
            (field) => requested[field] !== undefined && requested[field] !== current[field]
        ).map((field) => ({ field, before: current[field], after: requested[field] }));
        if (changes.length === 0) {
            return { dryRun, written: false, band, changes };
        }
        if (dryRun) {
            return { dryRun: true, written: false, band, changes, requestBody: { [bandKey]: merged } };
        }

        const response = await this.request.request<OmadaApiResponse<unknown>>({ method: 'PATCH', url: configPath, data: { [bandKey]: merged } });
        this.request.ensureSuccess(response);

        let after: RadioConfig = before;
        let notApplied: ApRadioChange[] = changes;
        for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt++) {
            after = await this.readConfig(configPath);
            notApplied = changes.filter((change) => after[bandKey]?.[change.field] !== change.after);
            if (notApplied.length === 0) {
                break;
            }
            if (attempt < VERIFY_ATTEMPTS) {
                await new Promise((resolve) => setTimeout(resolve, VERIFY_DELAY_MS));
            }
        }

        const result: SetApRadioResult = {
            dryRun: false,
            written: true,
            band,
            changes: changes.map((change) => ({ ...change, after: after[bandKey]?.[change.field] })),
            verification: { ok: false, unexpectedChanges: ApRadioOperations.unexpectedChanges(before, after, bandKey, changes) },
        };
        if (notApplied.length > 0) {
            const detail = notApplied.map(
                (change) =>
                    `${change.field}: requested ${JSON.stringify(change.after)}, controller kept ${JSON.stringify(after[bandKey]?.[change.field])}`
            );
            throw new Error(
                `The controller accepted the ${band} radio-config PATCH for ${apMac} (errorCode 0) but did not apply: ${detail.join('; ')}. ` +
                    `The value may be outside what this AP, region or channel allows. Result: ${JSON.stringify(result)}`
            );
        }
        result.verification = {
            ok: result.verification?.unexpectedChanges.length === 0,
            unexpectedChanges: result.verification?.unexpectedChanges ?? [],
        };
        return result;
    }

    private static buildRequested(settings: ApRadioSettings): Partial<Record<ApRadioField, unknown>> & { channel?: string; channelWidth?: string } {
        const requested: Partial<Record<ApRadioField, unknown>> & { channel?: string; channelWidth?: string } = {};
        if (settings.radioEnable !== undefined) {
            requested.radioEnable = settings.radioEnable;
        }
        if (settings.channel !== undefined) {
            requested.channel = String(settings.channel);
        }
        if (settings.channelWidth !== undefined) {
            requested.channelWidth = String(settings.channelWidth);
        }
        if (settings.txPowerLevel !== undefined) {
            requested.txPowerLevel = settings.txPowerLevel;
        }
        if (settings.txPower !== undefined) {
            if (settings.txPowerLevel !== undefined && settings.txPowerLevel !== 3) {
                throw new Error('txPower can only be set with txPowerLevel 3 (custom); omit txPowerLevel or use 3.');
            }
            requested.txPower = settings.txPower;
            requested.txPowerLevel = 3;
        }
        if (Object.keys(requested).length === 0) {
            throw new Error('At least one radio setting (radioEnable, channel, channelWidth, txPowerLevel, txPower) must be provided.');
        }
        return requested;
    }

    private async readConfig(path: string): Promise<RadioConfig> {
        const response = await this.request.get<OmadaApiResponse<RadioConfig>>(path);
        return this.request.ensureSuccess(response);
    }

    /**
     * Look up the frequency for a channel index in the AP's available-channel list, rejecting indexes that are not listed.
     */
    private async resolveFreq(relativePath: string, apMac: string, band: ApRadioBand, channelIndex: string): Promise<number> {
        const response = await this.request.get<OmadaApiResponse<AvailableChannelRadio[]>>(this.buildPath(relativePath));
        const radio = this.request.ensureSuccess(response).find((entry) => entry.radioId === BAND_RADIO_IDS[band]);
        const channels = radio?.apChannelDetailList ?? [];
        const match = channels.find((entry) => String(entry.index) === channelIndex);
        if (match?.freq === undefined) {
            const valid = channels.map((entry) => `${entry.index} (channel ${entry.channel}, ${entry.freq} MHz)`).join(', ');
            throw new Error(
                `Channel index ${channelIndex} is not available on the ${band} radio of ${apMac}. \`channel\` is the channel INDEX, not the channel number. Available: ${valid || 'none'}.`
            );
        }
        return match.freq;
    }

    /**
     * Everything that differs between two reads other than the requested fields and `freq` (which follows `channel`).
     */
    private static unexpectedChanges(before: RadioConfig, after: RadioConfig, bandKey: string, changes: ApRadioChange[]): string[] {
        const unexpected: string[] = [];
        const requestedFields = new Set<string>([...changes.map((change) => change.field), 'freq']);
        const beforeBand = before[bandKey] ?? {};
        const afterBand = after[bandKey] ?? {};
        for (const field of new Set([...Object.keys(beforeBand), ...Object.keys(afterBand)])) {
            if (!requestedFields.has(field) && JSON.stringify(beforeBand[field]) !== JSON.stringify(afterBand[field])) {
                unexpected.push(`${bandKey}.${field}`);
            }
        }
        for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
            if (key !== bandKey && JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
                unexpected.push(key);
            }
        }
        return unexpected;
    }
}
