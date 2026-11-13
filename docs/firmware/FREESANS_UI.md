# FreeSans display fonts

2026-11-11. The unified device renderer now supports these bitmap font indexes.

| Index | GFX font |
| --- | --- |
| 0 | FreeSans9pt7b |
| 1 | FreeSansBold9pt7b |
| 2 | FreeSansBold18pt7b |
| 3 | FreeSans12pt7b |
| 4 | FreeSansBold12pt7b |

Each accepted text command explicitly selects one of these FreeSans faces before drawing. The parser validates the integer font index and checks each glyph's ink bounds and cursor advance against the 400×300 screen. Unsupported indexes cause the complete candidate scene to be rejected while preserving the last accepted scene.

The Hub and browser preview use the same font indexes and glyph bytes. Deploy the updated Hub and unified firmware together to use the two 12pt resources. Board upload and physical acceptance remain user-operated.

## Host verification

```powershell
$compiler = 'C:\Program Files\mingw64\bin\g++.exe'
$gfx = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Arduino\libraries\Adafruit_GFX_Library'
& $compiler -std=c++17 -Wall -Wextra -Werror -I tests/firmware/live_fakes -I $gfx tests/firmware/v02_snapshot_test.cpp firmware/focusdesk_live/gdem042f52_display.cpp -o .cache/font-snapshot.exe
& .cache/font-snapshot.exe
```

The existing 113 validation checks continue with unknown font index 5 as the rejection case. Additional checks cover all five font mappings, valid regular/bold 12pt text, glyph boundary rejection, and all 120,000 pixels rendered through the actual panel framebuffer with simulated SPI.

The fresh host build passes all 138 checks, comprising the original 113 and 25 font checks. Compilation uses `-Wall -Wextra -Werror`. The result is recorded in `.cache/font-firmware-host.log`.

The executable accepts `scene.json pixels.raw` for the Tech Lead's shared-browser/native-renderer pixel comparisons. Full Core3.3.12 compile/link and physical screen results are recorded in the main font delivery report.
