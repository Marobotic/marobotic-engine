# Letterbox

Marobotic's mail client for Zoho Mail. Sign in with a marobotic account, then add one or more Zoho
accounts in Settings. Inbox, Unread, Important and search work across all accounts; each account also
has its own folders. Compose lets you choose the From account.

Zoho accounts use Zoho OAuth. Refresh tokens are sealed with AES-256-GCM in `accounts.json`; the key is
kept separately. Any marobotic account can sign in unless `LETTERBOX_USERS` limits access.

Live at **https://marobotic.dev/letterbox/**.

```
server/server.ts   HTTP API, sign-in via maro-cache, and the built page
server/accounts.ts encrypted per-user Zoho account store
server/zoho.ts     Zoho provider (OAuth, token refresh, mail, attachments and send)
ui/                the client (Marochy kit from packages/ui), bundled by build.mjs into dist/
src-tauri/         the Windows desktop app (Rust + Tauri 2: tray, single-instance, saved session, Downloads)
icons.py           draws the pixel envelope icon set into src-tauri/icons/
installer/         standalone Windows uninstaller (Inno Setup 6)
deploy.sh          build, back up /opt/marobotic-letterbox, upload, pm2 restart
```

Build the Windows app (`Letterbox_0.1.3_x64-setup.exe`):

```powershell
npx tauri build
```

Run it locally:

```powershell
node apps/letterbox/build.mjs
$env:LETTERBOX_ZOHO_APP = "$PWD/letterbox-zoho-app.json"   # JSON: client_id, client_secret, redirect_uri
$env:LETTERBOX_DATA = "$PWD/.letterbox-data"
$env:LETTERBOX_KEY = "$PWD/.letterbox.key"
$env:LETTERBOX_INSECURE_COOKIE = "1"
$env:MARO_ACCOUNT_URL = "<a maro-cache, or a stand-in>"
node --import tsx apps/letterbox/server/server.ts       # http://127.0.0.1:8970
```

The Zoho app JSON must use redirect URI `https://marobotic.dev/letterbox/oauth/zoho`. `LETTERBOX_DATA` holds `accounts.json` and defaults to `/var/lib/marobotic-letterbox`. `LETTERBOX_KEY`
is created on first start and defaults to `/etc/marobotic/letterbox.key`. Set `LETTERBOX_ZOHO_APP` to
the JSON client config; on the droplet it is `/etc/marobotic/letterbox-zoho-app.json`. The old Self
Client config at `/etc/marobotic/letterbox-zoho.json` can be carried over once to
`mi@marobotic.dev` with `LETTERBOX_CARRY_OVER`.

On the droplet: pm2 `letterbox` (`/opt/node22/bin/node --experimental-strip-types`), 127.0.0.1:8970.
The Zoho app config is `/etc/marobotic/letterbox-zoho-app.json`; account data is in
`/var/lib/marobotic-letterbox`, encrypted with `/etc/marobotic/letterbox.key`. Nginx serves it with
`location ^~ /letterbox/`.

Create the Zoho client at **api-console.zoho.com**: Add Client, choose **Server-based Applications**,
set homepage to `https://marobotic.dev/letterbox/` and redirect URI to
`https://marobotic.dev/letterbox/oauth/zoho`. Then open Settings and turn **Multi-DC** on.

Zoho notes: ids are longer than a double, so they stay strings (`parseLong`) and go back as raw JSON
numbers. Not spam is mode `markNotSpam` (the docs also say `moveNotSpam`; `markNotSpam` is the one that
works). Attachment downloads need `Accept: */*`, or Zoho answers 406. The API's unread counts are right
where Zoho's own sidebar badges are not.
