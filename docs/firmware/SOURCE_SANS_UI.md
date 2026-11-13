# Source Sans 3 display font resources

2026-11-11. The unified renderer supports the following Source Sans 3 bitmap resources alongside its existing font table.

| Index | GFX font |
| --- | --- |
| 5 | SourceSans3Regular9pt7b |
| 6 | SourceSans3Bold9pt7b |
| 7 | SourceSans3Bold18pt7b |
| 8 | SourceSans3Regular12pt7b |
| 9 | SourceSans3Bold12pt7b |

The Hub selects the Source Sans 3 indexes for the active UI. Each text command explicitly sets its font before drawing. The parser requires an integer index in the supported range and validates glyph ink bounds and cursor advances against the 400×300 frame before accepting the complete scene.

Indexes 0–4 continue to reference their existing FreeSans glyphs for previously generated scenes. Source Sans 3 glyph headers live under `firmware/focusdesk_device/fonts/` and use quoted includes so the build script records their hashes with the project source freeze. Font provenance and the native conversion process are recorded in `docs/firmware/SOURCE_SANS_FONT_BUILD.md`.

Update the Hub and unified device firmware together to use the Source Sans 3 indexes. Device upload, serial monitoring and physical display acceptance remain user-operated.

## Host verification

Compile from the project root after generating the font headers.

```powershell
$compiler = 'C:\Program Files\mingw64\bin\g++.exe'
$gfx = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Arduino\libraries\Adafruit_GFX_Library'
& $compiler -std=c++17 -Wall -Wextra -Werror -I tests/firmware/live_fakes -I $gfx tests/firmware/v02_snapshot_test.cpp firmware/focusdesk_live/gdem042f52_display.cpp -o .cache/source-snapshot.exe
& .cache/source-snapshot.exe
```

The test retains the existing 138 parser and FreeSans checks, using unknown font index 10 for the extended range. It checks the five Source Sans 3 mappings, accepts a scene containing every Source Sans face, compares the actual driver frame against independent glyph bitmap rasterization for all 120000 pixels, and exercises top/bottom/right bounds and non-integer font rejection.

The fresh host compilation passes `-Wall -Wextra -Werror`, and all 190 checks pass. This includes the original 138 and 52 Source Sans 3 checks. The log is `.cache/source-firmware-host.log`, and the executable is `.cache/source-snapshot.exe`.

The renderer executable accepts `scene.json pixels.raw` for the shared TypeScript raster comparison. Complete Core 3.3.12 compile/link and physical acceptance are recorded by the Tech Lead.
