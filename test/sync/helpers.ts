import type { SyncColumn, TableSpec } from "../../src/sync/types";

/**
 * Captures what a statement builder would send to D1 without needing a
 * database, so SQL shape and parameter counts can be asserted directly. The
 * behavioural properties (atomicity, last-writer-wins) are tested against a
 * real D1 in d1.test.ts instead -- those belong to SQLite, not to these strings.
 */
export type CapturedStatement = { sql: string; values: unknown[] };

export function fakeDb(captured: CapturedStatement[]): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          const statement = { sql, values };
          captured.push(statement);
          return statement;
        }
      };
    }
  } as unknown as D1Database;
}

export const DEMO_SPEC: TableSpec = {
  key: "demo_items",
  schema: "public",
  sourceTable: "demo_items",
  targetTable: "demo_items",
  primaryKey: "id",
  primaryKeyPgType: "uuid",
  cursorColumn: "updated_at",
  columns: [
    { source: "id", type: "text" },
    { source: "name", type: "text" },
    { source: "qty", type: "integer" },
    { source: "price_cents", type: "bigint" },
    { source: "metadata", type: "json" },
    { source: "is_active", type: "boolean" },
    { source: "deleted_at", type: "timestamp" },
    { source: "created_at", type: "timestamp" },
    { source: "updated_at", type: "timestamp" }
  ],
  softDeleteColumn: "deleted_at",
  onSoftDelete: "mirror",
  pageSize: 500,
  safetyLagSeconds: 5,
  reconcileDeletes: true
};

export function specWith(overrides: Partial<TableSpec>): TableSpec {
  return { ...DEMO_SPEC, ...overrides };
}

/** A spec with `count` columns, for exercising the 100-parameter arithmetic. */
export function wideSpec(count: number): TableSpec {
  const columns: SyncColumn[] = [
    { source: "id", type: "text" },
    { source: "updated_at", type: "timestamp" }
  ];
  for (let index = columns.length; index < count; index += 1) {
    columns.push({ source: `c${index}`, type: "text" });
  }
  return specWith({ columns, softDeleteColumn: undefined, reconcileDeletes: false });
}

export function demoRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "item",
    qty: 1,
    price_cents: "100",
    metadata: { n: 1 },
    is_active: true,
    deleted_at: null,
    created_at: "2026-08-27 10:00:00+00",
    updated_at: "2026-08-27 10:00:00+00",
    ...overrides
  };
}
