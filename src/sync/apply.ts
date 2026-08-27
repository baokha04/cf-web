import { targetColumn } from "./registry";
import type { D1Value, SyncColumn, SyncColumnType, SyncCursor, SyncRunStatus, SyncState, TableSpec } from "./types";

/**
 * The D1 side: value encoding, statement construction, and _sync_state I/O.
 *
 * Two D1 limits shape everything here, and the first is far tighter than it
 * looks:
 *   - 100 bound parameters per query. A 9-column table fits 11 rows per
 *     statement; a 60-column table fits 1, which triples the statement count
 *     and brings the per-invocation ceiling on three times sooner.
 *   - 100 KB of SQL per statement, including statements inside a batch(). Since
 *     every value is bound rather than inlined, statement text is just
 *     placeholders and a column list, so this one is never close.
 */
export const D1_MAX_BOUND_PARAMS = 100;
export const D1_MAX_SQL_BYTES = 100_000;
/** Assert well under the limit, so a regression fails here and not in production. */
const SQL_BYTES_GUARD = 90_000;

/** D1 caps a single TEXT or BLOB value, and a whole row, at 2,000,000 bytes. */
const D1_MAX_VALUE_BYTES = 2_000_000;
const VALUE_BYTES_GUARD = 1_900_000;
/**
 * UTF-8 uses at most 4 bytes per code unit, so a shorter string cannot reach
 * the guard and does not need measuring. Encoding every value would make the
 * hot path O(n) for no reason.
 */
const MEASURE_ABOVE_LENGTH = Math.ceil(VALUE_BYTES_GUARD / 4);

/**
 * Identifiers cannot be bound, only quoted. registry.validateSpec has already
 * rejected anything outside /^[A-Za-z_][A-Za-z0-9_]*$/; doubling embedded
 * quotes here is belt and braces so this function is safe on its own terms.
 */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function guardSize(value: string | ArrayBuffer, kind: "TEXT" | "BLOB"): void {
  const bytes =
    typeof value === "string"
      ? value.length > MEASURE_ABOVE_LENGTH
        ? byteLength(value)
        : 0
      : value.byteLength;
  if (bytes > VALUE_BYTES_GUARD) {
    throw new Error(
      `${kind} value of ${bytes} bytes exceeds D1's ${D1_MAX_VALUE_BYTES}-byte cap. ` +
        "Drop the column from the TableSpec, or store a reference instead of the payload."
    );
  }
}

/** Postgres renders timestamps several ways; D1 stores one. */
function toIsoUtc(value: string): string {
  // "2026-08-27 10:00:00+00" -> "2026-08-27T10:00:00+00:00", and a value with
  // no zone at all is read as UTC rather than as the runtime's local time.
  // A bare date has no time part at all; without this it would become
  // "2026-08-27Z", which Date rejects.
  let text = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value;
  text = text.includes("T") ? text : text.replace(" ", "T");
  text = text.replace(/([+-]\d{2})$/, "$1:00");
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(text)) {
    text = `${text}Z`;
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`cannot parse "${value}" as a timestamp`);
  }
  return parsed.toISOString();
}

/**
 * Coerce one decoded Postgres value into something D1 will bind.
 *
 * Exactness wins over convenience: int8 and numeric become TEXT because a JS
 * number loses them silently, and an "integer" column that would not survive
 * the round trip throws rather than rounding.
 */
