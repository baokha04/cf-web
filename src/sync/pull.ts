import { Client, types } from "pg";
import { encodeValue } from "./apply";
import { DEFAULT_PAGE_SIZE } from "./registry";
import { buildHighWaterMarkSql, buildKeyPageSql, buildPullSql } from "./sql";
import type { SyncCursor, TableSpec } from "./types";

/**
 * The Postgres side: connection, type parsing, and executing the queries that
 * ./sql.ts builds.
 *
 * node-postgres parses `date` (OID 1082) and `timestamp` (1114) into JS Date
 * objects interpreted in the HOST timezone, which silently shifts the value by
 * the runtime's offset. Keeping them as raw wire text and normalising in
 * encodeValue is the only way to get a stable instant into D1. `timestamptz`
 * (1184) is unambiguous and is left as a Date.
 *
 * int8 (20) already comes back as a string; pinned here so a future pg release
 * cannot start rounding it under us.
 */
types.setTypeParser(1082, (value: string) => value);
types.setTypeParser(1114, (value: string) => value);
types.setTypeParser(20, (value: string) => value);

/**
 * Hyperdrive hands the Worker a local address; the real credentials live in the
 * Hyperdrive config in Cloudflare, never in the Worker's env.
 */
export async function openPg(env: Env): Promise<Client> {
  const client = new Client({ connectionString: env.PG.connectionString });
  await client.connect();
  return client;
}

/** Never throws: a failed close must not mask the run's real outcome. */
export async function closePg(client: Client): Promise<void> {
  try {
    await client.end();
  } catch (cause) {
    console.log(
      JSON.stringify({
        event: "sync.pg.close_failed",
        message: cause instanceof Error ? cause.message : String(cause)
      })
    );
  }
}

export type PulledPage = {
  rows: Record<string, unknown>[];
  nextCursor: SyncCursor;
  hasMore: boolean;
};

export async function pullPage(
  client: Client,
  spec: TableSpec,
  cursor: SyncCursor
): Promise<PulledPage> {
  const { text, values } = buildPullSql(spec, cursor);
  const result = await client.query<Record<string, unknown>>(text, values);
  const rows = result.rows;

  if (rows.length === 0) {
    return { rows, nextCursor: cursor, hasMore: false };
  }

  const last = rows[rows.length - 1]!;
  const nextCursor: SyncCursor = {
    // Normalised through the same encoder that writes the column, so the value
    // stored in _sync_state is byte-identical to the one stored in the row.
    updatedAt: encodeValue(last[spec.cursorColumn], "timestamp") as string,
    pk: String(last[spec.primaryKey])
  };

  const pageSize = spec.pageSize ?? DEFAULT_PAGE_SIZE;
  return { rows, nextCursor, hasMore: rows.length === pageSize };
}

export async function pullKeyPage(
  client: Client,
  spec: TableSpec,
  afterPk: string | null,
  limit: number
): Promise<{ keys: string[]; lastPk: string | null; hasMore: boolean }> {
  const { text, values } = buildKeyPageSql(spec, afterPk, limit);
  const result = await client.query<{ pk: unknown }>(text, values);
  const keys = result.rows.map((row) => String(row.pk));
  return {
    keys,
    lastPk: keys.length === 0 ? null : keys[keys.length - 1]!,
    hasMore: keys.length === limit
  };
}

/** Source-side totals, for the parity check /__sync/status reports. */
export async function sourceHighWaterMark(
  client: Client,
  spec: TableSpec
): Promise<{ count: number; maxCursor: string | null }> {
  const result = await client.query<{ n: string; hwm: unknown }>(buildHighWaterMarkSql(spec));
  const row = result.rows[0];
  return {
    count: row === undefined ? 0 : Number(row.n),
    maxCursor:
      row === undefined || row.hwm === null
        ? null
        : (encodeValue(row.hwm, "timestamp") as string)
  };
}

/**
 * Assert the source actually satisfies the spec's preconditions. Cheap enough
 * to run on demand from /__sync/status, and the only place the invariants the
 * registry documents are checked against reality.
 */
export async function preflight(
  client: Client,
  spec: TableSpec
): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [];

  const columns = await client.query<{
    column_name: string;
    data_type: string;
    is_nullable: string;
  }>(
    `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2`,
    [spec.schema, spec.sourceTable]
  );

  if (columns.rows.length === 0) {
    return {
      ok: false,
      problems: [`${spec.schema}.${spec.sourceTable} does not exist or is not visible`]
    };
  }

  const byName = new Map(columns.rows.map((row) => [row.column_name, row]));

  for (const column of spec.columns) {
    if (!byName.has(column.source)) {
      problems.push(`column "${column.source}" is missing from the source table`);
    }
  }

  const pk = byName.get(spec.primaryKey);
  if (pk !== undefined && pk.is_nullable !== "NO") {
    problems.push(`primary key "${spec.primaryKey}" is nullable; the cursor tie-break needs NOT NULL`);
  }

  const cursor = byName.get(spec.cursorColumn);
  if (cursor !== undefined) {
    if (cursor.is_nullable !== "NO") {
      problems.push(
        `cursor column "${spec.cursorColumn}" is nullable; a NULL watermark is invisible to replication`
      );
    }
    if (!cursor.data_type.startsWith("timestamp")) {
      problems.push(
        `cursor column "${spec.cursorColumn}" is ${cursor.data_type}, expected a timestamp type`
      );
    }
  }

  const indexes = await client.query<{ indexdef: string }>(
    "SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2",
    [spec.schema, spec.sourceTable]
  );
  const hasCompositeIndex = indexes.rows.some(
    (row) => row.indexdef.includes(spec.cursorColumn) && row.indexdef.includes(spec.primaryKey)
  );
  if (!hasCompositeIndex) {
    problems.push(
      `no index covering (${spec.cursorColumn}, ${spec.primaryKey}); every tick will be a full scan plus a sort`
    );
  }

  const triggers = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM information_schema.triggers
      WHERE event_object_schema = $1 AND event_object_table = $2
        AND action_timing = 'BEFORE' AND event_manipulation = 'UPDATE'`,
    [spec.schema, spec.sourceTable]
  );
  if (Number(triggers.rows[0]?.count ?? "0") === 0) {
    problems.push(
      `no BEFORE UPDATE trigger; if any write path forgets ${spec.cursorColumn}, that row is invisible to replication forever`
    );
  }

  return { ok: problems.length === 0, problems };
}
