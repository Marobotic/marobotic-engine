; Vault Uninstaller (Inno Setup 6): a standalone program that removes Vault from this PC and
; everything it added, even when the app is missing or broken.
;
;   ISCC /DAppVersion=0.3.6 apps\vault\installer\Vault-Uninstaller.iss
;
;   1. closes Vault (it keeps running in the tray),
;   2. runs the installed app's own uninstaller when there is one,
;   3. removes the otpauth:// link handler, only when it is Vault's,
;   4. when "Only Vault fills passwords" is on: turns the browsers' own password managers back on
;      (one administrator prompt, only Vault's three policy values),
;   5. deletes what is left: program folder, the vault copy and window data, shortcuts, uninstall entry.
; The vault itself stays in the marobotic account. It installs nothing and leaves no uninstaller.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{6E1B7C2A-3D4F-4A5B-9C8D-7E6F5A4B3C2D}
AppName=Vault Uninstaller
AppVersion={#AppVersion}
AppPublisher=Marobotic
CreateAppDir=no
Uninstallable=no
PrivilegesRequired=lowest
DisableWelcomePage=no
DisableReadyPage=no
DisableFinishedPage=no
OutputDir=..\src-tauri\target\release\bundle\uninstaller
OutputBaseFilename=Vault-Uninstaller
SetupIconFile=..\src-tauri\icons\icon.ico
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Messages]
SetupAppTitle=Remove Vault
SetupWindowTitle=Remove Vault
WelcomeLabel1=Remove Vault
WelcomeLabel2=This removes Vault and everything it added to this computer:%n%n  • the app, its tray icon and its shortcuts%n  • the copy of your vault kept on this PC%n  • Vault opening "Add to authenticator app" links%n  • "Only Vault fills passwords" (your browsers' own password managers come back on)%n%nYour vault stays in your marobotic account: sign in to Vault on any device to get everything back. Changes made on this PC while offline, and never synced, are lost.
WizardReady=Ready to remove
ReadyLabel1=Vault will be removed from this computer.
ReadyLabel2a=Click Remove to continue.
ButtonInstall=&Remove
WizardInstalling=Removing
InstallingLabel=Removing Vault. This takes a few seconds.
StatusExtractFiles=Preparing...
FinishedHeadingLabel=Vault is removed
FinishedLabelNoIcons=Everything Vault added to this computer is gone.%n%nThe Vault browser extension is part of your browser: to remove it, open the browser's extensions page and click Remove on Vault.
ClickFinish=Click Finish to close.

[Code]
function Policy(i: Integer): String;
begin
  case i of
    0: Result := 'SOFTWARE\Policies\BraveSoftware\Brave';
    1: Result := 'SOFTWARE\Policies\Google\Chrome';
  else Result := 'SOFTWARE\Policies\Microsoft\Edge';
  end;
end;

function PolicyValue(j: Integer): String;
begin
  case j of
    0: Result := 'PasswordManagerEnabled';
    1: Result := 'AutofillAddressEnabled';
  else Result := 'AutofillCreditCardEnabled';
  end;
end;

procedure Run(const Exe, Params: String);
var
  Code: Integer;
begin
  Exec(Exe, Params, '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

{ "Only Vault fills passwords": Vault set these to 0 in HKLM (admin). Removing just those values gives
  each browser its password manager back; other policies are left alone. }
procedure UndoBrowserLockdown;
var
  i, j, Code: Integer;
  Script: String;
  V: Cardinal;
begin
  Script := '';
  for i := 0 to 2 do
    for j := 0 to 2 do
      if RegQueryDWordValue(HKLM64, Policy(i), PolicyValue(j), V) and (V = 0) then
        Script := Script + 'reg delete "HKLM\' + Policy(i) + '" /v ' + PolicyValue(j) + ' /f /reg:64' + #13#10;
  if Script = '' then Exit;
  SaveStringToFile(ExpandConstant('{tmp}\vault-unlock-browsers.cmd'), '@echo off' + #13#10 + Script, False);
  if not ShellExec('runas', ExpandConstant('{cmd}'), '/c "' + ExpandConstant('{tmp}\vault-unlock-browsers.cmd') + '"', '', SW_HIDE, ewWaitUntilTerminated, Code) then
    MsgBox('Your browsers still have their own password managers turned off ("Only Vault fills passwords"), because Windows didn''t give permission.' + #13#10#13#10 +
      'To turn them back on later, run this uninstaller again and allow the prompt.', mbInformation, MB_OK);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Unins, AppDir, Cmd: String;
  i: Integer;
begin
  if CurStep <> ssPostInstall then Exit;
  AppDir := ExpandConstant('{localappdata}\Vault');

  // 1. Close Vault (X only hides it to the tray), and its window's WebView2 processes, which hold
  //    the window data folder open for a few seconds after Vault itself is gone.
  Run(ExpandConstant('{sys}\taskkill.exe'), '/F /T /IM vault.exe');
  Run(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), '-NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process -Filter ''Name=''''msedgewebview2.exe'''''' | ' +
    'Where-Object { $_.CommandLine -match ''dev\.marobotic\.vault'' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"');

  // 2. The installed app's own uninstaller. It runs from a copy of itself, so wait for the app to go.
  Unins := AppDir + '\uninstall.exe';
  if FileExists(Unins) then begin
    Run(Unins, '/S');
    for i := 1 to 60 do begin
      if not FileExists(AppDir + '\vault.exe') then Break;
      Sleep(500);
    end;
  end;

  // 3. The otpauth:// handler, only when it opens Vault (never another authenticator's).
  if RegQueryStringValue(HKCU, 'Software\Classes\otpauth\shell\open\command', '', Cmd) and (Pos('\vault.exe', Lowercase(Cmd)) > 0) then
    RegDeleteKeyIncludingSubkeys(HKCU, 'Software\Classes\otpauth');

  // 4. The browsers' own password managers back on.
  UndoBrowserLockdown;

  // 5. Whatever is left.
  DelTree(AppDir, True, True, True);
  DelTree(ExpandConstant('{userappdata}\dev.marobotic.vault'), True, True, True);
  for i := 1 to 20 do begin   // the window data, once nothing holds it open
    DelTree(ExpandConstant('{localappdata}\dev.marobotic.vault'), True, True, True);
    if not DirExists(ExpandConstant('{localappdata}\dev.marobotic.vault')) then Break;
    Sleep(500);
  end;
  DeleteFile(ExpandConstant('{userprograms}\Vault.lnk'));
  DeleteFile(ExpandConstant('{userdesktop}\Vault.lnk'));
  RegDeleteKeyIncludingSubkeys(HKCU, 'Software\Marobotic\Vault');
  RegDeleteKeyIfEmpty(HKCU, 'Software\Marobotic');
  RegDeleteKeyIncludingSubkeys(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\Vault');
end;