export function encodeValue(value: unknown, type: SyncColumnType): D1Value {
  if (value === null || value === undefined) {
    return null;
  }

  switch (type) {
    case "text": {
      const text = typeof value === "string" ? value : String(value);
      guardSize(text, "TEXT");
      return text;
    }

    case "integer": {
      const numeric = typeof value === "bigint" ? value : Number(value);
      if (typeof numeric === "bigint") {
        if (numeric > BigInt(Number.MAX_SAFE_INTEGER) || numeric < BigInt(Number.MIN_SAFE_INTEGER)) {
          throw new Error(
            `integer value ${numeric} is outside the JS safe range. ` +
              'Change the column type to "bigint" so it is stored exactly as TEXT.'
          );
        }
        return Number(numeric);
      }
      if (!Number.isFinite(numeric) || !Number.isSafeInteger(numeric)) {
        throw new Error(
          `integer value ${String(value)} is not a safe integer. ` +
            'Change the column type to "bigint" so it is stored exactly as TEXT.'
        );
      }
      return numeric;
    }

    case "bigint":
    case "numeric": {
      // pg already returns int8 and numeric as strings; a number here means the
      // value passed through JS arithmetic and may already have lost precision.
      if (typeof value === "number" && !Number.isSafeInteger(value) && Number.isInteger(value)) {
        throw new Error(
          `${type} value ${value} arrived as an unsafe JS number and has already lost precision. ` +
            "Keep the pg type parser that returns it as a string."
        );
      }
      return String(value);
    }

    case "real": {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) {
        throw new Error(`real value ${String(value)} is not finite`);
      }
      return numeric;
    }

    case "boolean": {
      if (typeof value === "boolean") {
        return value ? 1 : 0;
      }
      if (value === "t" || value === "true" || value === 1) {
        return 1;
      }
      if (value === "f" || value === "false" || value === 0) {
        return 0;
      }
      throw new Error(`boolean value ${String(value)} is not recognised`);
    }

    case "timestamp": {
      if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) {
          throw new Error("timestamp value is an Invalid Date");
        }
        return value.toISOString();
      }
      return toIsoUtc(String(value));
    }

    case "json": {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      if (text === undefined) {
        throw new Error("json value is not serialisable");
      }
      guardSize(text, "TEXT");
      return text;
    }

    case "blob": {
      if (value instanceof ArrayBuffer) {
        guardSize(value, "BLOB");
        return value;
      }
      if (ArrayBuffer.isView(value)) {
        const view = value as ArrayBufferView;
        const buffer = view.buffer.slice(
          view.byteOffset,
          view.byteOffset + view.byteLength
        ) as ArrayBuffer;
        guardSize(buffer, "BLOB");
        return buffer;
      }
      throw new Error(`blob value of type ${typeof value} is neither ArrayBuffer nor a view`);
    }
  }
}

/**
 * How many rows fit in one INSERT before the 100-parameter limit bites.
 * Never zero: a spec wider than 100 columns is rejected by validateSpec, but a
 * floor of 1 keeps this total.
 */
export function rowsPerStatement(spec: TableSpec): number {
  return Math.max(1, Math.floor(D1_MAX_BOUND_PARAMS / spec.columns.length));
}

function guardSql(sql: string): string {
  if (sql.length > SQL_BYTES_GUARD) {
    throw new Error(
      `built a ${sql.length}-byte statement, over the ${SQL_BYTES_GUARD}-byte guard ` +
        `(D1 allows ${D1_MAX_SQL_BYTES}). Values are bound, so this means too many placeholders.`
    );
  }
  return sql;
}

function encodeRow(spec: TableSpec, row: Record<string, unknown>): D1Value[] {
  return spec.columns.map((column: SyncColumn) => {
    try {
      return encodeValue(row[column.source], column.type);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`${spec.key}.${column.source}: ${message}`);
    }
  });
}

/**
 * Upsert one page as the fewest statements the parameter limit allows.
 *
 * The trailing WHERE on DO UPDATE is what makes at-least-once delivery safe:
 * replaying an older page becomes a no-op instead of a regression. It is the
 * reason a safety-lag overlap or a manual re-run costs nothing.
 */
export function buildUpsertStatements(
  db: D1Database,
  spec: TableSpec,
  rows: Record<string, unknown>[]
): D1PreparedStatement[] {
  if (rows.length === 0) {
    return [];
  }

  const table = quoteIdent(spec.targetTable);
  const columnList = spec.columns.map((column) => quoteIdent(targetColumn(column))).join(", ");
  const pkColumn = spec.columns.find((column) => column.source === spec.primaryKey);
  const cursorCol = spec.columns.find((column) => column.source === spec.cursorColumn);
  if (pkColumn === undefined || cursorCol === undefined) {
    throw new Error(`${spec.key}: primaryKey or cursorColumn missing from columns`);
  }
  const pk = quoteIdent(targetColumn(pkColumn));
  const cursor = quoteIdent(targetColumn(cursorCol));

  const assignments = spec.columns
    .filter((column) => column.source !== spec.primaryKey)
    .map((column) => {
      const name = quoteIdent(targetColumn(column));
      return `${name} = excluded.${name}`;
    });

  const conflict =
    assignments.length === 0
      ? `ON CONFLICT(${pk}) DO NOTHING`
      : `ON CONFLICT(${pk}) DO UPDATE SET ${assignments.join(", ")} ` +
        `WHERE excluded.${cursor} >= ${table}.${cursor}`;

  const perStatement = rowsPerStatement(spec);
  const tuple = `(${spec.columns.map(() => "?").join(", ")})`;
  const statements: D1PreparedStatement[] = [];

  for (let offset = 0; offset < rows.length; offset += perStatement) {
    const chunk = rows.slice(offset, offset + perStatement);
    const sql = guardSql(
      `INSERT INTO ${table} (${columnList}) VALUES ${chunk.map(() => tuple).join(", ")} ${conflict}`
    );
    const values = chunk.flatMap((row) => encodeRow(spec, row));
    statements.push(db.prepare(sql).bind(...values));
  }

  return statements;
}

