import { describe, expect, it } from "vitest";

import {
  addAssetRow,
  createAssetRow,
  removeAssetRow,
  rowFieldName,
  updateAssetRow,
} from "@/lib/indexdesk/desk-rows";

/**
 * Regression: a second asset could display the first asset's legal name and
 * jurisdiction because rows were keyed and edited by array index, so a
 * removal shifted subtrees (and mobile autofill) onto the neighbouring asset.
 */
describe("asset row isolation", () => {
  const tesla = createAssetRow({ symbol: "TSLA", company: "Tesla, Inc.", jurisdiction: "US" });
  const btc = createAssetRow();

  it("gives every row its own id and fresh values", () => {
    expect(tesla.id).not.toBe(btc.id);
    expect(btc).toMatchObject({ symbol: "", company: "", jurisdiction: "" });
  });

  it("editing one asset never changes another", () => {
    const rows = updateAssetRow([tesla, btc], btc.id, {
      symbol: "BTC",
      company: "Bitcoin",
      jurisdiction: "US",
    });
    expect(rows[0]).toEqual(tesla);
    expect(rows[1]).toMatchObject({ symbol: "BTC", company: "Bitcoin", jurisdiction: "US" });
  });

  it("removing the first asset keeps the second asset's own values", () => {
    const filled = updateAssetRow([tesla, btc], btc.id, { symbol: "BTC", company: "Bitcoin", jurisdiction: "US" });
    const remaining = removeAssetRow(filled, tesla.id);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(btc.id);
    expect(remaining[0]).toMatchObject({ symbol: "BTC", company: "Bitcoin", jurisdiction: "US" });
    // The old first-row Tesla values are gone entirely.
    expect(remaining.some((r) => r.company === "Tesla, Inc.")).toBe(false);
  });

  it("adding an asset appends a blank row, never a copy of the last one", () => {
    const rows = addAssetRow([tesla]);
    expect(rows).toHaveLength(2);
    expect(rows[1]).not.toEqual(rows[0]);
    expect(rows[1]).toMatchObject({ symbol: "", company: "", jurisdiction: "", chain: "ethereum" });
    expect(rows[1].id).not.toBe(rows[0].id);
  });

  it("keeps three different assets independent through add/edit/remove", () => {
    let rows = [createAssetRow(), createAssetRow()];
    rows = addAssetRow(rows);
    rows = updateAssetRow(rows, rows[0].id, { symbol: "TSLA", company: "Tesla, Inc.", jurisdiction: "US" });
    rows = updateAssetRow(rows, rows[1].id, { symbol: "BTC", company: "Bitcoin", jurisdiction: "US" });
    rows = updateAssetRow(rows, rows[2].id, { symbol: "ETH", company: "Ethereum Foundation", jurisdiction: "CH" });

    expect(rows.map((r) => r.symbol)).toEqual(["TSLA", "BTC", "ETH"]);
    expect(rows.map((r) => r.company)).toEqual(["Tesla, Inc.", "Bitcoin", "Ethereum Foundation"]);
    expect(rows.map((r) => r.jurisdiction)).toEqual(["US", "US", "CH"]);

    rows = removeAssetRow(rows, rows[1].id);
    expect(rows.map((r) => r.symbol)).toEqual(["TSLA", "ETH"]);
    expect(rows.map((r) => r.company)).toEqual(["Tesla, Inc.", "Ethereum Foundation"]);
  });

  it("scopes browser field names to the row id", () => {
    expect(rowFieldName("abc", "company")).toBe("ix-abc-company");
    expect(rowFieldName("def", "company")).not.toBe(rowFieldName("abc", "company"));
  });
});
