/**
 * Shared types for the one-way Postgres -> D1 replica.
 *
 * Three properties carry the correctness of the whole pipeline, and every type
 * below exists to serve one of them:
 *
 *   1. The cursor is a row-value on (cursorColumn, primaryKey), never a bare
 *      timestamp. See buildPullSql in ./pull.ts for why.
 *   2. The cursor UPDATE rides in the same db.batch() as the rows it accounts
 *      for. batch() is a SQL transaction, so the watermark cannot outrun
 *      committed data or lag behind it.
 *   3. The upsert is last-writer-wins by source timestamp, which makes
 *      at-least-once delivery safe to replay.
 */

/** Everything D1 accepts as a bound parameter. */
export type D1Value = null | number | string | ArrayBuffer;

/**
 * How a decoded Postgres value is coerced before binding.
 *
 * The choices prefer exactness over convenience. int8 and numeric go to TEXT
 * because a JS number loses them silently, and that loss stays invisible until
 * someone sums the column.
 */
export type SyncColumnType =
  | "text" //      text, varchar, char, uuid, enum, inet, time, interval -> TEXT
  | "integer" //   int2, int4, and int8 within Number.MAX_SAFE_INTEGER    -> INTEGER
  | "bigint" //    int8 of any magnitude, kept exact                      -> TEXT
  | "real" //      float4, float8                                         -> REAL
  | "numeric" //   numeric, decimal, money, kept exact                    -> TEXT
  | "boolean" //   bool                                                   -> INTEGER 0/1
  | "timestamp" // timestamptz, timestamp, date                           -> TEXT ISO-8601 UTC
  | "json" //      json, jsonb, arrays, composites                        -> TEXT
  | "blob"; //     bytea                                                  -> BLOB

export type SyncColumn = {
  /** Column name in Postgres. */
  readonly source: string;
  /** Column name in D1. Defaults to `source`. */
  readonly target?: string;
  readonly type: SyncColumnType;
};

/** Postgres type of the primary key, used to cast the resumed cursor back. */
export type PrimaryKeyPgType = "uuid" | "text" | "integer" | "bigint";

export type TableSpec = {
  /** Stable identity for this registration; the primary key of _sync_state. */
  readonly key: string;
  readonly schema: string;
  readonly sourceTable: string;
  readonly targetTable: string;

  /** Single-column primary key. Must be NOT NULL and unique in Postgres. */
  readonly primaryKey: string;
  /**
   * The cursor is stored as TEXT in D1. Casting it back to the source type is
   * what keeps the row-value comparison well-typed and therefore index-seekable
   * -- casting the column instead would force a sort.
   */
  readonly primaryKeyPgType: PrimaryKeyPgType;

  /** Monotonic change column. Must be timestamptz/timestamp and NOT NULL. */
  readonly cursorColumn: string;

  /** Every replicated column, INCLUDING primaryKey and cursorColumn. */
  readonly columns: readonly SyncColumn[];

  readonly softDeleteColumn?: string;
  /**
   * "mirror" keeps the row in D1 with the soft-delete column set, so readers
   * filter it and a reader holding the id can still see why it vanished.
   * "purge" issues a DELETE instead. Default "mirror".
   */
  readonly onSoftDelete?: "mirror" | "purge";

  /** Rows per Postgres page. Default 500, hard-capped at 5000. */
  readonly pageSize?: number;
  /**
   * Ignore rows whose cursorColumn is newer than now() minus this many seconds.
   *
   * This is the guard against a write transaction that stamps updated_at at
   * transaction start and commits later: without the lag, a tick can read past
   * that timestamp before the row is visible, and the row is then missed
   * forever. Must exceed the source's longest write transaction -- and its
   * replica lag, if Hyperdrive points at a replica. Default 5.
   */
  readonly safetyLagSeconds?: number;

  /** Opt in to the daily full-key delete reconcile. Default false. */
  readonly reconcileDeletes?: boolean;

  /**
   * Applied after decoding and before binding. Return null to drop the row --
   * the cursor still advances past it, so a dropped row is not retried.
   */
  readonly mapRow?: (row: Record<string, unknown>) => Record<string, unknown> | null;
};

/** null means "never synced": the next run starts from the beginning. */
export type SyncCursor = { updatedAt: string; pk: string } | null;

export type SyncRunStatus = "idle" | "running" | "ok" | "partial" | "error";

export type SyncState = {
  tableKey: string;
  cursorUpdatedAt: string | null;
  cursorPk: string | null;
  lastRunStartedAt: string | null;
  lastRunFinishedAt: string | null;
  lastRunStatus: SyncRunStatus;
  lastError: string | null;
  rowsSyncedTotal: number;
  rowsSyncedLastRun: number;
  runsTotal: number;
  fullSyncEpoch: number;
  reconcileCursorPk: string | null;
  reconciledAt: string | null;
};

/**
 * A run consumes two budgets at once. Wall clock protects the cron ceiling --
 * which is 30s of CPU for intervals under an hour, not the 15 minutes it is
 * easy to assume. The statement counter protects D1's 1000-queries-per-
 * invocation limit. Whichever runs out first ends the tick "partial", and the
 * next tick resumes from the committed cursor.
 */
export type SyncBudget = {
  deadlineAt: number;
  d1StatementsRemaining: number;
};

export type SyncTrigger = "cron" | "http";

export type SyncRunOptions = {
  trigger?: SyncTrigger;
  tables?: string[];
  budgetMs?: number;
  maxD1Statements?: number;
  maxPagesPerTable?: number;
};

export type TableRunResult = {
  tableKey: string;
  status: "ok" | "partial" | "error" | "skipped";
  pagesPulled: number;
  rowsUpserted: number;
  rowsDeleted: number;
  d1Statements: number;
  cursorBefore: SyncCursor;
  cursorAfter: SyncCursor;
  /** Replication lag in seconds derived from the committed cursor. */
  lagSeconds: number | null;
  durationMs: number;
  error?: string;
};

export type SyncRunResult = {
  runId: string;
  trigger: SyncTrigger;
  startedAt: string;
  durationMs: number;
  budgetExhausted: boolean;
  tables: TableRunResult[];
};

export type TableReconcileResult = {
  tableKey: string;
  status: "ok" | "partial" | "error" | "skipped";
  keysScanned: number;
  rowsDeleted: number;
  completed: boolean;
  durationMs: number;
  error?: string;
};

export type ReconcileResult = {
  runId: string;
  startedAt: string;
  durationMs: number;
  budgetExhausted: boolean;
  tables: TableReconcileResult[];
};
