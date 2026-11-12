/**
 * The signed request Knsept Guard sends to a Brake Worker. Version 1.
 *
 *   POST /
 *   Content-Type: application/json
 *   Knsept-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with BRAKE_SECRET>
 *
 *   { "id": "<random request id>", "action": "check" | "pause" | "resume", "queue": "<name>" }
 *
 * `queue` is required for pause and resume. A request is refused when its signature is wrong,
 * its timestamp is more than MAX_SKEW_SECONDS from the Worker's clock, or its id was seen
 * recently. This file has no imports so it can be read on its own.
 */

export const PROTOCOL_VERSION = "1";
export const SIGNATURE_HEADER = "Knsept-Signature";
export const MAX_SKEW_SECONDS = 120;
export const MAX_BODY_BYTES = 4096;
/** The shortest BRAKE_SECRET the Worker accepts. Guard's are 43 characters. */
export const MIN_SECRET_LENGTH = 32;

export type BrakeAction = "check" | "pause" | "resume";

export interface BrakeRequest {
  id: string;
  action: BrakeAction;
  queue?: string;
}

const encoder = new TextEncoder();

const toHex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

/** The header value for a body, as Guard sends it. */
export async function signatureHeader(
  secret: string,
  rawBody: string,
  nowSeconds: number,
): Promise<string> {
  const t = String(Math.floor(nowSeconds));
  return `t=${t},v1=${await hmacHex(secret, `${t}.${rawBody}`)}`;
}

/** True when the header is a valid, fresh signature of the body. */
export async function verifySignature(
  secret: string,
  rawBody: string,
  header: string | null,
  nowSeconds: number,
): Promise<boolean> {
  if (!header) return false;
  const parts = new Map(
    header.split(",").map((part) => {
      const at = part.indexOf("=");
      return [part.slice(0, at).trim(), part.slice(at + 1).trim()] as const;
    }),
  );
  const t = parts.get("t");
  const v1 = parts.get("v1");
  if (!t || !v1 || !/^\d{1,12}$/.test(t)) return false;
  if (Math.abs(nowSeconds - Number(t)) > MAX_SKEW_SECONDS) return false;
  return constantTimeEqual(await hmacHex(secret, `${t}.${rawBody}`), v1);
}

/** Reads a request body into a BrakeRequest, or null when it isn't one. */
export function parseRequest(rawBody: string): BrakeRequest | null {
  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { id, action, queue } = value as Record<string, unknown>;
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) return null;
  if (action !== "check" && action !== "pause" && action !== "resume") return null;
  if (action === "check") return { id, action };
  if (typeof queue !== "string" || queue.length < 1 || queue.length > 63) return null;
  return { id, action, queue };
}
