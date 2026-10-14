# Vault for Chrome, Brave and Edge

Vault in the browser, on its own: it signs in to the marobotic account, keeps the sealed vault from
marobotic.dev and opens it in the browser, exactly like the Vault app on the PC and the phone. Each one
syncs with the server by itself, so the app doesn't need to be running.

- **Fills** logins, 2FA codes and **passkeys**: suggestions open under username, password and code fields
  on the site they belong to (arrow keys + Enter work), and `Ctrl+Shift+L` fills the best match.
- **Saves** a login after you sign in with one Vault doesn't know (or **updates** a changed password),
  and **saves passkeys** when a site makes one. Sites see Vault as a synced passkey provider.
- **Suggests** a strong password in sign-up and change-password fields.
- **Replaces the browser's password manager** (its "Save password?" is turned off).
- **Popup**: *This site* (its logins, codes and passkeys) or *All items* with Logins / 2FA / Passkeys
  filters, search, item details (copy, reveal, fill, edit, pin, delete), a new-login form with the
  password generator, and **Settings** (each suggestion on or off, passkeys, saving, auto-lock, the
  shortcut, never-save sites, sync, lock, sign out).

## Security

- The vault key lives in memory and in `chrome.storage.session` (memory only, cleared when the browser
  closes) so the background worker can restart without asking again. Only the sealed vault is written
  to disk. Auto-lock: when the browser closes, or after 5 min to 4 h without use.
- Logins and codes are offered only on their own site (`src/domains.ts` in the app: registrable domain
  plus a short list of sites that share a sign-in), only over https (or the local network), and only
  for the address the browser reports for that frame; never for a look-alike.
- Passkeys: `inject.js` (the page's world) hands `navigator.credentials` calls to Vault; Vault answers
  only after a real click in its own panel (a closed shadow root the page can't reach), only in the top
  frame, and only for an `rpId` that is the page's own site. "Use another device or key" goes to the
  browser's own passkey flow.

## Build and install

```sh
npm run build -w apps/vault-extension     # -> apps/vault-extension/dist
```

`brave://extensions` (or `chrome://`, `edge://`) > **Developer mode** > **Load unpacked** > `dist`. The
manifest `key` keeps the ID fixed (`dhonkedgjnngkclmpofnejkddphdbnkp`); its private key is in
`~/.marobotic/keys/vault-extension.pem`, never in the repo. Then click the Vault icon and sign in.

## End-to-end check

`node build.mjs --e2e` builds the same extension against an in-memory account (`e2e/mock-account.ts`,
password `test-pass`) into `e2e/dist`. `e2e/cdp.mjs` serves `e2e/page.html` (a login form, a 2FA field,
passkey buttons that verify the signature) and drives a throwaway Edge/Brave profile over DevTools:
`serve`, `launch <exe>`, `open`, `eval`, `click`, `key`, `type`, `shot` (run with `--experimental-websocket`).
