/**
 * One entry in a site's alert or event notification list (v2 log-notification API).
 */
export interface LogNotificationItem {
    key: string;
    enable: boolean;
    email: boolean;
    webhook: boolean;
}

/**
 * Requested change to one notification entry. `email` and `webhook` keep their current value when omitted.
 */
export interface LogNotificationChange {
    key: string;
    enable: boolean;
    email?: boolean;
    webhook?: boolean;
}

export interface SetLogNotificationsOptions {
    siteId?: string;

    /** Changes to entries in `eventNotifications` */
    events?: LogNotificationChange[];

    /** Changes to entries in `alertNotifications` */
    alerts?: LogNotificationChange[];

    /** Compute and return the diff without writing anything */
    dryRun?: boolean;
}

export interface LogNotificationDiff {
    list: 'alert' | 'event';
    key: string;
    before: Omit<LogNotificationItem, 'key'>;
    after: Omit<LogNotificationItem, 'key'>;
}

export interface SetLogNotificationsResult {
    dryRun: boolean;

    /** True only when a PATCH was actually sent */
    written: boolean;

    /** Entries whose enable/email/webhook value changes (or changed) */
    changes: LogNotificationDiff[];

    /** Requested entries that already had the requested values */
    unchanged: { list: 'alert' | 'event'; key: string }[];

    /** Present after a write: whether a re-read showed exactly the intended changes and nothing else */
    verification?: {
        ok: boolean;
        /** Entries or settings that differ from the pre-write state but were not requested */
        unexpectedChanges: string[];
        /** Requested entries that do not show the requested values after the write */
        missingChanges: string[];
    };
}
