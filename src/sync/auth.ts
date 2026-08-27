/**
 * Bearer guard for the /__sync/* routes.
 *
 * Separate from ./http.ts so it carries no transitive Postgres dependency and
 * can be exercised directly.
 */

const encoder = new TextEncoder();

async function sha256(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", encoder.encode(value));
}

/**
 * Compare two buffers without an early exit on the first differing byte.
 *
 * workerd does offer crypto.subtle.timingSafeEqual, but it is a Cloudflare
 * extension this project's type resolution does not see (@types/node's
 * SubtleCrypto wins), and it throws on a length mismatch -- a throw that is
 * itself a side channel leaking the token's length. Hashing to a fixed 32 bytes
 * removes that difference at the source, which leaves nothing for the extension
 * to add over a plain XOR accumulation.
 */
export function constantTimeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

export async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  const expected = env.SYNC_TRIGGER_TOKEN;
  // Fail closed: no secret configured means no access, not open access.
  if (expected === undefined || expected === "") {
    return false;
  }
  const presented = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const [a, b] = await Promise.all([sha256(presented), sha256(expected)]);
  return constantTimeEqual(a, b);
}
