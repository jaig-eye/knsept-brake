import { DurableObject } from "cloudflare:workers";
import { handle, type Env } from "./brake.ts";

export type { Env } from "./brake.ts";

/** How long a request id is remembered: longer than the signature's two-minute window. */
const REPLAY_MS = 5 * 60_000;

/**
 * One Durable Object for the whole Worker that remembers request ids for five minutes, so a
 * captured request can't be sent again from anywhere. (The Cache API would be per data center,
 * and does nothing on workers.dev.)
 */
export class SeenRequests extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, at INTEGER)");
  }

  firstSighting(id: string, now: number): boolean {
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM seen WHERE at < ?", now - REPLAY_MS);
    if (sql.exec("SELECT 1 FROM seen WHERE id = ?", id).toArray().length > 0) return false;
    sql.exec("INSERT INTO seen (id, at) VALUES (?, ?)", id, now);
    return true;
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const seen = env.SEEN.get(
      env.SEEN.idFromName("seen"),
    ) as unknown as DurableObjectStub<SeenRequests>;
    return handle(request, env, {
      fetch: (url, init) => fetch(url, init),
      now: () => Date.now(),
      firstSighting: (id) => seen.firstSighting(id, Date.now()),
    });
  },
} satisfies ExportedHandler<Env>;
