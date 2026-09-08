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

; ---------------------------------------------------------------------------
;  Demo builds do not register a Windows Service.
; ---------------------------------------------------------------------------
;
;  A demo installs per-user and unelevated, so it CANNOT open the Service Control
;  Manager or write a firewall rule -- those calls would simply fail. And on a
;  machine where the user happens to be an administrator they would SUCCEED, which
;  is worse: a demo backend left running as LocalSystem for every account on the PC,
;  holding a port and a database, after the person who tried the demo has forgotten
;  about it.
;
;  A demo supervises its own backend instead: the app launches
;  `walaa-service.exe console`, which runs the SAME supervisor the service runs.
;  The launcher is the fork; the supervision is shared. A demo that were babysat by
;  different code would prove nothing about the merchant's real install.
;
;  Detected by the shipped seed database -- the same signal the service host and the
;  app shell both use. One fact read in three places, with nothing to fall out of
;  step with anything else.

!macro NSIS_HOOK_PREINSTALL
  ; On a same-path upgrade the service is running and holds node.exe and the query
  ; engine open, so the file copy would fail. Deregistering first releases them. On a
  ; first install this path does not exist yet and the call is a no-op.
  ; The +4 skips DetailPrint, nsExec and its Pop. nsExec always pushes a result;
  ; leaving it on the stack would corrupt the next Pop in Tauri's own template.
  IfFileExists "$INSTDIR\runtime\walaa-service.exe" 0 +4
    DetailPrint "Stopping the API service..."
    nsExec::ExecToLog '"$INSTDIR\runtime\walaa-service.exe" uninstall'
    Pop $0
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; ---------------------------------------------------------------------------
  ;  Deregister ANY previously registered service before registering this one.
  ; ---------------------------------------------------------------------------
  ;
  ;  See CLAUDE_v3.md 12.36. `productName` sets $INSTDIR, so renaming the product
  ;  points a new installer at a new directory and leaves the old installation
  ;  untouched: its service keeps running from stale binaries, holding the API port
  ;  and the SQLite database, while the new service cannot register because
  ;  `WalaaApi` already exists. The shop keeps working on the old code and nobody
  ;  notices — which is what makes it dangerous rather than obvious.
  ;
  ;  This line is the whole fix, and it works for one reason: the service is
  ;  deregistered **by name**, and `SERVICE_NAME` is frozen by the rule in 12.36.
  ;  `uninstall` opens the SCM and acts on `WalaaApi` wherever its binary lives, so
  ;  the new build can retire an installation it cannot even see on disk. It stops
  ;  the old service first (with a grace period), which is also what releases the
  ;  database before the new one starts.
  ;
  ;  It runs here rather than in PREINSTALL because `runtime\` does not exist yet at
  ;  that point on a renamed install — the files have not been copied.
  ;
  ;  Unconditional and idempotent: `uninstall` returns success when nothing is
  ;  registered, and on a same-path upgrade PREINSTALL already did it, so this is a
  ;  no-op there. It also drops the firewall rule, which `install` recreates under
  ;  the same (also frozen) name a moment later.
  ;
  ;  !! UNVERIFIED !! The renamed-install path has never executed against a real
  ;  prior installation, and cannot be from a development machine — it needs a box
  ;  that already has one. Treat it as untested until somebody upgrades a real
  ;  install with it. The no-op cases (first install, same-path upgrade) are the
  ;  only ones actually exercised.
  ; A demo build stops here: no SCM registration, no firewall rule, no elevation.
  IfFileExists "$INSTDIR\runtime\walaa-demo.db" demo_no_service 0

  DetailPrint "Removing any previously registered API service..."
  nsExec::ExecToLog '"$INSTDIR\runtime\walaa-service.exe" uninstall'
  Pop $0

  DetailPrint "Registering the API service..."
  nsExec::ExecToLog '"$INSTDIR\runtime\walaa-service.exe" install'
  Pop $0
  ${If} $0 != 0
    ; Not fatal to the install: the dashboard is on disk and the service can be
    ; registered by hand. Saying so beats a silent half-installation.
    MessageBox MB_ICONEXCLAMATION|MB_OK "The API service could not be registered (code $0).$\r$\nRun runtime\walaa-service.exe install from an elevated prompt."
  ${Else}
    DetailPrint "Starting the API service..."
    nsExec::ExecToLog '"$INSTDIR\runtime\walaa-service.exe" start'
    Pop $0
  ${EndIf}

  demo_no_service:
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Stop and deregister before the files go. The data directory under
  ; %PROGRAMDATA%\Walaa is deliberately left behind — see `uninstall` in
  ; packaging/service-host/src/main.rs.
  ;
  ; A demo registered nothing, so there is nothing to deregister -- its backend is a
  ; child of the app and went with the window.
  IfFileExists "$INSTDIR\runtime\walaa-demo.db" demo_no_unregister 0
  IfFileExists "$INSTDIR\runtime\walaa-service.exe" 0 +4
    DetailPrint "Removing the API service..."
    nsExec::ExecToLog '"$INSTDIR\runtime\walaa-service.exe" uninstall'
    Pop $0
  demo_no_unregister:
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
!macroend
