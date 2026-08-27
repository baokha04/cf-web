import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildCursorStatement,
  buildDeleteStatements,
  buildReconcileCursorStatement,
  buildRunStartStatement,
  buildUpsertStatements,
  cursorOf,
  readAllStates,
  readState,
  readTargetKeys,
  resetCursor
} from "../../src/sync/apply";
import { DEMO_SPEC, demoRow } from "./helpers";

/**
 * These run against a real D1 inside workerd, using the same migrations/d1
 * files wrangler applies. The properties asserted here belong to SQLite rather
 * than to the SQL this code assembles -- batch atomicity and the
 * last-writer-wins ON CONFLICT clause cannot be proven by string comparison.
 */
const db = env.REPLICA;

async function count(table: string): Promise<number> {
  const row = await db.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

async function qtyOf(id: string): Promise<number | null> {
  const row = await db
    .prepare("SELECT qty FROM demo_items WHERE id = ?")
    .bind(id)
    .first<{ qty: number }>();
  return row?.qty ?? null;
}

beforeAll(async () => {
  const migrations = env.MIGRATIONS;
  if (migrations === undefined) {
    throw new Error("MIGRATIONS binding missing - check the bindings in vitest.config.ts");
  }
  await applyD1Migrations(db, migrations);
});

beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM demo_items"), db.prepare("DELETE FROM _sync_state")]);
});

describe("migrations", () => {
  it("create the replica and cursor tables", async () => {
    const result = await db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all<{ name: string }>();
    const names = result.results.map((row) => row.name);
    expect(names).toContain("_sync_state");
    expect(names).toContain("demo_items");
    expect(names).toContain("d1_migrations");
  });
});

describe("upsert", () => {
  it("inserts a page and round-trips every column type", async () => {
    await db.batch(
      buildUpsertStatements(db, DEMO_SPEC, [
        demoRow({ id: "a", name: "first", qty: 1, price_cents: "9007199254740993" })
      ])
    );

    const row = await db
      .prepare("SELECT * FROM demo_items WHERE id = ?")
      .bind("a")
      .first<Record<string, unknown>>();

    expect(row).toMatchObject({
      id: "a",
      name: "first",
      qty: 1,
      // Stored as TEXT, so the value survives past 2^53 intact.
      price_cents: "9007199254740993",
      metadata: '{"n":1}',
      is_active: 1,
      deleted_at: null,
      updated_at: "2026-08-27T10:00:00.000Z"
    });
  });

  it("lets a newer version win", async () => {
    await db.batch(buildUpsertStatements(db, DEMO_SPEC, [demoRow({ id: "a", qty: 1 })]));
    await db.batch(
      buildUpsertStatements(db, DEMO_SPEC, [
        demoRow({ id: "a", qty: 2, updated_at: "2026-08-27 11:00:00+00" })
      ])
    );
    expect(await qtyOf("a")).toBe(2);
  });

  it("makes replaying an older version a no-op", async () => {
    // This is what turns at-least-once delivery into a safe property: a
    // safety-lag overlap or a manual re-run costs nothing.
    await db.batch(
      buildUpsertStatements(db, DEMO_SPEC, [
        demoRow({ id: "a", qty: 5, updated_at: "2026-08-27 11:00:00+00" })
      ])
    );
    await db.batch(
      buildUpsertStatements(db, DEMO_SPEC, [
        demoRow({ id: "a", qty: 1, updated_at: "2026-08-27 10:00:00+00" })
      ])
    );
    expect(await qtyOf("a")).toBe(5);
  });

  it("is idempotent at the same timestamp", async () => {
    const row = demoRow({ id: "a", qty: 3 });
    await db.batch(buildUpsertStatements(db, DEMO_SPEC, [row]));
    await db.batch(buildUpsertStatements(db, DEMO_SPEC, [row]));
    expect(await count("demo_items")).toBe(1);
    expect(await qtyOf("a")).toBe(3);
  });

  it("applies a page larger than one statement's parameter budget", async () => {
    const rows = Array.from({ length: 25 }, (_unused, index) =>
      demoRow({ id: `id-${index}`, name: `item-${index}` })
    );
    const statements = buildUpsertStatements(db, DEMO_SPEC, rows);
    expect(statements).toHaveLength(3);
    await db.batch(statements);
    expect(await count("demo_items")).toBe(25);
  });
});

