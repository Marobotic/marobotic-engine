# Vault for Chrome, Brave and Edge

Fills logins and 2FA codes from the **Vault app on this PC**, offers to save a login after you sign in
with one Vault doesn't know (or to update a changed password), suggests a strong password in sign-up and
change-password forms, and turns off the browser's own "Save password?" so only Vault asks.

The extension keeps no passwords. It talks to the running Vault app on `127.0.0.1:47350`, which:

- only answers browser extensions (web pages can't fake the `Origin` header; the `Host` must be 127.0.0.1),
- answers nothing until you click **Allow** in Vault for that browser (Connect in the popup shows a code
  that Vault shows too), and
- looks a page's logins up only for the address the browser reports for that page: a login for
  `github.com` is never offered on `github.com.evil.io`, a plain-`http` page, or a cross-site frame.

## Build and install

```sh
npm run build -w apps/vault-extension     # -> apps/vault-extension/dist
```

`brave://extensions` (or `chrome://extensions`, `edge://extensions`) > **Developer mode** on > **Load
unpacked** > choose `apps/vault-extension/dist`. The `key` in the manifest keeps its ID fixed
(`dhonkedgjnngkclmpofnejkddphdbnkp`); the private key is in `~/.marobotic/keys/vault-extension.pem`,
never in the repo. Then click the Vault icon > **Connect**, and **Allow** in the Vault app.

## Using it

- Click a username, password or 2FA-code field: Vault's list opens under it. Arrow keys + Enter work too.
- `Ctrl+Shift+L` fills the best login (or the 2FA code, when a code field is focused).
- New-password fields offer **Use a strong password** (filled into the confirm box too).
- After signing in, **Save this login to Vault?** (or **Update the password?**) appears top right.
  **Never for this site** is undone with **Ask again** at the bottom of the popup.
- The popup: this site's logins (Fill, copy user, copy password) and codes (click to copy), search
  everything, **Strong password** (copied), and the switch that hands password saving back to the browser.
- Passwords already saved in the browser are still offered by it: import them into Vault
  (export a CSV from the browser's password settings, Vault > Import), then delete them from the browser.