/** DELETE ... IN (...), chunked at the parameter limit. */
export function buildDeleteStatements(
  db: D1Database,
  spec: TableSpec,
  pks: string[]
): D1PreparedStatement[] {
  if (pks.length === 0) {
    return [];
  }

  const pkColumn = spec.columns.find((column) => column.source === spec.primaryKey);
  if (pkColumn === undefined) {
    throw new Error(`${spec.key}: primaryKey missing from columns`);
  }
  const table = quoteIdent(spec.targetTable);
  const pk = quoteIdent(targetColumn(pkColumn));
  const statements: D1PreparedStatement[] = [];

  for (let offset = 0; offset < pks.length; offset += D1_MAX_BOUND_PARAMS) {
    const chunk = pks.slice(offset, offset + D1_MAX_BOUND_PARAMS);
    const sql = guardSql(
      `DELETE FROM ${table} WHERE ${pk} IN (${chunk.map(() => "?").join(", ")})`
    );
    // Encoded, not bound raw: a key stored as INTEGER never matches a bound
    // string, because SQLite orders INTEGER before TEXT across storage classes.
    const values = chunk.map((value) => encodeValue(value, pkColumn.type));
    statements.push(db.prepare(sql).bind(...values));
  }

  return statements;
}

export function buildRunStartStatement(
  db: D1Database,
  spec: TableSpec,
  startedAt: string
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO _sync_state
         (table_key, last_run_started_at, last_run_status, last_error, rows_synced_last_run, runs_total)
       VALUES (?, ?, 'running', NULL, 0, 1)
       ON CONFLICT(table_key) DO UPDATE SET
         last_run_started_at  = excluded.last_run_started_at,
         last_run_status      = 'running',
         last_error           = NULL,
         rows_synced_last_run = 0,
         runs_total           = _sync_state.runs_total + 1`
    )
    .bind(spec.key, startedAt);
}

/**
 * The cursor advance. This statement is appended to EVERY page batch, never
 * issued on its own -- batch() is a transaction, so committing the cursor
 * alongside its rows is what makes an interrupted run safe to resume.
 */
export function buildCursorStatement(
  db: D1Database,
  spec: TableSpec,
  cursor: SyncCursor,
  delta: {
    rows: number;
    status: SyncRunStatus;
    finishedAt: string;
    error: string | null;
  }
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE _sync_state
          SET cursor_updated_at    = ?,
              cursor_pk            = ?,
              rows_synced_total    = rows_synced_total + ?,
              rows_synced_last_run = rows_synced_last_run + ?,
              last_run_finished_at = ?,
              last_run_status      = ?,
              last_error           = ?
        WHERE table_key = ?`
    )
    .bind(
      cursor?.updatedAt ?? null,
      cursor?.pk ?? null,
      delta.rows,
      delta.rows,
      delta.finishedAt,
      delta.status,
      delta.error,
      spec.key
    );
}

