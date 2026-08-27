import { describe, expect, it } from "vitest";
import { buildKeyPageSql, buildPullSql } from "../../src/sync/sql";
import { DEMO_SPEC, specWith } from "./helpers";

/**
 * The pull query is where a naive watermark loses rows. These assertions pin
 * the two things that prevent it: a row-value comparison rather than a bare
 * `>`, and a separate statement for the cursor-NULL case rather than an OR that
 * would defeat the index seek.
 */
describe("buildPullSql", () => {
  it("emits a seekable initial page when there is no cursor", () => {
    const { text, values } = buildPullSql(DEMO_SPEC, null);

    expect(text).not.toContain("IS NULL");
    expect(text).not.toContain('("updated_at", "id")');
    expect(text).toContain("make_interval(secs => $1::double precision)");
    expect(text).toContain('ORDER BY "updated_at" ASC, "id" ASC');
    expect(text).toContain("LIMIT $2");
    expect(values).toEqual([5, 500]);
  });

  it("seeks on (cursorColumn, primaryKey) rather than the timestamp alone", () => {
    const { text, values } = buildPullSql(DEMO_SPEC, {
      updatedAt: "2026-08-27T10:00:00.000Z",
      pk: "abc"
    });

    // A bulk UPDATE stamps one now() across every row it touches, so a bare
    // `updated_at > $1` would skip the whole tail of that timestamp.
    expect(text).toContain('WHERE ("updated_at", "id") > ($1::timestamptz, $2::uuid)');
    expect(text).toContain('ORDER BY "updated_at" ASC, "id" ASC');
    expect(values).toEqual(["2026-08-27T10:00:00.000Z", "abc", 5, 500]);
  });

  it.each([
    ["uuid", "$2::uuid"],
    ["text", "$2::text"],
    ["integer", "$2::integer"],
    ["bigint", "$2::bigint"]
  ] as const)("casts a resumed %s cursor back to the source type", (pgType, cast) => {
    const { text } = buildPullSql(
      specWith({ primaryKeyPgType: pgType, reconcileDeletes: false }),
      { updatedAt: "2026-08-27T10:00:00.000Z", pk: "1" }
    );
    expect(text).toContain(cast);
  });

  it("carries the spec's page size and safety lag", () => {
    const { values } = buildPullSql(specWith({ pageSize: 42, safetyLagSeconds: 30 }), null);
    expect(values).toEqual([30, 42]);
  });

  it("falls back to the registry defaults", () => {
    const spec = specWith({ pageSize: undefined, safetyLagSeconds: undefined });
    expect(buildPullSql(spec, null).values).toEqual([5, 500]);
  });

  it("selects exactly the registered columns", () => {
    const { text } = buildPullSql(DEMO_SPEC, null);
    for (const column of DEMO_SPEC.columns) {
      expect(text).toContain(`"${column.source}"`);
    }
  });

  it("qualifies the table with its schema", () => {
    expect(buildPullSql(DEMO_SPEC, null).text).toContain('FROM "public"."demo_items"');
  });
});

/**
 * Only the reconcile walk needs the two sides to agree on key order, so the
 * collation is forced here and deliberately not in buildPullSql.
 */
describe("buildKeyPageSql", () => {
  it("forces COLLATE \"C\" for a text key, matching D1's BINARY ordering", () => {
    const spec = specWith({
      primaryKeyPgType: "text",
      columns: [
        { source: "id", type: "text" },
        { source: "updated_at", type: "timestamp" }
      ],
      softDeleteColumn: undefined
    });
    const { text } = buildKeyPageSql(spec, "a", 1000);
    expect(text).toContain('"id" COLLATE "C" > $1::text');
    expect(text).toContain('ORDER BY "id" COLLATE "C" ASC');
  });

  it("leaves a uuid key alone, since byte order already agrees", () => {
    const { text } = buildKeyPageSql(DEMO_SPEC, "a", 1000);
    expect(text).not.toContain("COLLATE");
    expect(text).toContain('WHERE "id" > $1::uuid');
  });

  it("omits the lower bound on the first page", () => {
    const { text, values } = buildKeyPageSql(DEMO_SPEC, null, 1000);
    expect(text).not.toContain("WHERE");
    expect(values).toEqual([1000]);
  });
});
