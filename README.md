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
    src/domains.ts      which logins/codes belong to a page or app (the phishing guard)
    src/passkeys.ts     WebAuthn passkeys made and used by Vault (ES256, synced)
  vault-extension/  Vault for Chrome/Brave/Edge, standalone: signs in, syncs, fills logins/2FA/passkeys,
                    saves logins and passkeys, Proton-Pass-style popup with settings
  letterbox/   Letterbox: the mail client on the Zoho mailbox, live at marobotic.dev/letterbox
```

```sh
npm install
npm test            # every package and app (node:test via tsx)
npm run typecheck   # tsc, strict
```

Build the Windows installers with Inno Setup 6 installed (run from this repo):

```powershell
npm run app --workspace @marobotic/vault
npm run app --workspace @marobotic/letterbox
```

Each app's `installer/build.ps1` builds its UI, runs Cargo in release mode with two jobs and
Tauri's production protocol, then compiles both `<App>-<version>-setup.exe` and
`<App>-Uninstaller.exe` into `Documents/Project Exports/<App>/Windows`. The version comes from
`src-tauri/tauri.conf.json`; Tauri's own installer bundling is disabled.

Setup keeps the old NSIS install location and runs its `uninstall.exe /S /UPDATE` in place before
replacing program files. `/UPDATE` explicitly prevents Tauri from deleting account or WebView data.
Subsequent updates use Inno's uninstall key. Setup never runs the standalone uninstaller and has no
`[InstallDelete]` or `[UninstallDelete]` rules. Normal Inno uninstall also keeps user data. The separate
standalone uninstaller remains an explicit full removal tool: it deletes local account and window
data, including unsynced Vault changes, as its confirmation page explains.

The Dock catalog must change separately to `"installer": "inno"`, with these `registry` values
(under `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall`):

| App | Registry key |
| --- | --- |
| Vault | `{6E1B7C2A-3D4F-4A5B-9C8D-7E6F5A4B3C2D}_is1` |
| Letterbox | `{8D4E2F1A-6B3C-4E7D-9A1F-5C2B8E4D6F3A}_is1` |

To check compilation without a release build, put stub `vault.exe` and `letterbox.exe` files in a
temporary directory. Pass `/DAppVersion=<config version> /DPayload=<stub directory>
/DOutDir=<temporary output>` to ISCC for each app's setup and standalone uninstaller `.iss`. Do not
run the resulting executables: they are compilation checks, not usable releases. A live migration
test still needs a disposable Windows user with an old NSIS install and sample data.

Coming next (see the plan): the Tauri shell and the Vault window, sign-in v2 in maro-cache, the sync
server, the Chrome/Brave/Firefox extension, Android, iOS.
