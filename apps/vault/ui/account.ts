// The marobotic account and the vault's copy on the server (marobotic.dev/vault). Sign-in is the same
// account as Hourglass and Jukebox; the vault travels sealed, the server can't open it.
import type { VaultFile } from "../src/vault.ts";

export const SERVER = "https://marobotic.dev/vault";

export class Offline extends Error {}
export class SignInError extends Error {}

async function call(method: string, path: string, session?: string, body?: unknown): Promise<Response> {
  try {
    return await fetch(SERVER + path, {
      method,
      headers: { ...(session ? { authorization: `Bearer ${session}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Offline("Can't reach marobotic.dev");
  }
}

/** The account's session, or a SignInError in the account server's own words. */
export async function signIn(email: string, password: string): Promise<string> {
  const r = await call("POST", "/auth/login", undefined, { email, password });
  const j = (await r.json().catch(() => ({}))) as { session?: string; error?: string; retryIn?: number };
  if (r.status >= 500) throw new Offline("marobotic.dev is not answering");
  if (!r.ok || !j.session) throw new SignInError(j.error || "That email and password don't match a marobotic account.");
  return j.session;
}

/** A new marobotic account (the same one Hourglass and Jukebox use); its session, or the server's reason. */
export async function register(email: string, password: string): Promise<string> {
  const r = await call("POST", "/auth/register", undefined, { email, password });
  const j = (await r.json().catch(() => ({}))) as { session?: string; error?: string };
  if (r.status >= 500) throw new Offline("marobotic.dev is not answering");
  if (!r.ok || !j.session) throw new SignInError(j.error || "That account couldn't be created.");
  return j.session;
}

/** Mails a link to choose a new password (the same answer for any email). */
export async function forgot(email: string): Promise<void> {
  const r = await call("POST", "/auth/forgot", undefined, { email, app: "vault" });
  if (r.status >= 500) throw new Offline("marobotic.dev is not answering");
  if (!r.ok) { const j = (await r.json().catch(() => ({}))) as { error?: string }; throw new SignInError(j.error || "That didn't work. Try again in a minute."); }
}

/** The vault on the server and its version, or null when this account has none yet. */
export async function fetchVault(session: string): Promise<{ rev: number; file: VaultFile } | null> {
  const r = await call("GET", "/api/vault", session);
  if (r.status === 404) return null;
  if (r.status === 401) throw new SignInError("Sign in again.");
  if (!r.ok) throw new Offline("marobotic.dev is not answering");
  return (await r.json()) as { rev: number; file: VaultFile };
}

/** Save on the server. `conflict` holds the newer vault when another device saved first. */
export async function pushVault(session: string, base: number, file: VaultFile): Promise<{ rev: number } | { conflict: { rev: number; file: VaultFile } }> {
  const r = await call("PUT", "/api/vault", session, { base, file });
  if (r.status === 409) return { conflict: (await r.json()) as { rev: number; file: VaultFile } };
  if (r.status === 401) throw new SignInError("Sign in again.");
  if (!r.ok) throw new Offline("marobotic.dev is not answering");
  return (await r.json()) as { rev: number };
}

// The account's picture: set here or at marobotic.dev/dashboard, shown in every marobotic app.
const CACHE = "https://marobotic.dev/cache";

/** The picture's address for an email (found by its sha256, like Gravatar), or null when there is none;
 *  `fresh` skips the copy the window may have kept from the last minute. */
export async function pictureOf(email: string, fresh = false): Promise<string | null> {
  if (!email || !crypto.subtle) return null;
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email.trim().toLowerCase()));
  const url = `${CACHE}/avatar/${[...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("")}?t=${fresh ? Date.now() : Date.now() >> 16}`;
  return new Promise((done) => { const i = new Image(); i.onload = () => done(url); i.onerror = () => done(null); i.src = url; });
}

/** A new picture (any image; the server crops it to its middle square), or null to remove it. */
export async function setPicture(session: string, image: Blob | null): Promise<void> {
  let r: Response;
  try {
    r = await fetch(`${CACHE}/account/avatar`, {
      method: image ? "POST" : "DELETE",
      headers: { authorization: `Bearer ${session}`, ...(image ? { "content-type": image.type || "application/octet-stream" } : {}) },
      body: image ?? undefined,
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new Offline("Can't reach marobotic.dev");
  }
  if (r.status === 401) throw new SignInError("Sign in again.");
  if (!r.ok) { const j = (await r.json().catch(() => ({}))) as { error?: string }; throw new Error(j.error || "That picture couldn't be saved."); }
}
