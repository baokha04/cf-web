import type { SyncColumn, TableSpec } from "./types";

/**
 * Registered tables. Adding a table is a registry entry plus a D1 migration
 * creating the target table -- no new code.
 *
 * Preconditions the source must satisfy, because nothing here can check them
 * from inside the Worker:
 *   - a single-column primary key that is NOT NULL and unique;
 *   - a NOT NULL timestamp cursor column that EVERY write path moves (use a
 *     BEFORE UPDATE trigger, not caller discipline -- an update that skips the
 *     column is invisible to replication forever);
 *   - a composite index on (cursorColumn, primaryKey), or every tick is a full
 *     scan plus a sort.
 * See sql/postgres/0001_demo_items.sql for the shape.
 */
export const SYNC_TABLES: readonly TableSpec[] = [
  {
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
  }
];

/** SQL identifiers cannot be bound as parameters, so they are validated then quoted. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** D1 caps a table at 100 columns, and at 100 bound parameters per query. */
export const MAX_COLUMNS = 100;
export const MAX_PAGE_SIZE = 5000;

export const DEFAULT_PAGE_SIZE = 500;
export const DEFAULT_SAFETY_LAG_SECONDS = 5;

export function targetColumn(column: SyncColumn): string {
  return column.target ?? column.source;
}

function fail(spec: TableSpec, violation: string, action: string): never {
  throw new Error(
    `invalid TableSpec "${spec.key}": ${violation}. ${action} ` +
      "(rule: src/sync/registry.ts validateSpec)"
  );
}

function requireIdentifier(spec: TableSpec, label: string, value: string): void {
  if (!IDENTIFIER.test(value)) {
    fail(
      spec,
      `${label} "${value}" is not a bare SQL identifier`,
      "Rename it to match /^[A-Za-z_][A-Za-z0-9_]*$/."
    );
  }
}

/**
 * Runs once per sync run, before any SQL is issued.
 *
 * This is the injection boundary. Identifiers taken from a TableSpec are
 * INTERPOLATED into SQL because SQL cannot bind an identifier; every value is
 * bound. So this function is the only thing standing between the registry and
 * arbitrary SQL, and it fails closed.
 */
export function validateSpec(spec: TableSpec): void {
  requireIdentifier(spec, "schema", spec.schema);
  requireIdentifier(spec, "sourceTable", spec.sourceTable);
  requireIdentifier(spec, "targetTable", spec.targetTable);
  requireIdentifier(spec, "primaryKey", spec.primaryKey);
  requireIdentifier(spec, "cursorColumn", spec.cursorColumn);

  if (spec.columns.length === 0) {
    fail(spec, "columns is empty", "List every column to replicate.");
  }
  if (spec.columns.length > MAX_COLUMNS) {
    fail(
      spec,
      `${spec.columns.length} columns exceeds D1's limit of ${MAX_COLUMNS}`,
      "Drop columns the replica does not serve; columns is a projection."
    );
  }

  const sources = new Set<string>();
  const targets = new Set<string>();
  for (const column of spec.columns) {
    requireIdentifier(spec, "column source", column.source);
    const target = targetColumn(column);
    requireIdentifier(spec, "column target", target);
    if (sources.has(column.source)) {
      fail(spec, `duplicate source column "${column.source}"`, "Remove the duplicate.");
    }
    if (targets.has(target)) {
      fail(spec, `duplicate target column "${target}"`, "Give one of them a distinct target.");
    }
    sources.add(column.source);
    targets.add(target);
  }

  if (!sources.has(spec.primaryKey)) {
    fail(
      spec,
      `primaryKey "${spec.primaryKey}" is missing from columns`,
      "Add it -- the upsert conflict target and the cursor tie-break both need it."
    );
  }
  if (!sources.has(spec.cursorColumn)) {
    fail(
      spec,
      `cursorColumn "${spec.cursorColumn}" is missing from columns`,
      "Add it -- the watermark is read back from the replicated row."
    );
  }

  if (spec.softDeleteColumn !== undefined) {
    requireIdentifier(spec, "softDeleteColumn", spec.softDeleteColumn);
    if (!sources.has(spec.softDeleteColumn)) {
      fail(
        spec,
        `softDeleteColumn "${spec.softDeleteColumn}" is missing from columns`,
        "Add it, or drop softDeleteColumn."
      );
    }
  }

  const pageSize = spec.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    fail(
      spec,
      `pageSize ${pageSize} is outside 1..${MAX_PAGE_SIZE}`,
      "A page is held in memory and applied in one batch; keep it modest."
    );
  }

  const lag = spec.safetyLagSeconds ?? DEFAULT_SAFETY_LAG_SECONDS;
  if (!Number.isFinite(lag) || lag < 0) {
    fail(spec, `safetyLagSeconds ${lag} is negative`, "Use 0 or more.");
  }

  if (spec.reconcileDeletes === true) {
    validateReconcileOrdering(spec);
  }
}

