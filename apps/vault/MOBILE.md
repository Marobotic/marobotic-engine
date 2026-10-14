# Vault on mobile

Same engine, same web UI (Tauri 2 mobile wraps `apps/vault/dist`).

## Android (built on this PC)
Needs: Android SDK + NDK, Rust android targets, JDK (all under `%LOCALAPPDATA%\Android\Sdk`).

```powershell
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:NDK_HOME = (Get-ChildItem "$env:ANDROID_HOME\ndk" | Select -Last 1).FullName
$env:JAVA_HOME = "$env:ANDROID_HOME\jdk"
cd apps/vault
npx tauri android init     # once; generates src-tauri/gen/android
npx tauri android build --debug   # debug-signed APK for testing
```
Release signing reuses the shared marobotic key (`C:\Users\Maro\.marobotic\keys\marobotic-release.jks`,
alias `marobotic`) via `src-tauri/gen/android/keystore.properties`. Install on the A07 with
`mdeploy android install <apk> --serial 192.168.3.173:5555`.

### What the Android app adds (in `src-tauri/gen/android`, kept in git)
- **Autofill service** (`VaultAutofillService.kt`): Vault > Settings > *Choose Vault* opens Android's
  autofill picker. Under sign-in fields in apps and browsers it offers the matching logins, **Use a strong
  password** in sign-up fields, and the current **2FA code** in code fields, and Android's *Save to Vault?*
  keeps new logins. It only works from memory while Vault is unlocked (`AutofillStore.kt`, filled by
  `ui/platform.ts` > `setAutofill`); when locked, the entry *Vault is locked* opens Vault to unlock
  and then fills. Chrome on Android also needs *Settings > Autofill services > Autofill using another service*.
- **Passkeys and passwords in Credential Manager** (Android 14+, `VaultCredentialService.kt`,
  `PasskeyActivity.kt`, `Passkeys.kt`): Vault saves new passkeys and signs in with them in apps and
  browsers, the same format as the browser extension. A browser's page origin is trusted only from the
  browsers on Google's list (`res/raw/privileged_browsers.json`, from gstatic); any other app must be
  named in the site's `/.well-known/assetlinks.json`. Settings > *Choose Vault* opens *Passwords,
  passkeys & autofill*. Not yet: a fingerprint prompt before using a passkey.
- **Camera**: Add > *Scan with the camera* (getUserMedia + jsQR; the CAMERA permission is asked on first use).
- **otpauth:// links** open Vault (intent filter on `MainActivity`), which asks before adding the code.

## iOS (CI only)
iOS can't be built on Windows. `.github/workflows/vault-ios.yml` builds an unsigned `.ipa` on a macOS
runner; install it on the iPhone with `mdeploy ios update <owner>/marobotic-engine --source actions`
(signs with a free Apple ID). Needs the repo on GitHub and a push to `main`.
A paid Apple Developer account is still required later for the AutoFill extension (default keychain).
