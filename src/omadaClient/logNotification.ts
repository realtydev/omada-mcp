import type {
    LogNotificationChange,
    LogNotificationDiff,
    LogNotificationItem,
    OmadaApiResponse,
    SetLogNotificationsOptions,
    SetLogNotificationsResult,
} from '../types/index.js';

import type { RequestHandler } from './request.js';
import type { SiteOperations } from './site.js';

type ListName = 'alert' | 'event';

/** Shape of the v2 site log-notification GET result (and PATCH body) fields this module touches. */
interface LogNotificationState {
    webhookConfig?: unknown;
    alertNotifications?: LogNotificationItem[];
    eventNotifications?: LogNotificationItem[];
    alertEmailSetting?: unknown;
    eventEmailSetting?: unknown;
}

const LIST_FIELD: Record<ListName, 'alertNotifications' | 'eventNotifications'> = {
    alert: 'alertNotifications',
    event: 'eventNotifications',
};

const pickItem = (item: LogNotificationItem): LogNotificationItem => ({
    key: item.key,
    enable: item.enable,
    email: item.email,
    webhook: item.webhook,
});

const values = (item: LogNotificationItem): Omit<LogNotificationItem, 'key'> => ({
    enable: item.enable,
    email: item.email,
    webhook: item.webhook,
});

const sameValues = (a: Omit<LogNotificationItem, 'key'>, b: Omit<LogNotificationItem, 'key'>): boolean =>
    a.enable === b.enable && a.email === b.email && a.webhook === b.webhook;

/**
 * Site log-notification operations (v2 API): which alert/event types are enabled and mailed.
 */
export class LogNotificationOperations {
    constructor(
        private readonly request: RequestHandler,
        private readonly site: SiteOperations,
        private readonly buildPath: (path: string, version?: string) => string
    ) {}

    /**
     * Turn individual alert/event notification entries on or off for a site.
     *
     * Reads the current state, applies only the named keys, and PATCHes the complete state back
     * (both lists plus the webhook and email settings exactly as read, since the spec marks few
     * fields required but does not say whether omitted lists or settings are kept), then re-reads
     * and verifies that exactly the requested entries changed. Unknown keys are rejected before
     * anything is sent, and `dryRun` returns the diff without writing.
     */
    public async setLogNotifications(options: SetLogNotificationsOptions): Promise<SetLogNotificationsResult> {
        const requests: Record<ListName, LogNotificationChange[]> = { event: options.events ?? [], alert: options.alerts ?? [] };
        if (requests.event.length === 0 && requests.alert.length === 0) {
            throw new Error('At least one entry in events or alerts must be provided.');
        }

        const path = this.buildPath(`/sites/${encodeURIComponent(this.site.resolveSiteId(options.siteId))}/site/log-notification`, 'v2');
        const before = await this.read(path);

        const changes: LogNotificationDiff[] = [];
        const unchanged: SetLogNotificationsResult['unchanged'] = [];
        const next: Record<ListName, LogNotificationItem[]> = {
            alert: (before.alertNotifications ?? []).map(pickItem),
            event: (before.eventNotifications ?? []).map(pickItem),
        };
        const unknown: string[] = [];

        for (const list of ['event', 'alert'] as const) {
            const seen = new Set<string>();
            for (const change of requests[list]) {
                if (seen.has(change.key)) {
                    throw new Error(`Duplicate key ${change.key} in ${LIST_FIELD[list]}.`);
                }
                seen.add(change.key);

                const item = next[list].find((entry) => entry.key === change.key);
                if (item === undefined) {
                    unknown.push(`${change.key} (${LIST_FIELD[list]})`);
                    continue;
                }
                const beforeValues = values(item);
                item.enable = change.enable;
                item.email = change.email ?? item.email;
                item.webhook = change.webhook ?? item.webhook;
                if (sameValues(beforeValues, values(item))) {
                    unchanged.push({ list, key: change.key });
                } else {
                    changes.push({ list, key: change.key, before: beforeValues, after: values(item) });
                }
            }
        }
        if (unknown.length > 0) {
            throw new Error(`Unknown log notification key(s), nothing was sent: ${unknown.join(', ')}.`);
        }

        if (options.dryRun || changes.length === 0) {
            return { dryRun: options.dryRun === true, written: false, changes, unchanged };
        }

        const body: LogNotificationState = { ...before, alertNotifications: next.alert, eventNotifications: next.event };
        const response = await this.request.request<OmadaApiResponse<unknown>>({ method: 'PATCH', url: path, data: body });
        this.request.ensureSuccess(response);

        const after = await this.read(path);
        return { dryRun: false, written: true, changes, unchanged, verification: LogNotificationOperations.verify(before, after, changes) };
    }

    private async read(path: string): Promise<LogNotificationState> {
        const response = await this.request.get<OmadaApiResponse<LogNotificationState>>(path);
        return this.request.ensureSuccess(response);
    }

    /**
     * Compare a pre-write and post-write state: every requested change must be present and nothing else may differ.
     */
    private static verify(
        before: LogNotificationState,
        after: LogNotificationState,
        changes: LogNotificationDiff[]
    ): NonNullable<SetLogNotificationsResult['verification']> {
        const unexpectedChanges: string[] = [];
        const missingChanges: string[] = [];

        for (const list of ['event', 'alert'] as const) {
            const field = LIST_FIELD[list];
            const beforeItems = before[field] ?? [];
            const afterItems = after[field] ?? [];
            const expected = new Map(changes.filter((c) => c.list === list).map((c) => [c.key, c.after]));

            for (const item of beforeItems) {
                const now = afterItems.find((entry) => entry.key === item.key);
                const want = expected.get(item.key);
                if (now === undefined) {
                    unexpectedChanges.push(`${field}:${item.key} missing after write`);
                } else if (want !== undefined) {
                    if (!sameValues(values(now), want)) {
                        missingChanges.push(`${field}:${item.key}`);
                    }
                } else if (!sameValues(values(now), values(item))) {
                    unexpectedChanges.push(`${field}:${item.key}`);
                }
            }
            if (afterItems.length !== beforeItems.length) {
                unexpectedChanges.push(`${field} length ${beforeItems.length} -> ${afterItems.length}`);
            }
        }
        for (const setting of ['webhookConfig', 'alertEmailSetting', 'eventEmailSetting'] as const) {
            if (JSON.stringify(before[setting]) !== JSON.stringify(after[setting])) {
                unexpectedChanges.push(setting);
            }
        }

        return { ok: unexpectedChanges.length === 0 && missingChanges.length === 0, unexpectedChanges, missingChanges };
    }
}
