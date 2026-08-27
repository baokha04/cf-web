import type { Client } from "pg";
import {
  buildCursorStatement,
  buildDeleteStatements,
  buildReconcileCursorStatement,
  buildRunStartStatement,
  buildUpsertStatements,
  cursorOf,
  readState,
  readTargetKeys,
  resetCursor,
  sizeAfter
} from "./apply";
import { closePg, openPg, pullKeyPage, pullPage } from "./pull";
import { DEFAULT_PAGE_SIZE, getSpec, listSpecs, validateRegistry } from "./registry";
import type {
  ReconcileResult,
  SyncBudget,
  SyncCursor,
  SyncRunOptions,
  SyncRunResult,
  TableReconcileResult,
  TableRunResult,
  TableSpec
} from "./types";

/**
 * Orchestration.
 *
 * The single invariant everything below rests on: the cursor UPDATE is always
 * the last statement of the same db.batch() as the rows it accounts for. A
 * batch is a SQL transaction, so an interrupted run leaves the watermark
 * exactly at the last page that committed -- never ahead of it, never behind.
 * The next tick re-pulls one page and continues.
 */

const DEFAULT_BUDGET_MS = 20_000;
const DEFAULT_MAX_D1_STATEMENTS = 800;
/** Keys per reconcile page. Independent of pageSize: this reads keys, not rows. */
const RECONCILE_KEY_PAGE = 1000;

/**
 * wrangler types narrows a var to the literal in wrangler.jsonc, so comparing
 * env.SYNC_ENABLED to "true" directly is a compile error even though the
 * deployed value can be anything. Widening to string is the honest read.
 */
export function isSyncEnabled(env: Env): boolean {
  const flag: string = env.SYNC_ENABLED;
  return flag === "true";
}

