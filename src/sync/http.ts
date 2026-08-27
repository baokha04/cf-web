import { quoteIdent, readAllStates } from "./apply";
import { isAuthorized } from "./auth";
import { closePg, openPg, preflight, sourceHighWaterMark } from "./pull";
import { listSpecs } from "./registry";
import { isSyncEnabled, resetTable, runReconcile, runSync } from "./run";

/**
 * On-demand control surface for the sync, for operating and for proving it
 * works without waiting for a cron tick.
 *
 *   POST /__sync/run        ?tables=a,b&maxPages=3
 *   GET  /__sync/status     ?preflight=1
 *   POST /__sync/reset      { "table": "...", "truncate": false }
 *   POST /__sync/reconcile  ?tables=a,b
 */

function tablesParam(url: URL): string[] | undefined {
  const raw = url.searchParams.get("tables");
  if (raw === null) {
    return undefined;
  }
  const tables = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return tables.length === 0 ? undefined : tables;
}

function numberParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** A run that never wrote a terminal status: the isolate died mid-tick. */
const STUCK_AFTER_MS = 900_000;

async function status(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const states = await readAllStates(env.REPLICA);
  const byKey = new Map(states.map((state) => [state.tableKey, state]));
  const specs = listSpecs(tablesParam(url));
  const now = Date.now();

  const tables = specs.map((spec) => {
    const state = byKey.get(spec.key);
    const cursorAt = state?.cursorUpdatedAt ?? null;
    const parsed = cursorAt === null ? Number.NaN : Date.parse(cursorAt);
    const startedAt = state?.lastRunStartedAt === undefined || state.lastRunStartedAt === null
      ? Number.NaN
      : Date.parse(state.lastRunStartedAt);

    return {
      table: spec.key,
      state: state ?? null,
      neverSynced: cursorAt === null,
      // The number to alert on: how far behind the source the replica is.
      lagSeconds: Number.isNaN(parsed) ? null : Math.round((now - parsed) / 1000),
      // Self-heals on the next tick, since the run-start statement resets it,
      // but worth surfacing rather than hiding.
      stuck:
        state?.lastRunStatus === "running" &&
        !Number.isNaN(startedAt) &&
        now - startedAt > STUCK_AFTER_MS
    };
  });

  if (url.searchParams.get("preflight") === null) {
    return Response.json({ enabled: isSyncEnabled(env), tables });
  }

  // Preflight also touches Postgres, so it is opt-in rather than the default.
  const pg = await openPg(env);
  try {
    const checks = [];
    for (const spec of specs) {
      const [source, precondition, replica] = await Promise.all([
        sourceHighWaterMark(pg, spec),
        preflight(pg, spec),
        env.REPLICA.prepare(
          `SELECT count(*) AS n FROM ${quoteIdent(spec.targetTable)}`
        ).first<{ n: number }>()
      ]);
      checks.push({
        table: spec.key,
        preflight: precondition,
        sourceCount: source.count,
        sourceMaxCursor: source.maxCursor,
        replicaCount: replica?.n ?? 0
      });
    }
    return Response.json({ enabled: isSyncEnabled(env), tables, checks });
  } finally {
    await closePg(pg);
  }
}

/** Returns undefined for non-/__sync/ paths so fetch() falls through to the agent. */
export async function handleSyncRequest(
  request: Request,
  env: Env
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/__sync/")) {
    return undefined;
  }
  if (!(await isAuthorized(request, env))) {
    return new Response("Forbidden", { status: 403 });
  }

  const route = `${request.method} ${url.pathname}`;

  try {
    if (route === "GET /__sync/status") {
      return await status(request, env);
    }

    if (route === "POST /__sync/run") {
      const result = await runSync(env, {
        trigger: "http",
        ...(tablesParam(url) === undefined ? {} : { tables: tablesParam(url) }),
        ...(numberParam(url, "maxPages") === undefined
          ? {}
          : { maxPagesPerTable: numberParam(url, "maxPages") })
      });
      console.log(JSON.stringify({ event: "sync.run.done", ...result }));
      return Response.json(result);
    }

    if (route === "POST /__sync/reconcile") {
      const result = await runReconcile(env, {
        ...(tablesParam(url) === undefined ? {} : { tables: tablesParam(url) })
      });
      console.log(JSON.stringify({ event: "sync.reconcile.done", ...result }));
      return Response.json(result);
    }

    if (route === "POST /__sync/reset") {
      const body = (await request.json()) as { table?: string; truncate?: boolean };
      if (body.table === undefined) {
        return Response.json({ error: "missing table" }, { status: 400 });
      }
      await resetTable(env, body.table, body.truncate === true);
      return Response.json({ reset: body.table, truncate: body.truncate === true });
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error(JSON.stringify({ event: "sync.error", route, message }));
    return Response.json({ error: message }, { status: 500 });
  }

  return new Response("Not found", { status: 404 });
}
