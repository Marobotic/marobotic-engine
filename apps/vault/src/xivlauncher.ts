// FFXIV: XIVLauncher takes the one-time password over HTTP while its OTP box is open
// (https://goatcorp.github.io/faq/mobile_otp): GET http://<pc>:4646/ffxivlauncher/<code>.
// It only listens while it is waiting, so Vault keeps offering the current code until it is taken.
import { totp, type OtpEntry } from "@marobotic/otp";

export const XL_PORT = 4646;

/** The Square Enix account among the 2FA entries, if there is exactly one obvious choice. */
export function findFfxivEntry(entries: OtpEntry[]): OtpEntry | undefined {
  const hits = entries.filter((e) => /square\s*-?\s*enix|ffxiv|final\s*fantasy/i.test(`${e.issuer} ${e.account}`));
  return hits.length === 1 ? hits[0] : hits.find((e) => /square\s*-?\s*enix/i.test(e.issuer));
}

/** One attempt: true when XIVLauncher took the code. `host` is the PC running it (the phone sends over Wi-Fi). */
export async function sendCode(code: string, host = "127.0.0.1", timeoutMs = 1500): Promise<boolean> {
  try {
    const r = await fetch(`http://${host}:${XL_PORT}/ffxivlauncher/${encodeURIComponent(code)}`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false; // not listening (no OTP box open), or the PC is off
  }
}

/** Keep offering the current code until XIVLauncher takes it or `untilMs` passes. A code with under
 *  `freshSeconds` left is skipped for the next one, so the launcher never gets one that expires mid-login. */
export async function sendWhenAsked(
  entry: OtpEntry,
  opts: {
    host?: string; untilMs?: number; everyMs?: number; freshSeconds?: number; now?: () => number; signal?: AbortSignal;
    /** How one attempt goes out. The desktop app sends from its native side: a web page can't read the reply. */
    send?: (code: string, host: string) => Promise<boolean>;
  } = {},
): Promise<{ sent: boolean; code?: string }> {
  const now = opts.now ?? Date.now;
  const until = now() + (opts.untilMs ?? 5 * 60_000);
  while (now() < until && !opts.signal?.aborted) {
    let { code, remaining } = await totp(entry, now());
    if (remaining < (opts.freshSeconds ?? 3)) ({ code } = await totp(entry, now() + remaining * 1000));
    if (await (opts.send ?? sendCode)(code, opts.host ?? "127.0.0.1")) return { sent: true, code };
    await new Promise((r) => setTimeout(r, opts.everyMs ?? 1000));
  }
  return { sent: false };
}
