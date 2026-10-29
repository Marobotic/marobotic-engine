; Letterbox for Windows - per-user Inno Setup 6 installer.
; installer\build.ps1 supplies the version and release executable.
#ifndef AppVersion
  #error AppVersion must be supplied from tauri.conf.json by installer\build.ps1
#endif
#ifndef Payload
  #define Payload "..\src-tauri\target\release"
#endif
#ifndef OutDir
  #define OutDir GetEnv("USERPROFILE") + "\Documents\Project Exports\Letterbox\Windows"
#endif

[Setup]
AppId={{8D4E2F1A-6B3C-4E7D-9A1F-5C2B8E4D6F3A}
AppName=Letterbox
AppVersion={#AppVersion}
AppVerName=Letterbox {#AppVersion}
AppPublisher=Marobotic
AppPublisherURL=https://marobotic.dev
DefaultDirName={code:GetInstallDir}
DisableWelcomePage=yes
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=no
DisableFinishedPage=yes
PrivilegesRequired=lowest
OutputDir={#OutDir}
OutputBaseFilename=Letterbox-{#AppVersion}-setup
SetupIconFile=..\src-tauri\icons\icon.ico
UninstallDisplayIcon={app}\letterbox.exe
UninstallDisplayName=Letterbox
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0

[Files]
Source: "{#Payload}\letterbox.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{userprograms}\Letterbox"; Filename: "{app}\letterbox.exe"; WorkingDir: "{app}"; AppUserModelID: "dev.marobotic.letterbox"

[Run]
Filename: "{app}\letterbox.exe"; WorkingDir: "{app}"; Flags: nowait; Check: ShouldLaunch

; No InstallDelete or UninstallDelete: Inno owns only the files above.
; Account data and WebView data in APPDATA/LOCALAPPDATA\dev.marobotic.letterbox stay intact.
; Only the separately run Letterbox-Uninstaller.exe deliberately purges user data.
[Code]
const
  LegacyKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\Letterbox';
  UninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{8D4E2F1A-6B3C-4E7D-9A1F-5C2B8E4D6F3A}_is1';
var
  OldVersion, LegacyDir: String;
  IsUpdate, Migrated: Boolean;
  HelperCount: Integer;

function ShouldLaunch: Boolean;
begin
  Result := Pos('/NOLAUNCH', UpperCase(GetCmdTail)) = 0;
end;

function GetInstallDir(Param: String): String;
begin
  if LegacyDir <> '' then Result := LegacyDir
  else Result := ExpandConstant('{localappdata}\Letterbox');
end;

function InitializeSetup: Boolean;
begin
  IsUpdate := RegKeyExists(HKCU, UninstallKey) or RegKeyExists(HKCU, LegacyKey);
  if not RegQueryStringValue(HKCU, UninstallKey, 'DisplayVersion', OldVersion) then
    if not RegQueryStringValue(HKCU, LegacyKey, 'DisplayVersion', OldVersion) then OldVersion := '';
  if RegQueryStringValue(HKCU, LegacyKey, 'InstallLocation', LegacyDir) then
    LegacyDir := RemoveBackslashUnlessRoot(RemoveQuotes(Trim(LegacyDir)));
  Result := True;
end;

procedure CurPageChanged(CurPageID: Integer);
var
  Verb, Versions: String;
begin
  if not IsUpdate then Exit;
  if OldVersion = '{#AppVersion}' then Verb := 'Reinstall' else Verb := 'Update';
  if (OldVersion = '') or (OldVersion = '{#AppVersion}') then
    Versions := 'Letterbox {#AppVersion}'
  else
    Versions := 'Letterbox ' + OldVersion + ' ' + #$2192 + ' {#AppVersion}';
  WizardForm.Caption := Verb + ' Letterbox';
  if CurPageID = wpReady then begin
    WizardForm.PageNameLabel.Caption := 'Ready to ' + Lowercase(Verb);
    WizardForm.PageDescriptionLabel.Caption := Versions;
    WizardForm.ReadyLabel.Caption := 'Click ' + Verb + ' to ' + Lowercase(Verb) + ' ' + Versions + '. Your sign-in and settings stay as they are.';
    WizardForm.NextButton.Caption := Verb;
  end else if CurPageID = wpInstalling then begin
    if Verb = 'Update' then WizardForm.PageNameLabel.Caption := 'Updating' else WizardForm.PageNameLabel.Caption := 'Reinstalling';
    WizardForm.PageDescriptionLabel.Caption := Versions;
  end;
end;

function PSQuote(Value: String): String;
begin
  StringChangeEx(Value, '''', '''''', True);
  Result := '''' + Value + '''';
end;

// A bounded hidden helper keeps setup responsive, including if CIM or the old uninstaller stalls.
function RunHelper(const Script: String; Seconds: Integer): Boolean;
var
  ScriptPath, DonePath: String;
  Status: AnsiString;
  Code, I: Integer;
  Lines: TArrayOfString;
begin
  Result := False;
  HelperCount := HelperCount + 1;
  ScriptPath := ExpandConstant('{tmp}\letterbox-prepare-') + IntToStr(HelperCount) + '.ps1';
  DonePath := ScriptPath + '.done';
  DeleteFile(DonePath);
  SetArrayLength(Lines, 1);
  Lines[0] :=
    '$ErrorActionPreference = ''Stop'';' + #13#10 +
    'try {' + #13#10 + Script + #13#10 +
    '$status = ''ok''' + #13#10 +
    '} catch { $status = $_.Exception.Message }' + #13#10 +
    'Set-Content -LiteralPath ' + PSQuote(DonePath + '.tmp') + ' -Value $status -Encoding ASCII' + #13#10 +
    'Move-Item -LiteralPath ' + PSQuote(DonePath + '.tmp') + ' -Destination ' + PSQuote(DonePath);
  if not SaveStringsToUTF8File(ScriptPath, Lines, False) then Exit;
  if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + ScriptPath + '"', '', SW_HIDE, ewNoWait, Code) then Exit;
  for I := 1 to Seconds * 10 do begin
    if FileExists(DonePath) then begin
      if LoadStringFromFile(DonePath, Status) then Result := Trim(Status) = 'ok';
      if not Result then Log(Status);
      Exit;
    end;
    Sleep(100);
    if not IsUninstaller then WizardForm.Update;
  end;
end;

function CloseApp: Boolean;
var
  Script: String;
begin
  Script := '$paths = @(' + PSQuote(ExpandConstant('{app}\letterbox.exe')) + ', ' + PSQuote(AddBackslash(LegacyDir) + 'letterbox.exe') + ');' + #13#10 +
    '$procs = @(Get-CimInstance Win32_Process -Filter "Name=''letterbox.exe''" | Where-Object { $_.ExecutablePath -and $paths -contains $_.ExecutablePath });' + #13#10 +
    'foreach ($proc in $procs) {' + #13#10 +
    '  $p = Get-Process -Id $proc.ProcessId -ErrorAction SilentlyContinue;' + #13#10 +
    '  if ($p) { Stop-Process -Id $p.Id -Force; if (-not $p.WaitForExit(5000)) { throw ''Letterbox did not close.'' } }' + #13#10 +
    '}';
  Result := RunHelper(Script, 15);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Script, Unins: String;
begin
  Result := '';
  WizardForm.PageDescriptionLabel.Caption := 'Closing Letterbox...';
  if not CloseApp then begin
    Result := 'Could not close Letterbox. Close it and try again.';
    Exit;
  end;
  if RegKeyExists(HKCU, LegacyKey) and not Migrated then begin
    if LegacyDir = '' then begin
      Result := 'The old Letterbox install location is missing. Repair the old install before updating.';
      Exit;
    end;
    Unins := AddBackslash(LegacyDir) + 'uninstall.exe';
    if not FileExists(Unins) then begin
      Result := 'The old Letterbox uninstaller is missing. Repair the old install before updating.';
      Exit;
    end;
    WizardForm.PageDescriptionLabel.Caption := 'Updating the old Letterbox installation...';
    // /UPDATE explicitly disables Tauri's data deletion and preserves autostart.
    // _?= must be last and unquoted: run in place so waiting covers the real uninstaller.
    Script := '$p = Start-Process -FilePath ' + PSQuote(Unins) +
      ' -ArgumentList ' + PSQuote('/S /UPDATE _?=' + LegacyDir) + ' -WindowStyle Hidden -PassThru;' + #13#10 +
      'if (-not $p.WaitForExit(30000)) { $p.Kill(); throw ''Old uninstaller timed out.'' };' + #13#10 +
      'if ($p.ExitCode -ne 0) { throw (''Old uninstaller failed: '' + $p.ExitCode) };' + #13#10 +
      'if (Test-Path -LiteralPath ' + PSQuote(AddBackslash(LegacyDir) + 'letterbox.exe') + ') { throw ''Old executable was not removed.'' }';
    if not RunHelper(Script, 35) then begin
      Result := 'Could not remove the old Letterbox program. Your data was kept. Close Letterbox and try again.';
      Exit;
    end;
    Migrated := True;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then begin
    if Migrated then begin
      DeleteFile(AddBackslash(LegacyDir) + 'uninstall.exe');
      RegDeleteKeyIncludingSubkeys(HKCU, LegacyKey);
    end;
    DeleteFile(ExpandConstant('{userdesktop}\Letterbox.lnk'));
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Command: String;
begin
  if CurUninstallStep = usUninstall then begin
    if not CloseApp then RaiseException('Could not close Letterbox. Close it and try uninstalling again.');
    if RegQueryStringValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Run', 'Letterbox', Command) and
       (Pos(Lowercase(ExpandConstant('{app}\letterbox.exe')), Lowercase(Command)) > 0) then
      RegDeleteValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Run', 'Letterbox');
  end;
end;
