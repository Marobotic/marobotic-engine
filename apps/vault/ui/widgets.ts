// Shared bits of Vault's window: the per-entry icon tile and the right-click menu, both on the
// Marochy palette so every engine app can reuse them.

// Each entry shows its website's favicon. Icons come through Vault's own server (marobotic.dev/vault/icon),
// never straight from a third party, and the initials tile stands in until one loads, offline, or for a
// site that has none.
const PALETTE = ["#B14242", "#D66E36", "#F0BE66", "#4A8B8B", "#7E6BAF", "#5B8C4A", "#C2587E", "#8A8A8A"];

export function monogramColor(name: string): string {
  let hash = 0;
  for (const ch of name.trim().toLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length]!;
}

export function initials(name: string): string {
  const words = name.trim().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!words.length) return "?";
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return words[0]!.slice(0, 2).toUpperCase();
}

/** Dark text on light tiles, light on dark, so the initials always read. */
function inkFor(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.299 * r! + 0.587 * g! + 0.114 * b! > 150 ? "#121212" : "#f5f5f5";
}

export function monogram(name: string): HTMLElement {
  const tile = document.createElement("span");
  tile.className = "tile";
  const bg = monogramColor(name);
  tile.style.background = bg;
  tile.style.color = inkFor(bg);
  tile.textContent = initials(name);
  return tile;
}

const ICONS = "https://marobotic.dev/vault/icon/";

/** The site's favicon on a light-neutral tile, with the initials tile until (unless) it loads. */
// Sites found to have no icon this session, so their rows don't ask again every time they're built.
const noIcon = new Set<string>();

export function entryIcon(name: string, site: string): HTMLElement {
  const tile = monogram(name);
  if (!site || noIcon.has(site)) return tile;
  const img = new Image();
  img.alt = "";
  img.decoding = "async";
  img.referrerPolicy = "no-referrer";
  img.onerror = () => noIcon.add(site);
  img.onload = () => {
    if (img.naturalWidth < 8) { noIcon.add(site); return; }   // a 1px placeholder is no icon
    tile.className = "tile icon";
    tile.style.background = "";
    tile.textContent = "";
    tile.append(img);
  };
  img.src = ICONS + encodeURIComponent(site);
  return tile;
}

// ---- right-click / ⋯ menu, Jukebox-style (the kit's .m-menu) -----------------------------------
export type MenuItem = { label: string; icon?: string; danger?: boolean; checked?: boolean; onClick: () => void };
export type MenuSection = { title?: string; items: MenuItem[] };

let openMenuEl: HTMLElement | null = null;
export function closeMenu() { openMenuEl?.remove(); openMenuEl = null; }

export function openMenu(x: number, y: number, sections: MenuSection[]) {
  closeMenu();
  const back = document.createElement("div");
  back.className = "menu-backdrop";
  const menu = document.createElement("div");
  menu.className = "m-menu";
  for (let s = 0; s < sections.length; s++) {
    if (s > 0) { const sep = document.createElement("div"); sep.className = "sep"; menu.append(sep); }
    if (sections[s]!.title) { const t = document.createElement("div"); t.className = "t"; t.textContent = sections[s]!.title!; menu.append(t); }
    for (const it of sections[s]!.items) {
      const r = document.createElement("div");
      r.className = "r" + (it.danger ? " danger" : "");
      r.innerHTML = `<span>${it.icon ? `<span class="mi">${it.icon}</span> ` : ""}${it.label.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`)}</span>${it.checked ? `<span class="check"></span>` : ""}`;
      r.onclick = () => { closeMenu(); it.onClick(); };
      menu.append(r);
    }
  }
  back.append(menu);
  document.body.append(back);
  openMenuEl = back;
  // keep it on screen: flip left/up when it would overflow
  const w = menu.offsetWidth, hgt = menu.offsetHeight;
  menu.style.left = `${Math.max(6, Math.min(x, window.innerWidth - w - 6))}px`;
  menu.style.top = `${Math.max(6, Math.min(y, window.innerHeight - hgt - 6))}px`;
  back.onclick = (e) => { if (e.target === back) closeMenu(); };
  back.oncontextmenu = (e) => { e.preventDefault(); closeMenu(); };
}

if (typeof addEventListener !== "undefined") addEventListener("keydown", (e) => { if (e.key === "Escape" && openMenuEl) { closeMenu(); e.preventDefault(); } });
