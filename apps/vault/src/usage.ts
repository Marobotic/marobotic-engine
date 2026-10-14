// Which login a person picks most, so it comes first next time (20 Discord accounts: the one used
// most is on top). Never shown. Each device counts in its own hidden item, synced like any other item
// (sealed, so the server sees only an id and a time): devices never overwrite each other's counts,
// and a login's count is the sum over all devices.
import type { Item, Vault } from "./vault.ts";

/** Every login's picks, over all devices. */
export function useCounts(vault: Vault): Map<string, number> {
  const out = new Map<string, number>();
  for (const it of vault.list("usage")) {
    if (it.data.type !== "usage") continue;
    for (const [id, n] of Object.entries(it.data.counts)) out.set(id, (out.get(id) ?? 0) + (Number(n) || 0));
  }
  return out;
}

/**
 * +1 for each login picked on this device. `mine` is this device's usage item id (kept by the caller,
 * "" before the first pick); returns it, to keep. Counts of deleted logins are dropped on the way.
 */
export function recordUse(vault: Vault, mine: string, loginIds: string[]): string {
  const ids = loginIds.filter((id) => vault.get(id)?.data.type === "login");
  if (!ids.length) return mine;
  const old = mine ? vault.get(mine) : undefined;
  const counts: Record<string, number> = {};
  if (old?.data.type === "usage") for (const [id, n] of Object.entries(old.data.counts)) if (vault.get(id)) counts[id] = n;
  for (const id of ids) counts[id] = (counts[id] ?? 0) + 1;
  const data = { type: "usage" as const, counts };
  return (old?.data.type === "usage" ? vault.update(old.id, data) : vault.add(data)).id;
}

/** Most picked first; otherwise the order stays as it was (a stable sort). */
export function byUse<T extends Pick<Item, "id">>(items: T[], counts: Map<string, number>): T[] {
  return items.map((it, i) => ({ it, i, n: counts.get(it.id) ?? 0 })).sort((a, b) => b.n - a.n || a.i - b.i).map((x) => x.it);
}
