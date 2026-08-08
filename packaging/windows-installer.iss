; Soty Agent — Inno Setup installer template.
;
; Rendering (the same generic string replacer the mac launcher uses):
;   node scripts/render-launcher.mjs packaging/windows-installer.iss \
;     release/windows/installer.generated.iss \
;     "PRODUCT_VERSION=$(node scripts/release-meta.mjs product-version)" \
;     "BUILD_ID=$(node scripts/release-meta.mjs build-id)"
;
; Filesystem inputs deliberately arrive as ISCC preprocessor defines instead of
; placeholders: render-launcher.mjs escapes backslashes (it targets Swift string
; literals), which would corrupt Windows paths. Compile with:
;   iscc /DStageDir=C:\path\to\release\windows\stage ^
;        /DHostDir=C:\path\to\host\publish ^
;        release\windows\installer.generated.iss
;
;   StageDir — output of scripts/stage-windows-runtime.mjs
;   HostDir  — `dotnet publish` output containing WishlyAgentHost.exe (tray host)
;
; Authenticode: sign both the host exe (before iscc) and the produced installer
; (after iscc), otherwise SmartScreen flags the download:
;   signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 ^
;     /a <HostDir>\WishlyAgentHost.exe
;   signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 ^
;     /a Output\Soty-Agent-v__PRODUCT_VERSION__-Windows-x64.exe
; Inno can also sign intermediate files itself via SignTool=... if configured.

#ifndef StageDir
  #error Pass /DStageDir=<path to release/windows/stage> to iscc
#endif
#ifndef HostDir
  #error Pass /DHostDir=<path to the WishlyAgentHost dotnet publish directory> to iscc
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
  ValueData: """{app}\WishlyAgentHost.exe"""; Flags: uninsdeletevalue

[Run]
; Start the tray host right after installation finishes.
Filename: "{app}\WishlyAgentHost.exe"; Description: "Start Soty"; \
  Flags: nowait postinstall skipifsilent

[UninstallRun]
; Stop the tray host before files are removed. The host is responsible for
; terminating the node agent it supervises when it exits.
Filename: "{cmd}"; Parameters: "/C taskkill /IM WishlyAgentHost.exe /F"; \
  Flags: runhidden; RunOnceId: "StopWishlyAgentHost"

[Code]
// An upgrade must not copy over a running host; stop it before install too.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{cmd}'), '/C taskkill /IM WishlyAgentHost.exe /F', '',
    SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := '';
end;
