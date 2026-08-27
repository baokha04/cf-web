import { describe, expect, it } from "vitest";
import {
  D1_MAX_BOUND_PARAMS,
  buildDeleteStatements,
  buildUpsertStatements,
  encodeValue,
  quoteIdent,
  rowsPerStatement
} from "../../src/sync/apply";
import { DEMO_SPEC, demoRow, fakeDb, specWith, wideSpec } from "./helpers";
import type { CapturedStatement } from "./helpers";

describe("quoteIdent", () => {
  it("quotes and doubles embedded quotes", () => {
    expect(quoteIdent("demo_items")).toBe('"demo_items"');
    expect(quoteIdent('a"b')).toBe('"a""b"');
  });
});

describe("encodeValue", () => {
  it("maps null and undefined to NULL", () => {
    expect(encodeValue(null, "text")).toBeNull();
    expect(encodeValue(undefined, "integer")).toBeNull();
  });

  it("keeps int8 and numeric exact by storing them as TEXT", () => {
    // 9007199254740993 is Number.MAX_SAFE_INTEGER + 2: a JS number rounds it to
    // ...992 and nobody notices until the column is summed.
    expect(encodeValue("9007199254740993", "bigint")).toBe("9007199254740993");
    expect(encodeValue("0.1000000000000000001", "numeric")).toBe("0.1000000000000000001");
  });

  it("throws rather than rounding an unsafe integer", () => {
    expect(() => encodeValue("9007199254740993", "integer")).toThrow(/not a safe integer/);
    expect(() => encodeValue(2n ** 70n, "integer")).toThrow(/outside the JS safe range/);
  });

  it("throws when a bigint arrived as an already-lossy JS number", () => {
    expect(() => encodeValue(9007199254740994, "bigint")).toThrow(/already lost precision/);
  });

  it("accepts safe integers as numbers", () => {
    expect(encodeValue(42, "integer")).toBe(42);
    expect(encodeValue("42", "integer")).toBe(42);
    expect(encodeValue(10n, "integer")).toBe(10);
  });

  it("maps booleans to 0/1 in every representation Postgres emits", () => {
    expect(encodeValue(true, "boolean")).toBe(1);
    expect(encodeValue(false, "boolean")).toBe(0);
    expect(encodeValue("t", "boolean")).toBe(1);
    expect(encodeValue("f", "boolean")).toBe(0);
    expect(() => encodeValue("maybe", "boolean")).toThrow(/is not recognised/);
  });

  it("normalises every timestamp shape to ISO-8601 UTC", () => {
    expect(encodeValue(new Date("2026-08-27T10:00:00Z"), "timestamp")).toBe(
      "2026-08-27T10:00:00.000Z"
    );
    // A `timestamp without time zone` arrives as raw text with no offset. It is
    // read as UTC, never as the runtime's local time.
    expect(encodeValue("2026-08-27 10:00:00", "timestamp")).toBe("2026-08-27T10:00:00.000Z");
    // Postgres renders a one-part offset; Date needs the two-part form.
    expect(encodeValue("2026-08-27 10:00:00+07", "timestamp")).toBe("2026-08-27T03:00:00.000Z");
    expect(encodeValue("2026-08-27", "timestamp")).toBe("2026-08-27T00:00:00.000Z");
    expect(() => encodeValue("not a date", "timestamp")).toThrow(/cannot parse/);
    expect(() => encodeValue(new Date(Number.NaN), "timestamp")).toThrow(/Invalid Date/);
  });

  it("serialises json and passes through text that is already JSON", () => {
    expect(encodeValue({ n: 1 }, "json")).toBe('{"n":1}');
    expect(encodeValue([1, 2], "json")).toBe("[1,2]");
    expect(encodeValue('{"n":1}', "json")).toBe('{"n":1}');
  });

  it("converts a byte view to a standalone ArrayBuffer", () => {
    const source = new Uint8Array([1, 2, 3, 4]);
    const encoded = encodeValue(source.subarray(1, 3), "blob");
    expect(encoded).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(encoded as ArrayBuffer)]).toEqual([2, 3]);
    expect(() => encodeValue("nope", "blob")).toThrow(/neither ArrayBuffer nor a view/);
  });

  it("rejects a value over D1's 2 MB cap and names the limit", () => {
    expect(() => encodeValue("x".repeat(2_000_001), "text")).toThrow(/exceeds D1's 2000000-byte cap/);
    expect(() => encodeValue(new ArrayBuffer(2_000_001), "blob")).toThrow(/BLOB value/);
  });

  it("does not reject a large value that is still under the cap", () => {
    expect(encodeValue("x".repeat(1_000_000), "text")).toHaveLength(1_000_000);
  });

  it("rejects a non-finite real", () => {
    expect(encodeValue(1.5, "real")).toBe(1.5);
    expect(() => encodeValue("abc", "real")).toThrow(/is not finite/);
  });
});

