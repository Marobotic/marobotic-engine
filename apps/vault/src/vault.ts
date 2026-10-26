// Vault's data: every item is sealed on its own with the vault key, so items sync one by one and
// the server (or a copied file) shows nothing but ids and times. Even an item's type is inside its box.
import {
  KDF_V1, deriveKeys, newRecoveryCode, newVaultKey, openText, recoveryKeyFrom, seal, unwrapVaultKey,
  type KdfParams, type Sealed,
} from "@marobotic/crypto";
import type { OtpEntry } from "@marobotic/otp";

/** A 2FA code on its own. `inLogin` marks a login's own code shown as a code (never stored). */
export type TotpItem = { type: "totp"; otp: OtpEntry; label?: string; notes?: string; favorite?: boolean; inLogin?: boolean };
/** A login: email and/or username, password and its own one-time code. `totpId` is the older link to a separate code. */
export type LoginItem = { type: "login"; name: string; urls: string[]; username: string; email?: string; password: string; otp?: OtpEntry; totpId?: string; notes?: string; favorite?: boolean };
export type PasskeyItem = {
  type: "passkey"; rpId: string; credentialId: string; userHandle: string; username: string; privateKeyPkcs8: string; counter: number;
  displayName?: string; rpName?: string; created?: number; favorite?: boolean;
};
export type NoteItem = { type: "note"; title: string; body: string };
/** How often each login was picked on one device (src/usage.ts). Hidden: never listed. */
export type UsageItem = { type: "usage"; counts: Record<string, number> };
export type ItemData = TotpItem | LoginItem | PasskeyItem | NoteItem | UsageItem;
export type Item = { id: string; updated: number; data: ItemData };

/** What leaves the device for each item. */
export type SealedItem = { id: string; updated: number; deleted?: boolean; box?: Sealed };

export type VaultFile = {
  format: "marobotic-vault";
  v: 1;
  email: string;
  kdf: KdfParams;
  byPassword: Sealed;   // the vault key, sealed with the key from the account password
  byRecovery: Sealed;   // the vault key, sealed with the printed recovery kit
  items: SealedItem[];
};

const newId = () => crypto.randomUUID();

export class Vault {
  private items = new Map<string, Item>();
  private gone = new Map<string, number>(); // deleted ids -> when, so a deletion syncs too
  // Each item's sealed box, kept until the item changes: saving then seals only what changed
  // (sealing every item on every save made big vaults slow).
  private boxes = new Map<string, Sealed>();

  private constructor(private file: Omit<VaultFile, "items">, private key: Uint8Array, private clock: () => number) {}

  /** A brand-new vault. Show `recoveryCode` once and ask the user to print or write it down. */
  static create(email: string, password: string, opts: { kdf?: KdfParams; clock?: () => number } = {}) {
    const kdf = opts.kdf ?? KDF_V1;
    const { wrapKey } = deriveKeys(email, password, kdf);
    const recovery = newRecoveryCode();
    const k = newVaultKey(wrapKey, recovery.key);
    const vault = new Vault({ format: "marobotic-vault", v: 1, email: email.trim().toLowerCase(), kdf, byPassword: k.byPassword, byRecovery: k.byRecovery }, k.vaultKey, opts.clock ?? Date.now);
    return { vault, recoveryCode: recovery.code };
  }

  static unlock(file: VaultFile, password: string, clock: () => number = Date.now): Vault {
    const { wrapKey } = deriveKeys(file.email, password, file.kdf);
    let key: Uint8Array;
    try { key = unwrapVaultKey(wrapKey, file.byPassword); } catch { throw new Error("wrong password"); }
    return Vault.load(file, key, clock);
  }

  /** After a password reset: the recovery kit opens the vault, then setPassword() seals it for the new one. */
  static unlockWithRecovery(file: VaultFile, recoveryCode: string, clock: () => number = Date.now): Vault {
    let key: Uint8Array;
    try { key = unwrapVaultKey(recoveryKeyFrom(recoveryCode), file.byRecovery); } catch { throw new Error("that recovery code does not open this vault"); }
    return Vault.load(file, key, clock);
  }

  /** Opened again with the vault key itself (the browser extension keeps it in memory-only session
   *  storage between restarts of its background worker). */
  static withKey(file: VaultFile, key: Uint8Array, clock: () => number = Date.now): Vault {
    try { return Vault.load(file, key, clock); } catch { throw new Error("wrong key"); }
  }
  /** The vault key, for withKey(). Never written anywhere that outlives the browser session. */
  keyBytes(): Uint8Array { return this.key; }
  get email(): string { return this.file.email; }

  private static load(file: VaultFile, key: Uint8Array, clock: () => number): Vault {
    const { items, ...head } = file;
    const v = new Vault(head, key, clock);
    for (const s of items) v.take(s);
    return v;
  }

  private take(s: SealedItem) {
    if (s.deleted || !s.box) { this.items.delete(s.id); this.boxes.delete(s.id); this.gone.set(s.id, s.updated); return; }
    const data = JSON.parse(openText(this.key, s.box, `item:${s.id}`)) as ItemData;
    this.items.set(s.id, { id: s.id, updated: s.updated, data });
    this.boxes.set(s.id, s.box);
    this.gone.delete(s.id);
  }

  list(type?: ItemData["type"]): Item[] {
    return [...this.items.values()].filter((i) => !type || i.data.type === type);
  }
  get(id: string): Item | undefined { return this.items.get(id); }

  add(data: ItemData): Item {
    const item = { id: newId(), updated: this.clock(), data };
    this.items.set(item.id, item);
    return item;
  }
  update(id: string, data: ItemData): Item {
    if (!this.items.has(id)) throw new Error("no such item");
    const item = { id, updated: this.clock(), data };
    this.items.set(id, item);
    this.boxes.delete(id);
    return item;
  }
  remove(id: string) {
    this.boxes.delete(id);
    if (this.items.delete(id)) this.gone.set(id, this.clock());
  }

  /** Seal everything for saving or syncing. */
  toFile(): VaultFile {
    const items: SealedItem[] = [...this.items.values()].map((i) => {
      let box = this.boxes.get(i.id);
      if (!box) { box = seal(this.key, JSON.stringify(i.data), `item:${i.id}`); this.boxes.set(i.id, box); }
      return { id: i.id, updated: i.updated, box };
    });
    for (const [id, updated] of this.gone) items.push({ id, updated, deleted: true });
    return { ...this.file, items };
  }

  /** Another device's items: the newer edit of each item wins, deletions included. Returns how many changed here. */
  merge(remote: SealedItem[]): number {
    let changed = 0;
    for (const s of remote) {
      const mine = this.items.get(s.id)?.updated ?? this.gone.get(s.id) ?? -1;
      if (s.updated > mine) { this.take(s); changed++; }
    }
    return changed;
  }

  /** A fresh recovery kit: the vault key is sealed for a new code and the old code stops working.
   *  Returns the new code, to show once. */
  newRecoveryKit(): string {
    const r = newRecoveryCode();
    this.file = { ...this.file, byRecovery: seal(r.key, this.key, "vault-key") };
    return r.code;
  }

  /** New account password (also after a reset + recovery): only the vault key is sealed again. */
  setPassword(newPassword: string) {
    const { wrapKey } = deriveKeys(this.file.email, newPassword, this.file.kdf);
    this.file = { ...this.file, byPassword: seal(wrapKey, this.key, "vault-key") };
  }
}
