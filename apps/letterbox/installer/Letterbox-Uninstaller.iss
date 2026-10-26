; Letterbox Uninstaller (Inno Setup 6): a standalone program that removes Letterbox from this PC and
; everything it added, even when the app is missing or broken.
;
;   ISCC /DAppVersion=0.1.3 apps\letterbox\installer\Letterbox-Uninstaller.iss
;
;   1. closes Letterbox (it keeps running in the tray),
;   2. runs the installed app's own uninstaller when there is one,
;   3. deletes what is left: program folder, session and window data, shortcuts, uninstall entry.
; Your mail stays on your marobotic account. It installs nothing and leaves no uninstaller.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
; The setup goes straight to Documents\Project Exports\Letterbox\Windows (/DOutDir=... for elsewhere).
#ifndef OutDir
  #define OutDir GetEnv("USERPROFILE") + "\Documents\Project Exports\Letterbox\Windows"
#endif

[Setup]
AppId={{8D4E2F1A-6B3C-4E7D-9A1F-5C2B8E4D6F3A}
AppName=Letterbox Uninstaller
AppVersion={#AppVersion}
AppPublisher=Marobotic
CreateAppDir=no
Uninstallable=no
PrivilegesRequired=lowest
DisableWelcomePage=no
DisableReadyPage=no
DisableFinishedPage=no
OutputDir={#OutDir}
OutputBaseFilename=Letterbox-Uninstaller
SetupIconFile=..\src-tauri\icons\icon.ico
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Messages]
SetupAppTitle=Remove Letterbox
SetupWindowTitle=Remove Letterbox
WelcomeLabel1=Remove Letterbox
WelcomeLabel2=This removes Letterbox and everything it added to this computer:%n%n  • the app, its tray icon and its shortcuts%n  • its saved sign-in and window data on this PC%n%nYour mail stays in your marobotic account: sign in to Letterbox on any device or at marobotic.dev/letterbox to open your mailbox.
WizardReady=Ready to remove
ReadyLabel1=Letterbox will be removed from this computer.
ReadyLabel2a=Click Remove to continue.
ButtonInstall=&Remove
WizardInstalling=Removing
InstallingLabel=Removing Letterbox. This takes a few seconds.
StatusExtractFiles=Preparing...
FinishedHeadingLabel=Letterbox is removed
FinishedLabelNoIcons=Everything Letterbox added to this computer is gone.
ClickFinish=Click Finish to close.

[Code]
procedure Run(const Exe, Params: String);
var
  Code: Integer;
begin
  Exec(Exe, Params, '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Unins, AppDir: String;
  i: Integer;
begin
  if CurStep <> ssPostInstall then Exit;
  AppDir := ExpandConstant('{localappdata}\Letterbox');

  // 1. Close Letterbox (X only hides it to the tray), and its window's WebView2 processes.
  Run(ExpandConstant('{sys}\taskkill.exe'), '/F /T /IM letterbox.exe');
  Run(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), '-NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process -Filter ''Name=''''msedgewebview2.exe'''''' | ' +
    'Where-Object { $_.CommandLine -match ''dev\.marobotic\.letterbox'' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"');

  // 2. The installed app's own uninstaller.
  Unins := AppDir + '\uninstall.exe';
  if FileExists(Unins) then begin
    Run(Unins, '/S');
    for i := 1 to 60 do begin
      if not FileExists(AppDir + '\letterbox.exe') then Break;
      Sleep(500);
    end;
  end;

  // 3. Whatever is left.
  DelTree(AppDir, True, True, True);
  DelTree(ExpandConstant('{userappdata}\dev.marobotic.letterbox'), True, True, True);
  for i := 1 to 20 do begin
    DelTree(ExpandConstant('{localappdata}\dev.marobotic.letterbox'), True, True, True);
    if not DirExists(ExpandConstant('{localappdata}\dev.marobotic.letterbox')) then Break;
    Sleep(500);
  end;
  DeleteFile(ExpandConstant('{userprograms}\Letterbox.lnk'));
  DeleteFile(ExpandConstant('{userdesktop}\Letterbox.lnk'));
  RegDeleteKeyIncludingSubkeys(HKCU, 'Software\Marobotic\Letterbox');
  RegDeleteKeyIfEmpty(HKCU, 'Software\Marobotic');
  RegDeleteKeyIncludingSubkeys(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\Letterbox');
end;