describe("cursor", () => {
  it("reports a missing row as never synced rather than as an error", async () => {
    const state = await readState(db, "demo_items");
    expect(state.cursorUpdatedAt).toBeNull();
    expect(state.lastRunStatus).toBe("idle");
    expect(cursorOf(state)).toBeNull();
  });

  it("advances with the rows it accounts for", async () => {
    await buildRunStartStatement(db, DEMO_SPEC, "2026-08-27T12:00:00.000Z").run();
    await db.batch([
      ...buildUpsertStatements(db, DEMO_SPEC, [demoRow({ id: "a" })]),
      buildCursorStatement(db, DEMO_SPEC, { updatedAt: "2026-08-27T10:00:00.000Z", pk: "a" }, {
        rows: 1,
        status: "running",
        finishedAt: "2026-08-27T12:00:01.000Z",
        error: null
      })
    ]);

    const state = await readState(db, "demo_items");
    expect(cursorOf(state)).toEqual({ updatedAt: "2026-08-27T10:00:00.000Z", pk: "a" });
    expect(state.rowsSyncedTotal).toBe(1);
    expect(state.rowsSyncedLastRun).toBe(1);
    expect(state.runsTotal).toBe(1);
  });

  it("resets the per-run counter but not the total on a new run", async () => {
    await buildRunStartStatement(db, DEMO_SPEC, "2026-08-27T12:00:00.000Z").run();
    await buildCursorStatement(db, DEMO_SPEC, null, {
      rows: 5,
      status: "ok",
      finishedAt: "2026-08-27T12:00:01.000Z",
      error: null
    }).run();

    await buildRunStartStatement(db, DEMO_SPEC, "2026-08-27T12:05:00.000Z").run();
    const state = await readState(db, "demo_items");
    expect(state.rowsSyncedTotal).toBe(5);
    expect(state.rowsSyncedLastRun).toBe(0);
    expect(state.runsTotal).toBe(2);
    expect(state.lastRunStatus).toBe("running");
  });

  /**
   * The invariant the whole recovery story rests on. A batch is a transaction,
   * so a page that fails leaves the watermark exactly where the last successful
   * page put it -- never ahead of data that was not written.
   */
  it("cannot outrun uncommitted rows when a page fails", async () => {
    await buildRunStartStatement(db, DEMO_SPEC, "2026-08-27T12:00:00.000Z").run();
    await db.batch([
      ...buildUpsertStatements(db, DEMO_SPEC, [demoRow({ id: "a" })]),
      buildCursorStatement(db, DEMO_SPEC, { updatedAt: "2026-08-27T10:00:00.000Z", pk: "a" }, {
        rows: 1,
        status: "running",
        finishedAt: "2026-08-27T12:00:01.000Z",
        error: null
      })
    ]);

    await expect(
      db.batch([
        ...buildUpsertStatements(db, DEMO_SPEC, [demoRow({ id: "b" })]),
        // demo_items.name is NOT NULL, so this statement aborts the batch.
        db
          .prepare("INSERT INTO demo_items (id, name, created_at, updated_at) VALUES (?, NULL, ?, ?)")
          .bind("c", "2026-08-27T11:00:00.000Z", "2026-08-27T11:00:00.000Z"),
        buildCursorStatement(db, DEMO_SPEC, { updatedAt: "2026-08-27T11:00:00.000Z", pk: "c" }, {
          rows: 2,
          status: "running",
          finishedAt: "2026-08-27T12:00:02.000Z",
          error: null
        })
      ])
    ).rejects.toThrow();

    const state = await readState(db, "demo_items");
    expect(cursorOf(state)).toEqual({ updatedAt: "2026-08-27T10:00:00.000Z", pk: "a" });
    expect(state.rowsSyncedTotal).toBe(1);
    // Row "b" rolled back with the cursor it would have been accounted by.
    expect(await count("demo_items")).toBe(1);
  });

  it("lists every table's state", async () => {
    await buildRunStartStatement(db, DEMO_SPEC, "2026-08-27T12:00:00.000Z").run();
    const states = await readAllStates(db);
    expect(states.map((state) => state.tableKey)).toEqual(["demo_items"]);
  });
});

