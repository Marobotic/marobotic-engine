# marobotic engine

One engine for every new marobotic app: the logic and the screens in **TypeScript**, a **Tauri 2**
shell for Windows, Linux, Android and iOS, browser extensions from the same code, and the **Marochy**
theme. Native Kotlin/Swift only as small plugins where a phone insists (autofill, passkeys).

```
packages/
  crypto/      account keys + sealed boxes (libsodium/WASM): one password, the server never sees it
  otp/         TOTP/HOTP (RFC 4226/6238) and otpauth:// links
  importers/   2FA imports: Google Authenticator export QR links, otpauth:// text (more to come)
apps/
  vault/       Vault: encrypted 2FA + passwords + passkeys
    src/vault.ts        items sealed one by one, recovery kit, two-device merge
    src/xivlauncher.ts  sends the FFXIV code to XIVLauncher (port 4646) when it asks
```

```sh
npm install
npm test            # every package and app (node:test via tsx)
npm run typecheck   # tsc, strict
```

Coming next (see the plan): the Tauri shell and the Vault window, sign-in v2 in maro-cache, the sync
server, the Chrome/Brave/Firefox extension, Android, iOS.
