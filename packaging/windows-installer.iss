; Soty Agent — Inno Setup installer template.
;
; Rendering (the same generic string replacer the mac launcher uses):
;   node scripts/render-launcher.mjs packaging/windows-installer.iss \
;     release/windows/installer.generated.iss \
;     "PRODUCT_VERSION=$(node scripts/release-meta.mjs product-version)" \
;     "BUILD_ID=$(node scripts/release-meta.mjs build-id)" \
;     "AGENT_PORT=43120"
;
; Filesystem inputs deliberately arrive as ISCC preprocessor defines instead of
; placeholders: render-launcher.mjs escapes backslashes (it targets Swift string
; literals), which would corrupt Windows paths. Compile with:
;   iscc /DStageDir=C:\path\to\release\windows\stage ^
;        /DHostDir=C:\path\to\host\publish ^
;        release\windows\installer.generated.iss
;
;   StageDir — output of scripts/stage-windows-runtime.mjs
;   HostDir  — `dotnet publish` output containing SotyAgentHost.exe (tray host)
;
; Authenticode signing is a deliberate non-goal: the build ships unsigned,
; matching the macOS build's ad-hoc signature and no notarization. SmartScreen
; warnings are handled by first-run guidance on the download page.
;
; The output file name must equal RELEASE_ARTIFACT_NAME_WINDOWS in
; packages/shared/src/release.ts (Soty-v<version>-Windows-x64.exe); CI fails the
; build otherwise.

#ifndef StageDir
  #error Pass /DStageDir=<path to release/windows/stage> to iscc
#endif
#ifndef HostDir
  #error Pass /DHostDir=<path to the SotyAgentHost dotnet publish directory> to iscc
#endif

[Setup]
; AppId identifies the product across upgrades. NEVER change it, or installs
; stop upgrading in place. (Doubled first brace is Inno constant-escaping.)
AppId={{9E1FA1D4-6C3B-4A34-9D06-2B62E7C6A3F1}
AppName=Soty
AppVersion=__PRODUCT_VERSION__
AppVerName=Soty __PRODUCT_VERSION__
AppPublisher=Soty
VersionInfoVersion=__PRODUCT_VERSION__
; Full immutable build identity (PRODUCT_VERSION+BUILD_NUMBER), for diagnostics.
VersionInfoTextVersion=__BUILD_ID__
DefaultDirName={autopf}\Soty
DefaultGroupName=Soty
DisableProgramGroupPage=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputBaseFilename=Soty-v__PRODUCT_VERSION__-Windows-x64
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
; Installing into {autopf} requires elevation; the Run key below is still
; written to the installing user's HKCU.
PrivilegesRequired=admin
UninstallDisplayName=Soty
CloseApplications=yes

[Files]
; Everything scripts/stage-windows-runtime.mjs laid out: runtime\node.exe,
; runtime\bin\*.exe, runtime\models, agent\, web\dist, licenses, release.json.
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion
; The compiled tray host (packaging/windows/, built with `dotnet publish`).
Source: "{#HostDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Registry]
; Autostart for the current user; uninsdeletevalue removes it on uninstall.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; \
  ValueType: string; ValueName: "Soty"; \
  ValueData: """{app}\SotyAgentHost.exe"""; Flags: uninsdeletevalue

[Run]
; Start the tray host right after installation finishes.
Filename: "{app}\SotyAgentHost.exe"; Description: "Start Soty"; \
  Flags: nowait postinstall skipifsilent

[UninstallRun]
; Stop the tray host before files are removed. The host is responsible for
; terminating the node agent it supervises when it exits.
Filename: "{cmd}"; Parameters: "/C taskkill /IM SotyAgentHost.exe /F"; \
  Flags: runhidden; RunOnceId: "StopSotyAgentHost"

[Code]
// Asks the running agent whether it is mid-job. Returns True only when it
// positively reports busy; an unreachable agent means nothing is running.
function AgentIsBusy(): Boolean;
var
  WinHttp: Variant;
  Body: String;
begin
  Result := False;
  try
    WinHttp := CreateOleObject('WinHttp.WinHttpRequest.5.1');
    WinHttp.SetTimeouts(2000, 2000, 2000, 2000);
    WinHttp.Open('GET', 'http://127.0.0.1:__AGENT_PORT__/health', False);
    WinHttp.Send();
    if WinHttp.Status = 200 then
    begin
      Body := WinHttp.ResponseText;
      Result := Pos('"busy":true', Body) > 0;
    end;
  except
    // No agent listening, or it answered nothing usable: nothing to interrupt.
    Result := False;
  end;
end;

// An upgrade must not replace files under a running host — and must never
// interrupt work in progress. If the agent reports a job in flight, the install
// stops with an explanation instead of killing it.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  if AgentIsBusy() then
  begin
    Result :=
      'Soty is still working on something. Let the current job finish (or cancel it' +
      ' from the Soty window), then run this installer again.';
    Exit;
  end;
  Exec(ExpandConstant('{cmd}'), '/C taskkill /IM SotyAgentHost.exe /F', '',
    SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := '';
end;
