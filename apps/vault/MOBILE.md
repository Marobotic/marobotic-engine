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

## iOS (CI only)
iOS can't be built on Windows. `.github/workflows/vault-ios.yml` builds an unsigned `.ipa` on a macOS
runner; install it on the iPhone with `mdeploy ios update <owner>/marobotic-engine --source actions`
(signs with a free Apple ID). Needs the repo on GitHub and a push to `main`.
A paid Apple Developer account is still required later for the AutoFill extension (default keychain).
