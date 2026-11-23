/**
 * Asset rows for the Index Reconstitution Desk.
 *
 * Rows used to be keyed and edited by array index. When a row was removed (or
 * a new one added), React reused the DOM/subtree at each index, and mobile
 * autofill keyed off the reused fields — which is how a second asset could
 * end up displaying the first asset's legal name and jurisdiction. Every row
 * now carries an opaque id; updates, removals and additions address that id
 * and never touch a neighbour.
 */

export interface AssetRow {
  id: string;
  symbol: string;
  company: string;
  jurisdiction: string;
  chain: string;
  pool: string;
  declaredSupply: string;
  declaredPrice: string;
  declaredVolume: string;
}

let sequence = 0;

function rowId(): string {
  const cryptoApi = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  sequence += 1;
  return `row-${Date.now().toString(36)}-${sequence}`;
}

export function createAssetRow(overrides: Partial<Omit<AssetRow, "id">> = {}): AssetRow {
  return {
    id: rowId(),
    symbol: "",
    company: "",
    jurisdiction: "",
    chain: "ethereum",
    pool: "",
    declaredSupply: "",
    declaredPrice: "",
    declaredVolume: "",
    ...overrides,
  };
}

/** Append a genuinely blank row (never a copy of an existing asset). */
export function addAssetRow(rows: AssetRow[]): AssetRow[] {
  return [...rows, createAssetRow()];
}

/** Patch one row by id; every other row is returned untouched. */
export function updateAssetRow(rows: AssetRow[], id: string, patch: Partial<Omit<AssetRow, "id">>): AssetRow[] {
  return rows.map((row) => (row.id === id ? { ...row, ...patch } : row));
}

/** Remove one row by id; the remaining rows keep their own values. */
export function removeAssetRow(rows: AssetRow[], id: string): AssetRow[] {
  return rows.filter((row) => row.id !== id);
}

/** Field names that must stay unique per row to keep browser autofill honest. */
export function rowFieldName(id: string, field: keyof Omit<AssetRow, "id">): string {
  return `ix-${id}-${field}`;
}