/**
 * The delete reconcile walks primary keys in ranges on both sides and deletes
 * the difference. That is only correct when Postgres and D1 order the key
 * IDENTICALLY -- otherwise the range difference is wrong and the reconcile
 * deletes live rows.
 *
 * Agreements and disagreements that matter:
 *   uuid    stored TEXT    Postgres orders bytes, D1 orders the canonical
 *                          lowercase hyphenated form under BINARY. Agree.
 *   int4/8  stored INTEGER both numeric. Agree.
 *   int8    stored TEXT    "10" < "9" in D1, 9 < 10 in Postgres. DISAGREE.
 *   text    stored TEXT    Postgres uses the database collation (e.g.
 *                          en_US.UTF-8), D1 uses BINARY. Disagree unless the
 *                          query forces COLLATE "C", which pull.ts does.
 */
function validateReconcileOrdering(spec: TableSpec): void {
  const pkColumn = spec.columns.find((column) => column.source === spec.primaryKey);
  if (pkColumn === undefined) {
    fail(spec, "primaryKey is missing from columns", "Add it.");
  }

  const storedNumerically = pkColumn.type === "integer";
  const pgNumeric = spec.primaryKeyPgType === "integer" || spec.primaryKeyPgType === "bigint";

  if (pgNumeric && !storedNumerically) {
    fail(
      spec,
      `reconcileDeletes needs matching key order, but a ${spec.primaryKeyPgType} primary key ` +
        `is stored as "${pkColumn.type}" (TEXT) in D1, where "10" sorts before "9"`,
      'Store the key as an "integer" column, or set reconcileDeletes: false and rely on soft deletes.'
    );
  }
  if (!pgNumeric && storedNumerically) {
    fail(
      spec,
      `reconcileDeletes needs matching key order, but a ${spec.primaryKeyPgType} primary key ` +
        'is stored as an "integer" column in D1',
      'Store the key as a "text" column, or set reconcileDeletes: false.'
    );
  }
}

/** Validates the whole registry, including cross-spec uniqueness of `key`. */
export function validateRegistry(specs: readonly TableSpec[] = SYNC_TABLES): void {
  const keys = new Set<string>();
  for (const spec of specs) {
    if (keys.has(spec.key)) {
      throw new Error(
        `duplicate TableSpec key "${spec.key}". Keys are the primary key of _sync_state; ` +
          "two specs sharing one would share a cursor. (rule: src/sync/registry.ts validateRegistry)"
      );
    }
    keys.add(spec.key);
    validateSpec(spec);
  }
}

export function getSpec(key: string, specs: readonly TableSpec[] = SYNC_TABLES): TableSpec {
  const spec = specs.find((candidate) => candidate.key === key);
  if (spec === undefined) {
    throw new Error(
      `unknown table "${key}". Registered: ${specs.map((s) => s.key).join(", ") || "(none)"}`
    );
  }
  return spec;
}

/** All specs, or just the named ones. Throws on an unknown name. */
export function listSpecs(keys?: string[], specs: readonly TableSpec[] = SYNC_TABLES): TableSpec[] {
  if (keys === undefined || keys.length === 0) {
    return [...specs];
  }
  return keys.map((key) => getSpec(key, specs));
}
