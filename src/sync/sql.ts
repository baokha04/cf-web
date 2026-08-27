import { quoteIdent } from "./apply";
import { DEFAULT_PAGE_SIZE, DEFAULT_SAFETY_LAG_SECONDS } from "./registry";
import type { PrimaryKeyPgType, SyncCursor, TableSpec } from "./types";

/**
 * The Postgres queries, built from a TableSpec.
 *
 * Kept free of any pg import so the query shapes -- the part that quietly loses
 * rows when it is wrong -- can be asserted without a database or a driver.
 * ./pull.ts owns the connection and executes these.
 */

/** Cast applied to the resumed cursor so the source index stays seekable. */
const PK_CAST: Record<PrimaryKeyPgType, string> = {
  uuid: "uuid",
  text: "text",
  integer: "integer",
  bigint: "bigint"
};

function qualifiedTable(spec: TableSpec): string {
  return `${quoteIdent(spec.schema)}.${quoteIdent(spec.sourceTable)}`;
}

/**
 * The incremental page.
 *
 * The cursor is a row-value on (cursorColumn, primaryKey), and that is the
 * whole point. `WHERE updated_at > $1` skips every row sharing the boundary
 * timestamp -- and shared timestamps are the normal case, because a bulk UPDATE
 * using now() stamps transaction time, identical across every row it touches.
 * `>=` instead re-reads the boundary forever and livelocks once more rows share
 * one timestamp than fit in a page. A row-value comparison is evaluated
 * lexicographically and Postgres can still satisfy it as a single index seek on
 * the composite btree (cursorColumn, primaryKey).
 *
 * The cursor-NULL case is a separate statement rather than
 * `$1 IS NULL OR (...)`, because the OR form defeats that seek -- and this is
 * the branch the entire initial backfill runs through.
 *
 * Collation is deliberately NOT forced here. This ordering only has to be
 * self-consistent within Postgres across runs; D1 never participates in it.
 * The reconcile walk is where the two sides must agree -- see buildKeyPageSql.
 */
export function buildPullSql(
  spec: TableSpec,
  cursor: SyncCursor
): { text: string; values: unknown[] } {
  const table = qualifiedTable(spec);
  const columns = spec.columns.map((column) => quoteIdent(column.source)).join(", ");
  const cursorColumn = quoteIdent(spec.cursorColumn);
  const pk = quoteIdent(spec.primaryKey);
  const lag = spec.safetyLagSeconds ?? DEFAULT_SAFETY_LAG_SECONDS;
  const limit = spec.pageSize ?? DEFAULT_PAGE_SIZE;

  // The lag is evaluated on the Postgres clock, so there is no Worker/Postgres
  // skew to reason about.
  if (cursor === null) {
    return {
      text:
        `SELECT ${columns} FROM ${table}\n` +
        `WHERE ${cursorColumn} <= now() - make_interval(secs => $1::double precision)\n` +
        `ORDER BY ${cursorColumn} ASC, ${pk} ASC\n` +
        "LIMIT $2",
      values: [lag, limit]
    };
  }

  return {
    text:
      `SELECT ${columns} FROM ${table}\n` +
      `WHERE (${cursorColumn}, ${pk}) > ($1::timestamptz, $2::${PK_CAST[spec.primaryKeyPgType]})\n` +
      `  AND ${cursorColumn} <= now() - make_interval(secs => $3::double precision)\n` +
      `ORDER BY ${cursorColumn} ASC, ${pk} ASC\n` +
      "LIMIT $4",
    values: [cursor.updatedAt, cursor.pk, lag, limit]
  };
}

/**
 * Key page for the delete reconcile.
 *
 * Here the two sides MUST order the key identically, because the reconcile
 * deletes the set difference of two ranges. A Postgres `text` column uses the
 * database collation (e.g. en_US.UTF-8) while D1 uses BINARY, so text keys are
 * forced to COLLATE "C". Note that forcing it will not use a plain btree index
 * -- a source with many text keys wants a matching `COLLATE "C"` index.
 */
export function buildKeyPageSql(
  spec: TableSpec,
  afterPk: string | null,
  limit: number
): { text: string; values: unknown[] } {
  const table = qualifiedTable(spec);
  const pk = quoteIdent(spec.primaryKey);
  const ordered = spec.primaryKeyPgType === "text" ? `${pk} COLLATE "C"` : pk;

  if (afterPk === null) {
    return {
      text: `SELECT ${pk} AS pk FROM ${table} ORDER BY ${ordered} ASC LIMIT $1`,
      values: [limit]
    };
  }

  return {
    text:
      `SELECT ${pk} AS pk FROM ${table}\n` +
      `WHERE ${ordered} > $1::${PK_CAST[spec.primaryKeyPgType]}\n` +
      `ORDER BY ${ordered} ASC\n` +
      "LIMIT $2",
    values: [afterPk, limit]
  };
}

export function buildHighWaterMarkSql(spec: TableSpec): string {
  return (
    `SELECT count(*)::text AS n, max(${quoteIdent(spec.cursorColumn)}) AS hwm ` +
    `FROM ${qualifiedTable(spec)}`
  );
}
