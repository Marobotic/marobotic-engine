// Which website an entry belongs to, for its icon: a login's own address, else a guess from the
// service name of a 2FA code ("DigitalOcean" -> digitalocean.com).
import { hostOf } from "./passwords.ts";

// Names whose site isn't simply "<name>.com".
const KNOWN: Record<string, string> = {
  squareenix: "square-enix.com", ffxiv: "square-enix.com", finalfantasyxiv: "square-enix.com",
  aws: "aws.amazon.com", amazonwebservices: "aws.amazon.com",
  proton: "proton.me", protonmail: "proton.me", tuta: "tuta.com", tutanota: "tuta.com",
  blizzard: "battle.net", battlenet: "battle.net", steam: "steampowered.com", twitch: "twitch.tv",
  twitter: "x.com", x: "x.com", meta: "facebook.com", zoom: "zoom.us", mega: "mega.nz",
  npm: "npmjs.com", pypi: "pypi.org", ovh: "ovhcloud.com", playstation: "playstation.com", psn: "playstation.com",
  epic: "epicgames.com", epicgames: "epicgames.com", ea: "ea.com", origin: "ea.com", riot: "riotgames.com", riotgames: "riotgames.com",
  microsoftaccount: "microsoft.com", googleaccount: "google.com", gmail: "google.com", outlook: "microsoft.com",
};

/** "secure.square-enix.com" -> "square-enix.com": sign-in subdomains rarely have an icon of their own. */
function mainSite(host: string): string {
  const parts = host.split(".");
  return parts.length > 2 && /^(secure|accounts?|login|signin|auth|sso|id|my|app|portal|online)$/.test(parts[0]!) ? parts.slice(1).join(".") : host;
}

/** The site for an entry's icon, or "" when there is nothing to go on. */
export function siteOf(entry: { urls?: string[]; issuer?: string; name?: string }): string {
  const url = entry.urls?.find(Boolean);
  if (url) return mainSite(hostOf(url));
  const name = (entry.issuer || entry.name || "").trim().toLowerCase();
  if (!name) return "";
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(name)) return mainSite(name.replace(/^www\./, ""));   // already a domain
  const key = name.replace(/[^a-z0-9]/g, "");
  if (!key) return "";
  return KNOWN[key] ?? `${key}.com`;
}
