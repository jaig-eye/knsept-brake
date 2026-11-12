import { beforeEach, describe, expect, it } from "vitest";
import { allowedQueues, handle, type Env, type Io } from "../src/brake.ts";
import { SIGNATURE_HEADER, parseRequest, signatureHeader } from "../src/protocol.ts";

const SECRET = "s".repeat(43);
const ACCOUNT = "a".repeat(32);
const TOKEN = "cf-token-that-only-the-brake-holds";
const NOW = Date.parse("2026-11-11T12:00:00.000Z");

const env = {
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
  CLOUDFLARE_API_TOKEN: TOKEN,
  BRAKE_SECRET: SECRET,
  BRAKE_QUEUES: "orders, emails ,orders",
} as Env;

let calls: { url: string; method: string; body: string | null; auth: string | null }[];
let queues: Record<string, { id: string; paused: boolean }>;
let cloudflareStatus: number;
let seen: Set<string>;

const io = (): Io => ({
  now: () => NOW,
  async firstSighting(id) {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  },
  async fetch(url, init) {
    const headers = new Headers(init.headers);
    calls.push({
      url,
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? init.body : null,
      auth: headers.get("Authorization"),
    });
    if (cloudflareStatus !== 200) return new Response("{}", { status: cloudflareStatus });
    if (init.method === "GET") {
      const name = new URL(url).searchParams.get("name") ?? "";
      const q = queues[name];
      return Response.json({
        result: q
          ? [
              { queue_id: q.id, queue_name: `${name}-other`, settings: {} },
              { queue_id: q.id, queue_name: name, settings: { delivery_paused: q.paused } },
            ]
          : [],
      });
    }
    return Response.json({ success: true });
  },
});

let counter = 0;
async function send(
  body: Record<string, unknown>,
  options: { secret?: string; at?: number; method?: string; raw?: string } = {},
): Promise<Response> {
  counter += 1;
  const raw = options.raw ?? JSON.stringify({ id: `req_${"x".repeat(12)}${counter}`, ...body });
  const header = await signatureHeader(options.secret ?? SECRET, raw, (options.at ?? NOW) / 1000);
  const init: RequestInit = {
    method: options.method ?? "POST",
    headers: { [SIGNATURE_HEADER]: header, "Content-Type": "application/json" },
  };
  if ((options.method ?? "POST") === "POST") init.body = raw;
  return handle(new Request("https://knsept-brake.example.workers.dev/", init), env, io());
}

beforeEach(() => {
  calls = [];
  queues = { orders: { id: "q_orders", paused: false }, emails: { id: "q_emails", paused: true } };
  cloudflareStatus = 200;
  seen = new Set();
});

