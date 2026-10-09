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
