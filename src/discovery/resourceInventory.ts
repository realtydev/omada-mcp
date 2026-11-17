export type ResourceRow = Record<string, unknown> & { id: string };
export type ResourceRead = (path: string, params?: Record<string, unknown>) => Promise<unknown>;

function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Complete bounded inventory: malformed or repeated pages cannot prove absence. */
export async function readResourceRows(readPage: (page: number) => Promise<unknown>, aliases: string[] = []): Promise<ResourceRow[]> {
    const rows: ResourceRow[] = [],
        ids = new Set<string>();
    let total: number | undefined;
    for (let page = 1; page <= 10; page++) {
        const result = await readPage(page);
        const bare = Array.isArray(result);
        const data = bare ? result : object(result) && Array.isArray(result.data) ? result.data : undefined;
        if (!data || (bare && page !== 1)) throw new Error('Incomplete resource inventory');
        if (!bare && object(result)) {
            if (result.currentPage !== undefined && result.currentPage !== page) throw new Error('Resource page did not advance');
            if (result.totalRows !== undefined) {
                if (!Number.isSafeInteger(result.totalRows) || Number(result.totalRows) < 0 || (total !== undefined && total !== result.totalRows))
                    throw new Error('Resource count changed or is invalid');
                total = Number(result.totalRows);
            }
        }
        if (rows.length + data.length > 1000 || (total ?? 0) > 1000) throw new Error('Resource inventory exceeds 1000 records');
        for (const value of data) {
            if (!object(value)) throw new Error('Invalid resource row');
            const candidates = ['id', ...aliases].filter((key) => value[key] !== undefined).map((key) => value[key]);
            const id = candidates[0];
            if (typeof id !== 'string' || !id || candidates.some((v) => v !== id) || ids.has(id))
                throw new Error('Missing, conflicting or repeated resource identity');
            ids.add(id);
            rows.push({ ...value, id });
        }
        if (total !== undefined && rows.length > total) throw new Error('Resource count exceeded');
        if (bare || (total !== undefined && rows.length === total)) return rows;
        if (!data.length) {
            if (total !== undefined && rows.length !== total) throw new Error('Resource inventory ended early');
            return rows;
        }
    }
    throw new Error('Resource inventory exceeds ten pages');
}