/**
 * The 100-bound-parameter limit is the tightest constraint in the design and
 * the easiest to get wrong by one.
 */
describe("rowsPerStatement", () => {
  it("packs 100 rows when the key is the only column", () => {
    const spec = specWith({
      cursorColumn: "id",
      columns: [{ source: "id", type: "text" }],
      softDeleteColumn: undefined,
      reconcileDeletes: false
    });
    expect(rowsPerStatement(spec)).toBe(100);
  });

  it.each([
    [2, 50],
    [9, 11],
    [30, 3],
    [50, 2],
    [51, 1],
    [100, 1]
  ])("fits %i columns into %i rows per statement", (columns, expected) => {
    expect(rowsPerStatement(wideSpec(columns))).toBe(expected);
  });
});

describe("buildUpsertStatements", () => {
  it("chunks a page so no statement exceeds the parameter limit", () => {
    const captured: CapturedStatement[] = [];
    const rows = Array.from({ length: 25 }, (_unused, index) =>
      demoRow({ id: `id-${index}`, name: `item-${index}` })
    );

    buildUpsertStatements(fakeDb(captured), DEMO_SPEC, rows);

    // 9 columns -> 11 rows per statement -> 11 + 11 + 3.
    expect(captured.map((statement) => statement.values.length)).toEqual([99, 99, 27]);
    for (const statement of captured) {
      expect(statement.values.length).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
    }
  });

  it("emits nothing for an empty page", () => {
    const captured: CapturedStatement[] = [];
    expect(buildUpsertStatements(fakeDb(captured), DEMO_SPEC, [])).toEqual([]);
    expect(captured).toHaveLength(0);
  });

  it("guards the upsert with a last-writer-wins comparison on the cursor", () => {
    const captured: CapturedStatement[] = [];
    buildUpsertStatements(fakeDb(captured), DEMO_SPEC, [demoRow()]);

    const { sql } = captured[0]!;
    expect(sql).toContain('ON CONFLICT("id") DO UPDATE SET');
    expect(sql).toContain('WHERE excluded."updated_at" >= "demo_items"."updated_at"');
    // The conflict target is never reassigned.
    expect(sql).not.toContain('"id" = excluded."id"');
  });

  it("falls back to DO NOTHING when there is nothing but the key to update", () => {
    const captured: CapturedStatement[] = [];
    const spec = specWith({
      cursorColumn: "id",
      columns: [{ source: "id", type: "text" }],
      softDeleteColumn: undefined,
      reconcileDeletes: false
    });
    buildUpsertStatements(fakeDb(captured), spec, [{ id: "a" }]);
    expect(captured[0]!.sql).toContain('ON CONFLICT("id") DO NOTHING');
  });

  it("names the table and column when a value cannot be encoded", () => {
    const captured: CapturedStatement[] = [];
    expect(() =>
      buildUpsertStatements(fakeDb(captured), DEMO_SPEC, [demoRow({ qty: "9007199254740993" })])
    ).toThrow(/demo_items\.qty/);
  });

  it("honours a target column rename", () => {
    const captured: CapturedStatement[] = [];
    const spec = specWith({
      columns: [
        { source: "id", type: "text" },
        { source: "name", target: "title", type: "text" },
        { source: "updated_at", type: "timestamp" }
      ],
      softDeleteColumn: undefined
    });
    buildUpsertStatements(fakeDb(captured), spec, [demoRow()]);
    expect(captured[0]!.sql).toContain('"title"');
    expect(captured[0]!.sql).toContain('"title" = excluded."title"');
  });
});

describe("buildDeleteStatements", () => {
  it("chunks keys at the parameter limit", () => {
    const captured: CapturedStatement[] = [];
    const keys = Array.from({ length: 250 }, (_unused, index) => `id-${index}`);
    buildDeleteStatements(fakeDb(captured), DEMO_SPEC, keys);
    expect(captured.map((statement) => statement.values.length)).toEqual([100, 100, 50]);
  });

  it("emits nothing for an empty key list", () => {
    const captured: CapturedStatement[] = [];
    expect(buildDeleteStatements(fakeDb(captured), DEMO_SPEC, [])).toEqual([]);
  });

  it("encodes keys into their D1 storage class", () => {
    const captured: CapturedStatement[] = [];
    const spec = specWith({
      primaryKeyPgType: "integer",
      columns: [
        { source: "id", type: "integer" },
        { source: "updated_at", type: "timestamp" }
      ],
      softDeleteColumn: undefined
    });
    buildDeleteStatements(fakeDb(captured), spec, ["7", "8"]);
    // Bound as numbers, not strings: SQLite orders INTEGER before TEXT across
    // storage classes, so a bound string would never match an INTEGER key.
    expect(captured[0]!.values).toEqual([7, 8]);
  });
});