describe("reset", () => {
  it("clears the watermark and bumps the epoch, keeping the rows", async () => {
    await buildRunStartStatement(db, DEMO_SPEC, "2026-08-27T12:00:00.000Z").run();
    await db.batch([
      ...buildUpsertStatements(db, DEMO_SPEC, [demoRow({ id: "a" })]),
      buildCursorStatement(db, DEMO_SPEC, { updatedAt: "2026-08-27T10:00:00.000Z", pk: "a" }, {
        rows: 1,
        status: "running",
        finishedAt: "2026-08-27T12:00:01.000Z",
        error: null
      })
    ]);

    await resetCursor(db, DEMO_SPEC, false);

    const state = await readState(db, "demo_items");
    expect(cursorOf(state)).toBeNull();
    expect(state.fullSyncEpoch).toBe(1);
    expect(state.lastRunStatus).toBe("idle");
    expect(await count("demo_items")).toBe(1);
  });

  it("empties the replica when asked to truncate", async () => {
    await db.batch(buildUpsertStatements(db, DEMO_SPEC, [demoRow({ id: "a" })]));
    await resetCursor(db, DEMO_SPEC, true);
    expect(await count("demo_items")).toBe(0);
  });

  it("creates the state row when the table has never run", async () => {
    await resetCursor(db, DEMO_SPEC, false);
    expect((await readState(db, "demo_items")).fullSyncEpoch).toBe(1);
  });
});

describe("reconcile", () => {
  it("reads replica keys in a half-open range", async () => {
    await db.batch(
      buildUpsertStatements(
        db,
        DEMO_SPEC,
        ["a", "b", "c", "d"].map((id) => demoRow({ id }))
      )
    );

    expect(await readTargetKeys(db, DEMO_SPEC, null, "c")).toEqual(["a", "b", "c"]);
    expect(await readTargetKeys(db, DEMO_SPEC, "a", "c")).toEqual(["b", "c"]);
    expect(await readTargetKeys(db, DEMO_SPEC, "d", "z")).toEqual([]);
  });

  it("deletes the orphans a hard delete left behind", async () => {
    await db.batch(
      buildUpsertStatements(
        db,
        DEMO_SPEC,
        ["a", "b", "c"].map((id) => demoRow({ id }))
      )
    );
    await db.batch(buildDeleteStatements(db, DEMO_SPEC, ["b"]));

    expect(await readTargetKeys(db, DEMO_SPEC, null, "z")).toEqual(["a", "c"]);
  });

  it("tracks its own cursor without disturbing the sync cursor", async () => {
    await buildRunStartStatement(db, DEMO_SPEC, "2026-08-27T12:00:00.000Z").run();
    await buildCursorStatement(db, DEMO_SPEC, { updatedAt: "2026-08-27T10:00:00.000Z", pk: "a" }, {
      rows: 0,
      status: "ok",
      finishedAt: "2026-08-27T12:00:01.000Z",
      error: null
    }).run();

    await buildReconcileCursorStatement(db, DEMO_SPEC, "m", null).run();
    let state = await readState(db, "demo_items");
    expect(state.reconcileCursorPk).toBe("m");
    expect(state.reconciledAt).toBeNull();
    expect(cursorOf(state)).toEqual({ updatedAt: "2026-08-27T10:00:00.000Z", pk: "a" });

    await buildReconcileCursorStatement(db, DEMO_SPEC, null, "2026-08-27T13:00:00.000Z").run();
    state = await readState(db, "demo_items");
    expect(state.reconcileCursorPk).toBeNull();
    expect(state.reconciledAt).toBe("2026-08-27T13:00:00.000Z");
    expect(cursorOf(state)).toEqual({ updatedAt: "2026-08-27T10:00:00.000Z", pk: "a" });
  });
});
