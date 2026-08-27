import { describe, expect, it } from "vitest";
import { getSpec, listSpecs, validateRegistry, validateSpec } from "../../src/sync/registry";
import { DEMO_SPEC, specWith, wideSpec } from "./helpers";

/**
 * validateSpec is the injection boundary: identifiers from a TableSpec are
 * interpolated into SQL because SQL cannot bind an identifier. Every rejection
 * path below is load-bearing, not defensive decoration.
 */
describe("validateSpec", () => {
  it("accepts the shipped registry", () => {
    expect(() => validateRegistry()).not.toThrow();
  });

  it("accepts a well-formed spec", () => {
    expect(() => validateSpec(DEMO_SPEC)).not.toThrow();
  });

  it.each([
    ["sourceTable", { sourceTable: 'items"; DROP TABLE users --' }],
    ["schema", { schema: "public;--" }],
    ["targetTable", { targetTable: "demo items" }],
    ["primaryKey", { primaryKey: "1id" }],
    ["cursorColumn", { cursorColumn: "updated at" }]
  ])("rejects an unsafe %s", (_label, override) => {
    expect(() => validateSpec(specWith(override))).toThrow(/not a bare SQL identifier/);
  });

  it("rejects an unsafe column name", () => {
    const spec = specWith({
      columns: [
        { source: "id", type: "text" },
        { source: 'x" , (SELECT 1) --', type: "text" },
        { source: "updated_at", type: "timestamp" }
      ]
    });
    expect(() => validateSpec(spec)).toThrow(/not a bare SQL identifier/);
  });

  it("rejects a primary key missing from columns", () => {
    const spec = specWith({
      columns: [{ source: "updated_at", type: "timestamp" }],
      softDeleteColumn: undefined,
      reconcileDeletes: false
    });
    expect(() => validateSpec(spec)).toThrow(/primaryKey "id" is missing from columns/);
  });

  it("rejects a cursor column missing from columns", () => {
    const spec = specWith({
      columns: [{ source: "id", type: "text" }],
      softDeleteColumn: undefined,
      reconcileDeletes: false
    });
    expect(() => validateSpec(spec)).toThrow(/cursorColumn "updated_at" is missing/);
  });

  it("rejects a soft-delete column missing from columns", () => {
    expect(() => validateSpec(specWith({ softDeleteColumn: "gone" }))).toThrow(
      /softDeleteColumn "gone" is missing/
    );
  });

  it("rejects duplicate source and target columns", () => {
    expect(() =>
      validateSpec(
        specWith({
          columns: [
            { source: "id", type: "text" },
            { source: "id", type: "text" },
            { source: "updated_at", type: "timestamp" }
          ],
          softDeleteColumn: undefined
        })
      )
    ).toThrow(/duplicate source column/);

    expect(() =>
      validateSpec(
        specWith({
          columns: [
            { source: "id", type: "text" },
            { source: "name", target: "id", type: "text" },
            { source: "updated_at", type: "timestamp" }
          ],
          softDeleteColumn: undefined
        })
      )
    ).toThrow(/duplicate target column/);
  });

  it("rejects more columns than D1 allows", () => {
    expect(() => validateSpec(wideSpec(101))).toThrow(/exceeds D1's limit of 100/);
    expect(() => validateSpec(wideSpec(100))).not.toThrow();
  });

  it.each([0, -1, 5001, 1.5])("rejects pageSize %s", (pageSize) => {
    expect(() => validateSpec(specWith({ pageSize }))).toThrow(/is outside 1\.\.5000/);
  });

  it("rejects a negative safety lag", () => {
    expect(() => validateSpec(specWith({ safetyLagSeconds: -1 }))).toThrow(/is negative/);
  });

  it("accepts a zero safety lag", () => {
    expect(() => validateSpec(specWith({ safetyLagSeconds: 0 }))).not.toThrow();
  });
});

/**
 * The reconcile deletes the set difference of two key ranges, so it is only
 * correct when both sides order the key identically. Getting this wrong deletes
 * live rows, which is why it is rejected at registration rather than surviving
 * until the nightly cron.
 */
describe("validateSpec reconcile ordering", () => {
  it('rejects a bigint key stored as TEXT, where "10" sorts before "9"', () => {
    const spec = specWith({
      primaryKeyPgType: "bigint",
      columns: [
        { source: "id", type: "bigint" },
        { source: "updated_at", type: "timestamp" }
      ],
      softDeleteColumn: undefined,
      reconcileDeletes: true
    });
    expect(() => validateSpec(spec)).toThrow(/sorts before/);
  });

  it("rejects a uuid key stored as an integer column", () => {
    const spec = specWith({
      primaryKeyPgType: "uuid",
      columns: [
        { source: "id", type: "integer" },
        { source: "updated_at", type: "timestamp" }
      ],
      softDeleteColumn: undefined,
      reconcileDeletes: true
    });
    expect(() => validateSpec(spec)).toThrow(/is stored as an "integer" column/);
  });

  it("accepts a bigint key stored as an INTEGER column", () => {
    const spec = specWith({
      primaryKeyPgType: "bigint",
      columns: [
        { source: "id", type: "integer" },
        { source: "updated_at", type: "timestamp" }
      ],
      softDeleteColumn: undefined,
      reconcileDeletes: true
    });
    expect(() => validateSpec(spec)).not.toThrow();
  });

  it("allows the unsafe pairing when reconcileDeletes is off", () => {
    const spec = specWith({
      primaryKeyPgType: "bigint",
      columns: [
        { source: "id", type: "bigint" },
        { source: "updated_at", type: "timestamp" }
      ],
      softDeleteColumn: undefined,
      reconcileDeletes: false
    });
    expect(() => validateSpec(spec)).not.toThrow();
  });
});

describe("registry lookup", () => {
  it("rejects two specs sharing a key, since they would share a cursor", () => {
    expect(() => validateRegistry([DEMO_SPEC, DEMO_SPEC])).toThrow(/duplicate TableSpec key/);
  });

  it("throws on an unknown table and names what is registered", () => {
    expect(() => getSpec("nope")).toThrow(/unknown table "nope".*demo_items/s);
  });

  it("returns every spec when no filter is given", () => {
    expect(listSpecs().map((spec) => spec.key)).toEqual(["demo_items"]);
    expect(listSpecs([]).map((spec) => spec.key)).toEqual(["demo_items"]);
  });
});
