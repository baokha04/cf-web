import { describe, expect, it } from "vitest";
import { constantTimeEqual } from "../../src/sync/auth";

function bytes(...values: number[]): ArrayBuffer {
  return new Uint8Array(values).buffer;
}

describe("constantTimeEqual", () => {
  it("accepts identical buffers", () => {
    expect(constantTimeEqual(bytes(1, 2, 3), bytes(1, 2, 3))).toBe(true);
  });

  it("rejects a difference in any position", () => {
    expect(constantTimeEqual(bytes(1, 2, 3), bytes(9, 2, 3))).toBe(false);
    expect(constantTimeEqual(bytes(1, 2, 3), bytes(1, 2, 9))).toBe(false);
  });

  it("rejects differing lengths instead of throwing", () => {
    // The callers always hash first, so lengths match in practice; returning
    // false rather than throwing means a length mismatch is not a side channel.
    expect(constantTimeEqual(bytes(1, 2), bytes(1, 2, 3))).toBe(false);
  });

  it("accepts two empty buffers", () => {
    expect(constantTimeEqual(bytes(), bytes())).toBe(true);
  });
});
