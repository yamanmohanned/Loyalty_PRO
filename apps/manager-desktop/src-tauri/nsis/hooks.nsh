; Walaa — NSIS installer hooks.
;
; CLAUDE_v3.md 12.3 requires ONE installer covering the Tauri app, the API service
; and SQLite. These hooks are how the single setup file also registers the Windows
; Service: Tauri copies `runtime\` in as a bundled resource, and `walaa-service.exe`
; does the SCM registration, per-installation secret generation and firewall rule.
;
; ASCII only, deliberately. Every user-visible string comes from Tauri's own
; translated installer templates; text typed here would bypass them and risks a
; mojibake title bar on a non-Unicode makensis.
;
; The installer runs elevated (installMode: perMachine), which is what the Service
; Control Manager and `netsh advfirewall` both require.

!macro NSIS_HOOK_PREINSTALL
  ; On an upgrade the service is running and holds node.exe and the query engine
  ; open, so the file copy would fail. Deregistering first releases them. On a first
  ; install this path does not exist yet and the call is a no-op.
  ; The +4 skips DetailPrint, nsExec and its Pop. nsExec always pushes a result;
  ; leaving it on the stack would corrupt the next Pop in Tauri's own template.
  IfFileExists "$INSTDIR\runtime\walaa-service.exe" 0 +4
    DetailPrint "Stopping the Walaa API service..."
    nsExec::ExecToLog '"$INSTDIR\runtime\walaa-service.exe" uninstall'
    Pop $0
!macroend

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Registering the Walaa API service..."
  nsExec::ExecToLog '"$INSTDIR\runtime\walaa-service.exe" install'
  Pop $0
  ${If} $0 != 0
    ; Not fatal to the install: the dashboard is on disk and the service can be
    ; registered by hand. Saying so beats a silent half-installation.
    MessageBox MB_ICONEXCLAMATION|MB_OK "The Walaa API service could not be registered (code $0).$\r$\nRun runtime\walaa-service.exe install from an elevated prompt."
  ${Else}
    DetailPrint "Starting the Walaa API service..."
    nsExec::ExecToLog '"$INSTDIR\runtime\walaa-service.exe" start'
    Pop $0
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Stop and deregister before the files go. The data directory under
  ; %PROGRAMDATA%\Walaa is deliberately left behind — see `uninstall` in
  ; packaging/service-host/src/main.rs.
  IfFileExists "$INSTDIR\runtime\walaa-service.exe" 0 +4
    DetailPrint "Removing the Walaa API service..."
    nsExec::ExecToLog '"$INSTDIR\runtime\walaa-service.exe" uninstall'
    Pop $0
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
!macroend
