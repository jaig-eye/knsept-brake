import {
  MAX_BODY_BYTES,
  MIN_SECRET_LENGTH,
  PROTOCOL_VERSION,
  SIGNATURE_HEADER,
  parseRequest,
  verifySignature,
} from "./protocol.ts";

/**
 * The Knsept Guard Brake Worker. It holds a Cloudflare token that can edit queues, and uses it
 * for one thing: pausing or resuming delivery on a queue you listed in BRAKE_QUEUES, when a
 * signed, fresh request from Knsept Guard asks. Knsept Guard never sees the token.
 */

export interface Env {
  CLOUDFLARE_ACCOUNT_ID: string;
  /** Secret: a token with only Account > Queues > Edit. */
  CLOUDFLARE_API_TOKEN: string;
  /** Secret: shared with Knsept Guard, which signs every request with it. */
  BRAKE_SECRET: string;
  /** Queue names Guard may pause, comma-separated. */
  BRAKE_QUEUES: string;
  /** Remembers request ids, so a request can't be sent twice. See index.ts. */
  SEEN: DurableObjectNamespace;
}

/** Lets tests stand in for Cloudflare's API, the clock and the replay memory. */
export interface Io {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now(): number;
  /** True the first time an id is seen; false for a repeat within the replay window. */
  firstSighting(id: string): Promise<boolean>;
}

const API = "https://api.cloudflare.com/client/v4";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const refuse = (status: number, error: string): Response => json({ ok: false, error }, status);

export const allowedQueues = (list: string): string[] =>
  [
    ...new Set(
      list
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ].slice(0, 50);

interface QueueInfo {
  id: string;
  paused: boolean;
}

type Lookup = { ok: true; queue: QueueInfo | null } | { ok: false; status: number };

/** Finds a queue by name, the way `wrangler queues pause-delivery` does. */
async function findQueue(env: Env, io: Io, name: string): Promise<Lookup> {
  const url = `${API}/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/queues?page=1&name=${encodeURIComponent(name)}`;
  const response = await io.fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
  });
  if (!response.ok) return { ok: false, status: response.status };
  const body = (await response.json()) as {
    result?: { queue_id?: string; queue_name?: string; settings?: { delivery_paused?: boolean } }[];
  };
  const match = (body.result ?? []).find((q) => q.queue_name === name);
  return {
    ok: true,
    queue: match?.queue_id
      ? { id: match.queue_id, paused: match.settings?.delivery_paused === true }
      : null,
  };
}

/** Sets delivery paused or running, with the same request `wrangler queues pause-delivery` sends. */
async function setPaused(
  env: Env,
  io: Io,
  name: string,
  queue: QueueInfo,
  paused: boolean,
): Promise<{ ok: true } | { ok: false; status: number }> {
  const url = `${API}/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/queues/${encodeURIComponent(queue.id)}`;
  const response = await io.fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ queue_name: name, settings: { delivery_paused: paused } }),
  });
  return response.ok ? { ok: true } : { ok: false, status: response.status };
}

function configured(env: Env): boolean {
  return (
    /^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID ?? "") &&
    Boolean(env.CLOUDFLARE_API_TOKEN) &&
    (env.BRAKE_SECRET ?? "").length >= MIN_SECRET_LENGTH &&
    allowedQueues(env.BRAKE_QUEUES ?? "").length > 0
  );
}

/** Reads at most `limit` bytes of a body, or null when it's longer: never the whole of a big one. */
async function readCapped(request: Request, limit: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function handle(request: Request, env: Env, io: Io): Promise<Response> {
  if (request.method !== "POST") return refuse(405, "METHOD_NOT_ALLOWED");
  if (!configured(env)) return refuse(500, "NOT_CONFIGURED");

  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > MAX_BODY_BYTES) return refuse(413, "TOO_LARGE");
  const rawBody = await readCapped(request, MAX_BODY_BYTES);
  if (rawBody === null) return refuse(413, "TOO_LARGE");

  const now = io.now() / 1000;
  const signed = await verifySignature(
    env.BRAKE_SECRET,
    rawBody,
    request.headers.get(SIGNATURE_HEADER),
    now,
  );
  if (!signed) return refuse(401, "BAD_SIGNATURE");
  const brake = parseRequest(rawBody);
  if (!brake) return refuse(400, "BAD_REQUEST");
  if (!(await io.firstSighting(brake.id))) return refuse(409, "REPLAYED");

  const allowed = allowedQueues(env.BRAKE_QUEUES);

  if (brake.action === "check") {
    const queues = [];
    for (const name of allowed) {
      const found = await findQueue(env, io, name);
      if (!found.ok) {
        return json({ ok: false, error: "CLOUDFLARE_FAILED", status: found.status }, 502);
      }
      queues.push({ name, found: found.queue, paused: found.queue?.paused ?? false });
    }
    // Proves the token can edit queues, not just read them: it sets the first queue's delivery to
    // the state it's already in, which changes nothing.
    const first = queues.find((q) => q.found);
    let canEdit: boolean | null = null;
    if (first?.found) {
      canEdit = (await setPaused(env, io, first.name, first.found, first.found.paused)).ok;
    }
    return json({
      ok: true,
      version: PROTOCOL_VERSION,
      canEdit,
      queues: queues.map((q) => ({ name: q.name, found: q.found !== null, paused: q.paused })),
    });
  }

  const name = brake.queue!;
  if (!allowed.includes(name)) return refuse(403, "QUEUE_NOT_ALLOWED");
  const found = await findQueue(env, io, name);
  if (!found.ok) return json({ ok: false, error: "CLOUDFLARE_FAILED", status: found.status }, 502);
  if (!found.queue) return refuse(404, "QUEUE_NOT_FOUND");
  const paused = brake.action === "pause";
  const result = await setPaused(env, io, name, found.queue, paused);
  if (!result.ok) {
    return json({ ok: false, error: "CLOUDFLARE_FAILED", status: result.status }, 502);
  }
  console.log(JSON.stringify({ event: "brake", action: brake.action, queue: name }));
  // `changed` is false when the queue was already in that state.
  return json({
    ok: true,
    version: PROTOCOL_VERSION,
    queue: name,
    paused,
    changed: found.queue.paused !== paused,
  });
}
