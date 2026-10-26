# Letterbox

Marobotic's mail client on top of the Zoho mailbox mi@marobotic.dev. Zoho's Forever Free plan has no
IMAP, POP or SMTP, so Letterbox talks to the **Zoho Mail REST API** (OAuth, Self Client).

Live at **https://marobotic.dev/letterbox/**. Sign in with the marobotic account; only the accounts in
`LETTERBOX_USERS` can open the mailbox.

What it does: folders and the Unread view, reading (opening a message marks it read; images and inline
pictures shown, the mail runs in a script-less sandboxed frame), attachments to download, compose and
reply with attachments (up to 20 MB each), Cc/Bcc, and selecting several messages at once (shift-click
for a range) to mark read/unread, move to Spam, mark not spam, or delete. Delete moves to Trash;
deleting from Trash or Spam removes the mail for good.

```
server/zoho.ts     the Zoho provider (token refresh, list, read, flags, delete, upload, send)
server/server.ts   HTTP API + the built page; sign-in via maro-cache (cookie on web, Bearer in the app)
ui/                the client (Marochy kit from packages/ui), bundled by build.mjs into dist/
src-tauri/         the Windows desktop app (Rust + Tauri 2: tray, single-instance, saved session, Downloads)
icons.py           draws the pixel envelope icon set into src-tauri/icons/
installer/         standalone Windows uninstaller (Inno Setup 6)
deploy.sh          build, back up /opt/marobotic-letterbox, upload, pm2 restart
```

Build the Windows app (`Letterbox_0.1.1_x64-setup.exe`):

```powershell
npx tauri build
```

Run it locally:

```powershell
node apps/letterbox/build.mjs
$env:LETTERBOX_ZOHO = "$HOME\.marobotic\letterbox\zoho.json"   # {client_id, client_secret, refresh_token}
$env:LETTERBOX_USERS = "mi@marobotic.dev"; $env:LETTERBOX_INSECURE_COOKIE = "1"
$env:MARO_ACCOUNT_URL = "<a maro-cache, or a stand-in>"
node --import tsx apps/letterbox/server/server.ts                # http://127.0.0.1:8970
```

On the droplet: pm2 `letterbox` (`/opt/node22/bin/node --experimental-strip-types`), 127.0.0.1:8970,
config `/etc/marobotic/letterbox-zoho.json` (root only), nginx `location ^~ /letterbox/`.

Zoho notes: ids are longer than a double, so they stay strings (`parseLong`) and go back as raw JSON
numbers. Not spam is mode `markNotSpam` (the docs also say `moveNotSpam`; `markNotSpam` is the one that
works). Attachment downloads need `Accept: */*`, or Zoho answers 406. The API's unread counts are right
where Zoho's own sidebar badges are not.
