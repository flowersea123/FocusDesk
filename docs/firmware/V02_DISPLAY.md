# V0.2 shared Display Snapshot firmware

Unified entry is `firmware/focusdesk_device/focusdesk_device.ino`. The device fetches `/api/v1/display-snapshot` from its saved Hub origin. This requires the V0.2 Hub. The existing `/api/v1/daily-overview` endpoint and legacy live/static examples remain available.

The authoritative layout lives in `contracts/display-snapshot.ts`. The device executes its filled rectangles, bitmap text and filled/outlined diamonds. Font indexes map to the installed Adafruit GFX FreeSans9pt7b, FreeSansBold9pt7b and FreeSansBold18pt7b fonts. Browser font data is generated from those same headers. The panel driver, 30,000-byte framebuffer, GPIO mapping and refresh waveforms retain their existing implementation.

## Validation and lifecycle

- Require `display-1`, `goal-1`, 400×300 and a printable revision up to 80 bytes.
- Validate the complete JSON scene before replacing the accepted snapshot or drawing.
- Keep the existing 4096-byte wire limit, strict JSON/UTF-8 syntax, nesting limit 12 and ArduinoJson allocation budget of 32 KiB.
- Limit scenes to 64 commands, each text command to 96 ASCII characters and total scene text to 1024 bytes.
- Validate integer arguments, glyph ink bounds and cursor advances, palette indexes and diamond/rectangle bounds.
- Use bounded vectors for command storage to keep scene objects off the Arduino loop stack. Move accepted scenes into the synchronizer.
- Preserve source-origin/revision deduplication, configuration cancellation, 30-second polling, 60-second physical refresh protection, failure backoff and last-valid-content handling.
- Keep the existing provisioning response JSON token budget of 128. The Display Snapshot path alone permits 768 tokens for its drawing-command arrays. Body/header/time limits retain their existing values.
- Leave provisioning, NVS transaction format and candidate Wi-Fi/Hub proof logic in their existing modules.

An older Hub returns an error for the new endpoint. The device retains its accepted content and retries. Update Hub and firmware together for this UI. No automatic discovery, pairing or additional Wi-Fi mechanism is introduced.

## Host checks

Compile and run from the project root using the installed MinGW compiler and Adafruit GFX headers.

```powershell
$compiler = 'C:\Program Files\mingw64\bin\g++.exe'
$gfx = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Arduino\libraries\Adafruit_GFX_Library'
& $compiler -std=c++17 -Wall -Wextra -Werror -I tests/firmware/live_fakes -I $gfx tests/firmware/v02_snapshot_test.cpp firmware/focusdesk_live/gdem042f52_display.cpp -o .cache/v02-snapshot.exe
if ($LASTEXITCODE -ne 0) { throw 'Snapshot host compilation failed' }
& .cache/v02-snapshot.exe
if ($LASTEXITCODE -ne 0) { throw 'Snapshot host checks failed' }
```

The test binary also accepts an input scene JSON path and output raw-pixel path. It renders through the actual panel driver with simulated SPI, captures its packed frame and writes exactly 120,000 one-byte color indexes. Compare these bytes with `rasterizeDisplaySnapshot` output for pixel parity. This verifies software rasterization and layout bounds. Physical pigment color, panel timing and actual screen delivery require user observation.

Recorded host results on 2026-11-11 include 113 new snapshot/parser/raster checks, all 790 P2 C++ assertions, 107 original P3 synchronization checks, 32 portal tests and the transport regression expanded from 34 to 46 C++ assertions. The added transport cases exercise the new endpoint after the setup window closes, its dedicated larger token budget, retention of the old endpoint budget, queued-configuration cancellation and query-path rejection. Original live parser/state/renderer/focus, configured/unconfigured sketch and static-display suites also compile and pass. Shared-scene pixel comparisons, target compilation and physical acceptance are recorded by the Tech Lead in the V0.2 delivery report.

`JsonBudget` is created before `JsonDocument`, so document destruction frees its allocations before the allocator leaves scope on every return path. Command vectors and strings use RAII. Rejected candidates are destroyed and accepted scenes move into the synchronizer. This inspection found no accumulating container or retained per-poll allocation. The JSON budget covers ArduinoJson allocations, while the separately bounded command vectors and strings add heap use. The previously accepted scene and candidate coexist during validation. Physical minimum heap and largest-block measurements are still required during H7.

## Target and physical verification

The 2026-11-11 full Core 3.3.12 build and link succeeded. Flash uses 972081 of 1310720 bytes and static RAM uses 83004 of 327680 bytes. All 18 project source hashes and BIN/ELF/MAP integrity checks pass. The target log contains zero warning/error lines under the existing default warning configuration. Artifacts are in `.cache/device-builds/v02-cache-seed/build`, with the manifest in `.cache/device-builds/20261111-161846-fad01f4a/build-manifest.json`. Full hashes and software/browser results are in `docs/V02_DELIVERY.md`.

Keep Arduino-ESP32 Core 3.3.12 and the previously validated ESP32S3 Dev Module options. Freeze sources after Hub and preview tests, then run the existing build script.

```powershell
.\scripts\build-provisioning-poc.ps1 -SketchDirectory firmware/focusdesk_device
```

This command compiles and links. Upload and serial monitoring remain manual. Inspect normal/empty/long goals, all signal priorities, active Focus Mode and return to overview. Verify saved configuration after reboot, changes after the provisioning window closes, failure recovery, and heap measurements around physical refresh. V0.2 has no physical acceptance yet. Historical M2 H1–H6 results apply to that earlier firmware. H7 remains deferred.