describe("the Brake Worker", () => {
  it("pauses a listed queue on a signed request, using the token only it holds", async () => {
    const response = await send({ action: "pause", queue: "orders" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      version: "1",
      queue: "orders",
      paused: true,
      changed: true,
    });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/queues?page=1&name=orders`,
      `PATCH https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/queues/q_orders`,
    ]);
    expect(calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(JSON.parse(calls[1]!.body!)).toEqual({
      queue_name: "orders",
      settings: { delivery_paused: true },
    });
  });

  it("resumes too", async () => {
    const response = await send({ action: "resume", queue: "emails" });
    expect(await response.json()).toMatchObject({
      ok: true,
      queue: "emails",
      paused: false,
      changed: true,
    });
    expect(JSON.parse(calls[1]!.body!).settings).toEqual({ delivery_paused: false });
  });

  it("reports each listed queue on a check, and proves the token can edit without changing anything", async () => {
    queues = { orders: { id: "q_orders", paused: true } };
    const response = await send({ action: "check" });
    expect(await response.json()).toEqual({
      ok: true,
      version: "1",
      canEdit: true,
      queues: [
        { name: "orders", found: true, paused: true },
        { name: "emails", found: false, paused: false },
      ],
    });
    // The one write sets the found queue to the state it's already in.
    const writes = calls.filter((c) => c.method === "PATCH");
    expect(writes.map((c) => JSON.parse(c.body!))).toEqual([
      { queue_name: "orders", settings: { delivery_paused: true } },
    ]);
  });

  it("says when its token can read but not edit", async () => {
    const reader = io();
    const readOnly: Io = {
      ...reader,
      fetch: async (url, init) =>
        init.method === "PATCH" ? new Response("{}", { status: 403 }) : reader.fetch(url, init),
    };
    const raw = JSON.stringify({ id: "req_readonly_token01", action: "check" });
    const response = await handle(
      new Request("https://b.example.workers.dev/", {
        method: "POST",
        headers: { [SIGNATURE_HEADER]: await signatureHeader(SECRET, raw, NOW / 1000) },
        body: raw,
      }),
      env,
      readOnly,
    );
    expect(await response.json()).toMatchObject({ ok: true, canEdit: false });
  });

  it("says when a queue was already in the state asked for", async () => {
    const response = await send({ action: "pause", queue: "emails" });
    expect(await response.json()).toMatchObject({ paused: true, changed: false });
  });

  it("refuses a queue that isn't listed, without calling Cloudflare", async () => {
    const response = await send({ action: "pause", queue: "billing" });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: "QUEUE_NOT_ALLOWED" });
    expect(calls).toEqual([]);
  });

  it("refuses a wrong secret, a stale or future timestamp, and a tampered body", async () => {
    expect(
      (await send({ action: "pause", queue: "orders" }, { secret: "t".repeat(43) })).status,
    ).toBe(401);
    expect((await send({ action: "pause", queue: "orders" }, { at: NOW - 121_000 })).status).toBe(
      401,
    );
    expect((await send({ action: "pause", queue: "orders" }, { at: NOW + 121_000 })).status).toBe(
      401,
    );
    expect((await send({ action: "pause", queue: "orders" }, { at: NOW - 119_000 })).status).toBe(
      200,
    );

    const raw = JSON.stringify({ id: "req_tampered_000001", action: "check" });
    const header = await signatureHeader(SECRET, raw, NOW / 1000);
    const tampered = raw.replace("check", "pause");
    const response = await handle(
      new Request("https://b.example.workers.dev/", {
        method: "POST",
        headers: { [SIGNATURE_HEADER]: header },
        body: tampered,
      }),
      env,
      io(),
    );
    expect(response.status).toBe(401);
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });

  it("refuses a request it has already seen", async () => {
    const raw = JSON.stringify({ id: "req_once_only_00001", action: "pause", queue: "orders" });
    expect((await send({}, { raw })).status).toBe(200);
    const again = await send({}, { raw });
    expect(again.status).toBe(409);
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });

  it("refuses anything but POST, missing signatures, bad bodies and big bodies", async () => {
    expect((await send({ action: "check" }, { method: "GET" })).status).toBe(405);
    const unsigned = await handle(
      new Request("https://b.example.workers.dev/", { method: "POST", body: "{}" }),
      env,
      io(),
    );
    expect(unsigned.status).toBe(401);
    expect((await send({ action: "explode" })).status).toBe(400);
    expect((await send({ action: "pause" })).status).toBe(400);
    expect((await send({ action: "check" }, { raw: `{"id":"${"x".repeat(5000)}"}` })).status).toBe(
      413,
    );
  });

  it("says when it isn't set up, rather than acting", async () => {
    for (const broken of [
      { ...env, BRAKE_SECRET: "short" },
      { ...env, BRAKE_QUEUES: " , " },
      { ...env, CLOUDFLARE_ACCOUNT_ID: "" },
      { ...env, CLOUDFLARE_API_TOKEN: "" },
    ]) {
      const response = await handle(
        new Request("https://b.example.workers.dev/", { method: "POST", body: "{}" }),
        broken,
        io(),
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ ok: false, error: "NOT_CONFIGURED" });
    }
  });

  it("reports a Cloudflare failure by status only, and a missing queue", async () => {
    cloudflareStatus = 403;
    const failed = await send({ action: "pause", queue: "orders" });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ ok: false, error: "CLOUDFLARE_FAILED", status: 403 });
    cloudflareStatus = 200;
    queues = {};
    expect((await send({ action: "pause", queue: "orders" })).status).toBe(404);
  });
});

describe("protocol helpers", () => {
  it("reads the allowed list once per name, trimmed", () => {
    expect(allowedQueues(" orders,emails, orders ,,")).toEqual(["orders", "emails"]);
  });

  it("parses only well-formed requests", () => {
    expect(parseRequest('{"id":"short","action":"check"}')).toBeNull();
    expect(parseRequest('{"id":"abcdefghijklmnop","action":"check","queue":"x"}')).toEqual({
      id: "abcdefghijklmnop",
      action: "check",
    });
    expect(parseRequest('{"id":"abcdefghijklmnop","action":"pause","queue":""}')).toBeNull();
    expect(parseRequest("not json")).toBeNull();
  });
});
