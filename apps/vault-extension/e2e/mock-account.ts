// Stands in for ui/account.ts in the e2e build: a marobotic account and vault server in memory, so the
// real extension can be driven without a real account. Password: "test-pass".
import { normalizeEntry } from "@marobotic/otp";
import { Vault, type VaultFile } from "../../vault/src/vault.ts";

export const SERVER = "mock";
export class Offline extends Error {}
export class SignInError extends Error {}

let file: VaultFile | null = null;
let rev = 1;
export let pushes = 0;

export async function signIn(email: string, password: string): Promise<string> {
  if (password !== "test-pass") throw new SignInError("That email and password don't match a marobotic account.");
  return `session-${email}`;
}

export async function fetchVault(_session: string): Promise<{ rev: number; file: VaultFile }> {
  if (!file) {
    const v = Vault.create("test@marobotic.dev", "test-pass", { kdf: { v: 1, alg: "argon2id13", ops: 1, memBytes: 8 * 1024 * 1024 } }).vault;
    const code = v.add({ type: "totp", otp: normalizeEntry({ issuer: "localhost", account: "tester", secret: "JBSWY3DPEHPK3PXP" }) });
    v.add({ type: "login", name: "Local test", urls: ["http://localhost:8643"], username: "tester", password: "hunter2-local", notes: "", totpId: code.id });
    v.add({ type: "login", name: "GitHub", urls: ["https://github.com"], username: "mi", password: "gh-pw", notes: "" });
    file = v.toFile();
  }
  return { rev, file };
}

export async function pushVault(_session: string, _base: number, f: VaultFile): Promise<{ rev: number }> {
  file = f;
  pushes++;
  (globalThis as { __mockPushes?: number }).__mockPushes = pushes;
  return { rev: ++rev };
}
