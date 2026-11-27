import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { persistence, persistenceMode, resetPersistenceForTests } from "@/lib/storage";

/**
 * updateNamed — the ATOMIC read-modify-write for named documents. This is
 * the regression for the silent index-loss bug: saveBuyerJob/saveAcpJob used
 * a bare readNamed → writeNamed append, so two concurrent registrations
 * raced, the second write clobbered the first, and a job that existed as a
 * document never appeared in history. The contract: overlapping mutations of
 * the SAME document serialize — every mutator sees the previous one's
 * persisted value, none is lost.
 */

const ORIGINAL = {
  dataDir: process.env.NIGHTSHIFT_DATA_DIR,
  database: process.env.NIGHTSHIFT_DATABASE_URL,
  databaseAlt: process.env.DATABASE_URL,
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ns-update-named-"));
  process.env.NIGHTSHIFT_DATA_DIR = dir;
  delete process.env.NIGHTSHIFT_DATABASE_URL;
  delete process.env.DATABASE_URL;
  resetPersistenceForTests();
});

afterEach(() => {
  if (ORIGINAL.dataDir === undefined) delete process.env.NIGHTSHIFT_DATA_DIR;
  else process.env.NIGHTSHIFT_DATA_DIR = ORIGINAL.dataDir;
  if (ORIGINAL.database === undefined) delete process.env.NIGHTSHIFT_DATABASE_URL;
  else process.env.NIGHTSHIFT_DATABASE_URL = ORIGINAL.database;
  if (ORIGINAL.databaseAlt === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL.databaseAlt;
  resetPersistenceForTests();
});

describe("updateNamed on the file backend", () => {
  it("runs in the env-dir mode these tests pin", () => {
    expect(persistenceMode()).toBe("env-dir");
  });

  it("creates the document when absent", async () => {
    const result = await persistence().updateNamed<string[]>("test-index", (current) => {
      expect(current).toBe(null);
      return ["a"];
    });
    expect(result).toEqual(["a"]);
    expect(await persistence().readNamed<string[]>("test-index")).toEqual(["a"]);
  });

  it("mutates the existing value", async () => {
    await persistence().writeNamed("test-index", ["a"]);
    const result = await persistence().updateNamed<string[]>("test-index", (current) => [...(current ?? []), "b"]);
    expect(result).toEqual(["a", "b"]);
  });

  it("never loses one of two CONCURRENT appends (the silent-loss regression)", async () => {
    await Promise.all([
      persistence().updateNamed<string[]>("race-index", (current) => [...(current ?? []), "first"]),
      persistence().updateNamed<string[]>("race-index", (current) => [...(current ?? []), "second"]),
    ]);
    const list = await persistence().readNamed<string[]>("race-index");
    expect(list).toHaveLength(2);
    expect(list).toContain("first");
    expect(list).toContain("second");
  });

  it("survives five concurrent appends with every key present", async () => {
    await Promise.all(
      ["k1", "k2", "k3", "k4", "k5"].map((k) => persistence().updateNamed<string[]>("race-index-5", (current) => [...(current ?? []), k])),
    );
    const list = await persistence().readNamed<string[]>("race-index-5");
    expect(list).toHaveLength(5);
    expect(new Set(list).size).toBe(5);
  });

  it("persists across a process restart (cache drop)", async () => {
    await persistence().updateNamed<string[]>("durable-index", (current) => [...(current ?? []), "kept"]);
    resetPersistenceForTests(); // the next persistence() re-reads from disk
    expect(await persistence().readNamed<string[]>("durable-index")).toEqual(["kept"]);
  });

  it("serializes mutations triggered from overlapping async work", async () => {
    // Both mutators are async-lagged: with a bare read-then-write this
    // interleaves and one append is lost. Serialization preserves CALL
    // order — the slow mutator opens the chain, the fast one appends after
    // it, and neither sees an empty document.
    const lag = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const append = (key: string, lagMs: number) =>
      persistence().updateNamed<string[]>("lag-index", async (current) => {
        await lag(lagMs);
        return [...(current ?? []), key];
      });
    await Promise.all([append("called-first", 30), append("called-second", 1)]);
    const list = await persistence().readNamed<string[]>("lag-index");
    expect(list).toEqual(["called-first", "called-second"]);
  });
});