function numberVar(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nowIso(): string {
  return new Date().toISOString();
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function lagSecondsOf(cursor: SyncCursor): number | null {
  if (cursor === null) {
    return null;
  }
  const at = Date.parse(cursor.updatedAt);
  return Number.isNaN(at) ? null : Math.round((Date.now() - at) / 1000);
}

/**
 * One table, one run. Pages until the source is caught up or a budget runs out.
 *
 * Budget exhaustion is NOT an error: it ends the tick "partial" with the cursor
 * committed, and a long backfill is just a sequence of partial runs through
 * this same code path. There is no separate bulk-load mode.
 */
export async function runTable(
  pg: Client,
  db: D1Database,
  spec: TableSpec,
  budget: SyncBudget,
  runId: string,
  maxPages?: number
): Promise<TableRunResult> {
  const startedAtMs = Date.now();
  const startedAt = nowIso();

  const state = await readState(db, spec.key);
  const cursorBefore = cursorOf(state);
  let cursor = cursorBefore;

  let pagesPulled = 0;
  let rowsUpserted = 0;
  let rowsDeleted = 0;
  let d1Statements = 0;

  const spend = (count: number): void => {
    d1Statements += count;
    budget.d1StatementsRemaining -= count;
  };

  await buildRunStartStatement(db, spec, startedAt).run();
  spend(1);

  let status: TableRunResult["status"] = "ok";
  let error: string | undefined;

  try {
    for (;;) {
      if (Date.now() >= budget.deadlineAt || budget.d1StatementsRemaining <= 1) {
        status = "partial";
        break;
      }
      if (maxPages !== undefined && pagesPulled >= maxPages) {
        status = "partial";
        break;
      }

      const page = await pullPage(pg, spec, cursor);
      if (page.rows.length === 0) {
        break;
      }

      const mapped: Record<string, unknown>[] = [];
      for (const row of page.rows) {
        const result = spec.mapRow === undefined ? row : spec.mapRow(row);
        // A dropped row still advances the cursor, so it is not retried forever.
        if (result !== null) {
          mapped.push(result);
        }
      }

      let toUpsert = mapped;
      let toDelete: string[] = [];
      if (spec.softDeleteColumn !== undefined && spec.onSoftDelete === "purge") {
        const softDeleteColumn = spec.softDeleteColumn;
        toUpsert = mapped.filter((row) => row[softDeleteColumn] === null);
        toDelete = mapped
          .filter((row) => row[softDeleteColumn] !== null)
          .map((row) => String(row[spec.primaryKey]));
      }

      const statements = [
        ...buildUpsertStatements(db, spec, toUpsert),
        ...buildDeleteStatements(db, spec, toDelete),
        // Last, and in the same transaction as the rows above. This ordering is
        // the whole recovery story.
        buildCursorStatement(db, spec, page.nextCursor, {
          rows: toUpsert.length,
          status: "running",
          finishedAt: nowIso(),
          error: null
        })
      ];

      if (statements.length > budget.d1StatementsRemaining) {
        // Stop before applying: a page is atomic, so a half-applied page is not
        // an option. The next tick has a full budget and picks it up.
        status = "partial";
        break;
      }

      const results = await db.batch(statements);
      spend(statements.length);

      pagesPulled += 1;
      rowsUpserted += toUpsert.length;
      rowsDeleted += toDelete.length;
      cursor = page.nextCursor;

      console.log(
        JSON.stringify({
          event: "sync.table.page",
          runId,
          table: spec.key,
          page: pagesPulled,
          rows: toUpsert.length,
          deleted: toDelete.length,
          cursorAfter: cursor,
          d1Statements: statements.length,
          d1SizeBytes: sizeAfter(results)
        })
      );

      if (!page.hasMore) {
        break;
      }
    }
  } catch (cause) {
    status = "error";
    error = messageOf(cause);
    console.error(
      JSON.stringify({ event: "sync.error", runId, table: spec.key, message: error })
    );
  }

  // Standalone, so it survives whatever rolled back inside the loop.
  await buildCursorStatement(db, spec, cursor, {
    rows: 0,
    status,
    finishedAt: nowIso(),
    error: error ?? null
  }).run();
  spend(1);

  return {
    tableKey: spec.key,
    status,
    pagesPulled,
    rowsUpserted,
    rowsDeleted,
    d1Statements,
    cursorBefore,
    cursorAfter: cursor,
    lagSeconds: lagSecondsOf(cursor),
    durationMs: Date.now() - startedAtMs,
    ...(error === undefined ? {} : { error })
  };
}

export async function runSync(env: Env, options: SyncRunOptions = {}): Promise<SyncRunResult> {
  validateRegistry();

  const runId = crypto.randomUUID();
  const startedAtMs = Date.now();
  const startedAt = nowIso();
  const trigger = options.trigger ?? "cron";
  const specs = listSpecs(options.tables);

  const budget: SyncBudget = {
    deadlineAt: startedAtMs + (options.budgetMs ?? numberVar(env.SYNC_BUDGET_MS, DEFAULT_BUDGET_MS)),
    d1StatementsRemaining:
      options.maxD1Statements ?? numberVar(env.SYNC_MAX_D1_STATEMENTS, DEFAULT_MAX_D1_STATEMENTS)
  };

  console.log(
    JSON.stringify({
      event: "sync.run.start",
      runId,
      trigger,
      tables: specs.map((spec) => spec.key)
    })
  );

  const pg = await openPg(env);
  const tables: TableRunResult[] = [];

  try {
    for (const spec of specs) {
      // Caught per table, not per run: one broken spec must not stop the others.
      tables.push(await runTable(pg, env.REPLICA, spec, budget, runId, options.maxPagesPerTable));
    }
  } finally {
    await closePg(pg);
  }

  return {
    runId,
    trigger,
    startedAt,
    durationMs: Date.now() - startedAtMs,
    budgetExhausted: tables.some((table) => table.status === "partial"),
    tables
  };
}

/**
 * The delete fallback.
 *
 * A watermark observes only rows that still exist: a DELETE removes the row and
 * its timestamp together, so nothing is left for the next query to return. That
 * is structural, not a bug. Soft deletes are the documented convention; this
 * walk is the opt-in safety net for tables that hard-delete anyway.
 *
 * Correctness depends on both sides ordering the primary key identically --
 * registry.validateSpec rejects the combinations where they do not.
 */
async function reconcileTable(
  pg: Client,
  db: D1Database,
  spec: TableSpec,
  budget: SyncBudget,
  runId: string
): Promise<TableReconcileResult> {
  const startedAtMs = Date.now();
  const state = await readState(db, spec.key);

  let afterPk = state.reconcileCursorPk;
  let keysScanned = 0;
  let rowsDeleted = 0;
  let completed = false;
  let status: TableReconcileResult["status"] = "ok";
  let error: string | undefined;

  try {
    for (;;) {
      if (Date.now() >= budget.deadlineAt || budget.d1StatementsRemaining <= 2) {
        status = "partial";
        break;
      }

      const page = await pullKeyPage(pg, spec, afterPk, RECONCILE_KEY_PAGE);
      if (page.keys.length === 0 || page.lastPk === null) {
        completed = true;
        break;
      }

      const sourceKeys = new Set(page.keys);
      const replicaKeys = await readTargetKeys(db, spec, afterPk, page.lastPk);
      budget.d1StatementsRemaining -= 1;

      const orphans = replicaKeys.filter((key) => !sourceKeys.has(key));
      const statements = [
        ...buildDeleteStatements(db, spec, orphans),
        buildReconcileCursorStatement(db, spec, page.lastPk, null)
      ];
      await db.batch(statements);
      budget.d1StatementsRemaining -= statements.length;

      keysScanned += page.keys.length;
      rowsDeleted += orphans.length;
      afterPk = page.lastPk;

      if (!page.hasMore) {
        completed = true;
        break;
      }
    }

    if (completed) {
      // Clearing the walk cursor is what makes the next reconcile start over.
      await buildReconcileCursorStatement(db, spec, null, nowIso()).run();
      budget.d1StatementsRemaining -= 1;
    }
  } catch (cause) {
    status = "error";
    error = messageOf(cause);
    console.error(
      JSON.stringify({ event: "sync.error", runId, table: spec.key, phase: "reconcile", message: error })
    );
  }

  return {
    tableKey: spec.key,
    status,
    keysScanned,
    rowsDeleted,
    completed,
    durationMs: Date.now() - startedAtMs,
    ...(error === undefined ? {} : { error })
  };
}

export async function runReconcile(
  env: Env,
  options: { tables?: string[]; budgetMs?: number; maxD1Statements?: number } = {}
): Promise<ReconcileResult> {
  validateRegistry();

  const runId = crypto.randomUUID();
  const startedAtMs = Date.now();
  const startedAt = nowIso();
  const specs = listSpecs(options.tables).filter((spec) => spec.reconcileDeletes === true);

  const budget: SyncBudget = {
    deadlineAt: startedAtMs + (options.budgetMs ?? numberVar(env.SYNC_BUDGET_MS, DEFAULT_BUDGET_MS)),
    d1StatementsRemaining:
      options.maxD1Statements ?? numberVar(env.SYNC_MAX_D1_STATEMENTS, DEFAULT_MAX_D1_STATEMENTS)
  };

  console.log(
    JSON.stringify({
      event: "sync.reconcile.start",
      runId,
      tables: specs.map((spec) => spec.key)
    })
  );

  if (specs.length === 0) {
    return { runId, startedAt, durationMs: Date.now() - startedAtMs, budgetExhausted: false, tables: [] };
  }

  const pg = await openPg(env);
  const tables: TableReconcileResult[] = [];

  try {
    for (const spec of specs) {
      tables.push(await reconcileTable(pg, env.REPLICA, spec, budget, runId));
    }
  } finally {
    await closePg(pg);
  }

  return {
    runId,
    startedAt,
    durationMs: Date.now() - startedAtMs,
    budgetExhausted: tables.some((table) => table.status === "partial"),
    tables
  };
}

/** Force a full re-sync of one table on the next run. */
export async function resetTable(env: Env, tableKey: string, truncate: boolean): Promise<void> {
  const spec = getSpec(tableKey);
  await resetCursor(env.REPLICA, spec, truncate);
  console.log(JSON.stringify({ event: "sync.reset", table: tableKey, truncate }));
}

export { DEFAULT_PAGE_SIZE };
