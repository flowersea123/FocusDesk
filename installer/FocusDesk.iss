; Build with scripts/build-installer.mjs. No user data/config is included here.
#ifndef StageDir
  #error StageDir must point to a fresh verified payload directory
#endif
#ifndef OutputDir
  #error OutputDir must point to the build's output directory
#endif
#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif

[Setup]
#ifdef M1TestUserDataDir
AppId=FocusDesk.Desktop.Test.{#TestBuildId}
AppName=FocusDesk M1 Test
#else
AppId=FocusDesk.Desktop
AppName=FocusDesk
#endif
AppVersion={#AppVersion}
AppPublisher=FocusDesk
DefaultDirName={localappdata}\Programs\FocusDesk
DefaultGroupName=FocusDesk
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64os
MinVersion=10.0
DisableDirPage=yes
DisableProgramGroupPage=yes
UsePreviousLanguage=yes
UninstallDisplayIcon={app}\launcher\FocusDesk.exe
OutputDir={#OutputDir}
OutputBaseFilename=FocusDesk-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
RestartApplications=no
SetupLogging=yes
Uninstallable=yes

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\FocusDesk"; Filename: "{app}\launcher\FocusDesk.exe"; Parameters: "{code:LaunchParameters}"; WorkingDir: "{app}"
Name: "{autodesktop}\FocusDesk"; Filename: "{app}\launcher\FocusDesk.exe"; Parameters: "{code:LaunchParameters}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\launcher\FocusDesk.exe"; Parameters: "{code:LaunchParameters}"; Description: "Launch FocusDesk"; Flags: nowait postinstall skipifsilent

[Code]
function LaunchParameters(Param: String): String;
begin
#ifdef M1TestUserDataDir
  Result := '--test-mode --user-data-dir "{#M1TestUserDataDir}"';
#else
  Result := '';
#endif
end;

function StopFocusDesk(): Boolean;
var
  Launcher: String;
  ExitCode: Integer;
begin
  Result := True;
  Launcher := ExpandConstant('{app}\launcher\FocusDesk.exe');
  if FileExists(Launcher) then
    Result := Exec(Launcher, '--shutdown ' + LaunchParameters(''),
      ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ExitCode) and (ExitCode = 0);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if not StopFocusDesk() then
    Result := 'FocusDesk could not stop safely. Close FocusDesk and retry. No files have been replaced.';
end;

function InitializeUninstall(): Boolean;
begin
  Result := StopFocusDesk();
  if not Result then
    MsgBox('FocusDesk could not stop safely. Close FocusDesk and retry uninstalling.', mbError, MB_OK);
end;

// No UninstallDelete, firewall rules, Windows services, Run keys or scheduled tasks.
// The installer only owns its app directory; external FocusDesk user data is retained.
