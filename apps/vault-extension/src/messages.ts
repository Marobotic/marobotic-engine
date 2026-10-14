// What the pages, the popup and the background say to each other.
export type LoginHit = { id: string; name: string; username: string; site: string };
export type CodeHit = { id: string; issuer: string; account: string; code: string; remaining: number; period: number };
export type Matches = { logins?: LoginHit[]; codes?: CodeHit[]; locked?: boolean; error?: string; site?: string };
export type Offer = { id: string; site: string; username: string; state: "new" | "changed"; name?: string };

export type Msg =
  | { t: "match" } | { t: "fill"; id: string } | { t: "code"; id: string }
  | { t: "submitted"; username: string; password: string } | { t: "lastUser"; username: string }
  | { t: "pending" } | { t: "save"; id: string; decision: "save" | "never" } | { t: "open" }
  | { t: "status" } | { t: "pair"; code: string } | { t: "unpair" } | { t: "search"; q: string } | { t: "secret"; id: string }
  | { t: "tabMatch" } | { t: "fillTab"; id: string } | { t: "takeover"; on: boolean } | { t: "never" } | { t: "unnever"; site: string };

export const send = <T = unknown>(m: Msg): Promise<T> => chrome.runtime.sendMessage(m) as Promise<T>;