/** Advances only the reconcile walk, leaving the sync cursor untouched. */
export function buildReconcileCursorStatement(
  db: D1Database,
  spec: TableSpec,
  cursorPk: string | null,
  reconciledAt: string | null
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE _sync_state SET reconcile_cursor_pk = ?, reconciled_at = COALESCE(?, reconciled_at)
        WHERE table_key = ?`
    )
    .bind(cursorPk, reconciledAt, spec.key);
}

type SyncStateRow = {
  table_key: string;
  cursor_updated_at: string | null;
  cursor_pk: string | null;
  last_run_started_at: string | null;
  last_run_finished_at: string | null;
  last_run_status: string;
  last_error: string | null;
  rows_synced_total: number;
  rows_synced_last_run: number;
  runs_total: number;
  full_sync_epoch: number;
  reconcile_cursor_pk: string | null;
  reconciled_at: string | null;
};

const SELECT_STATE = `SELECT table_key, cursor_updated_at, cursor_pk, last_run_started_at,
         last_run_finished_at, last_run_status, last_error, rows_synced_total,
         rows_synced_last_run, runs_total, full_sync_epoch, reconcile_cursor_pk, reconciled_at
    FROM _sync_state`;

function toState(row: SyncStateRow): SyncState {
  return {
    tableKey: row.table_key,
    cursorUpdatedAt: row.cursor_updated_at,
    cursorPk: row.cursor_pk,
    lastRunStartedAt: row.last_run_started_at,
    lastRunFinishedAt: row.last_run_finished_at,
    lastRunStatus: row.last_run_status as SyncRunStatus,
    lastError: row.last_error,
    rowsSyncedTotal: row.rows_synced_total,
    rowsSyncedLastRun: row.rows_synced_last_run,
    runsTotal: row.runs_total,
    fullSyncEpoch: row.full_sync_epoch,
    reconcileCursorPk: row.reconcile_cursor_pk,
    reconciledAt: row.reconciled_at
  };
}

function emptyState(tableKey: string): SyncState {
  return {
    tableKey,
    cursorUpdatedAt: null,
    cursorPk: null,
    lastRunStartedAt: null,
    lastRunFinishedAt: null,
    lastRunStatus: "idle",
    lastError: null,
    rowsSyncedTotal: 0,
    rowsSyncedLastRun: 0,
    runsTotal: 0,
    fullSyncEpoch: 0,
    reconcileCursorPk: null,
    reconciledAt: null
  };
}

/** A table that has never run has no row yet; that is "never synced", not an error. */
export async function readState(db: D1Database, tableKey: string): Promise<SyncState> {
  const row = await db
    .prepare(`${SELECT_STATE} WHERE table_key = ?`)
    .bind(tableKey)
    .first<SyncStateRow>();
  return row === null ? emptyState(tableKey) : toState(row);
}

export async function readAllStates(db: D1Database): Promise<SyncState[]> {
  const result = await db.prepare(`${SELECT_STATE} ORDER BY table_key`).all<SyncStateRow>();
  return result.results.map(toState);
}

export function cursorOf(state: SyncState): SyncCursor {
  if (state.cursorUpdatedAt === null || state.cursorPk === null) {
    return null;
  }
  return { updatedAt: state.cursorUpdatedAt, pk: state.cursorPk };
}

/**
 * Clear the watermark so the next run re-reads the source from the beginning.
 *
 * `truncate` additionally empties the replica, in the same batch. It is needed
 * when the source has had hard deletes and the goal is a clean rebuild -- a
 * reset alone re-upserts everything and leaves orphans for the reconcile.
 */
export async function resetCursor(
  db: D1Database,
  spec: TableSpec,
  truncate: boolean
): Promise<void> {
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO _sync_state (table_key, last_run_status, full_sync_epoch)
         VALUES (?, 'idle', 1)
         ON CONFLICT(table_key) DO UPDATE SET
           cursor_updated_at   = NULL,
           cursor_pk           = NULL,
           reconcile_cursor_pk = NULL,
           last_run_status     = 'idle',
           last_error          = NULL,
           full_sync_epoch     = _sync_state.full_sync_epoch + 1`
      )
      .bind(spec.key)
  ];

  if (truncate) {
    statements.push(db.prepare(`DELETE FROM ${quoteIdent(spec.targetTable)}`));
  }

  await db.batch(statements);
}

/** Replica keys in the half-open range (afterPk, throughPk], for the reconcile. */
export async function readTargetKeys(
  db: D1Database,
  spec: TableSpec,
  afterPk: string | null,
  throughPk: string
): Promise<string[]> {
  const pkColumn = spec.columns.find((column) => column.source === spec.primaryKey);
  if (pkColumn === undefined) {
    throw new Error(`${spec.key}: primaryKey missing from columns`);
  }
  const table = quoteIdent(spec.targetTable);
  const pk = quoteIdent(targetColumn(pkColumn));

  const upper = encodeValue(throughPk, pkColumn.type);
  const statement =
    afterPk === null
      ? db.prepare(`SELECT ${pk} AS pk FROM ${table} WHERE ${pk} <= ? ORDER BY ${pk}`).bind(upper)
      : db
          .prepare(`SELECT ${pk} AS pk FROM ${table} WHERE ${pk} > ? AND ${pk} <= ? ORDER BY ${pk}`)
          .bind(encodeValue(afterPk, pkColumn.type), upper);

  const result = await statement.all<{ pk: string | number }>();
  return result.results.map((row) => String(row.pk));
}

/** Bytes the replica occupies after the last write, for growth tracking. */
export function sizeAfter(results: D1Result[]): number | null {
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const size = results[index]?.meta?.size_after;
    if (typeof size === "number") {
      return size;
    }
  }
  return null;
}
