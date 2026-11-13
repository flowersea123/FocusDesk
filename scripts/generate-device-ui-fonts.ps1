[CmdletBinding()]
param(
    [string]$CompilerPath = 'C:\Program Files\mingw64\bin\gcc.exe',
    [string]$GfxDirectory
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$toolRoot = Join-Path $projectRoot '.cache\device-ui-font-tools'
$freeTypeRoot = Join-Path $projectRoot '.cache\source-font-tools\freetype-2.13.3'
if (-not $GfxDirectory) {
    $GfxDirectory = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Arduino\libraries\Adafruit_GFX_Library'
}
$fontFile = Join-Path $projectRoot 'frontend\public\fonts\Nunito.ttf'
$licenseFile = Join-Path $projectRoot 'frontend\public\fonts\Nunito-LICENSE.txt'
$converterSource = Join-Path $GfxDirectory 'fontconvert\fontconvert.c'
$fontHash = 'bb55a5ca5c2042335b3991af27c4d0705d0ef41cac6164ac737fd8f2a1e85207'
$licenseHash = '580df76c95a1ec5ab878ceb25bb3d85c6a076804e9c970c8c6972aea775fdf65'
$converterHash = 'b73dacc8694731a9b33c439fbbfb426ad6b383b3d3a8974df756d5dff016cd11'
foreach ($inputFile in @(@($fontFile, $fontHash), @($licenseFile, $licenseHash), @($converterSource, $converterHash))) {
    if ((Get-FileHash -LiteralPath $inputFile[0] -Algorithm SHA256).Hash.ToLowerInvariant() -ne $inputFile[1]) {
        throw "Font build input hash mismatch: $($inputFile[0])"
    }
}
if (-not (Test-Path -LiteralPath (Join-Path $freeTypeRoot 'include\ft2build.h'))) {
    throw 'Prepare the existing Source Sans font tooling cache first.'
}
New-Item -ItemType Directory -Path $toolRoot -Force | Out-Null
Copy-Item -LiteralPath $fontFile -Destination (Join-Path $toolRoot 'Nunito.ttf') -Force
$source = Get-Content -LiteralPath $converterSource -Raw
$source = $source.Replace('#include FT_TRUETYPE_DRIVER_H', "#include FT_TRUETYPE_DRIVER_H`n#include FT_MULTIPLE_MASTERS_H")
$source = $source.Replace('#include "../gfxfont.h"', '#include "gfxfont.h"')
$source = $source.Replace('else if (argc == 5)', 'else if (argc >= 5)')
$pixelSetup = @'
  FT_Fixed weight = (FT_Fixed)((argc > 5 ? atoi(argv[5]) : 400) * 65536L);
  if (FT_Set_Var_Design_Coordinates(face, 1, &weight) || FT_Set_Pixel_Sizes(face, 0, size)) {
    fprintf(stderr, "Variable weight or pixel size setup failed\n");
    return 1;
  }
'@
if (-not $source.Contains('FT_Set_Char_Size(face, size << 6, 0, DPI, 0);')) { throw 'Unexpected converter source.' }
$source = $source.Replace('  FT_Set_Char_Size(face, size << 6, 0, DPI, 0);', $pixelSetup)
$localSource = Join-Path $toolRoot 'nunito-fontconvert.c'
[System.IO.File]::WriteAllText($localSource, $source, [System.Text.UTF8Encoding]::new($false))
$components = @(
    'base/ftsystem.c', 'base/ftinit.c', 'base/ftdebug.c', 'base/ftbase.c',
    'base/ftbbox.c', 'base/ftglyph.c', 'base/ftbitmap.c', 'base/ftmm.c',
    'autofit/autofit.c', 'truetype/truetype.c', 'sfnt/sfnt.c',
    'psnames/psnames.c', 'raster/raster.c', 'smooth/smooth.c', 'gzip/ftgzip.c', 'lzw/ftlzw.c'
)
$componentSources = @($components | ForEach-Object { Join-Path $freeTypeRoot ('src\' + $_) })
$converter = Join-Path $toolRoot 'nunito-fontconvert.exe'
& $CompilerPath -std=c99 -O2 -DFT2_BUILD_LIBRARY -I (Join-Path $freeTypeRoot 'include') -I $GfxDirectory $localSource @componentSources -o $converter -lm *> (Join-Path $toolRoot 'compile.log')
if ($LASTEXITCODE -ne 0) { throw 'Nunito converter compilation failed. See .cache/device-ui-font-tools/compile.log.' }
$profiles = @(
    @{ Name = 'NunitoRegular10px'; Size = 10; Weight = 400 },
    @{ Name = 'NunitoBold10px'; Size = 10; Weight = 750 },
    @{ Name = 'NunitoRegular11px'; Size = 11; Weight = 400 },
    @{ Name = 'NunitoBold11px'; Size = 11; Weight = 750 },
    @{ Name = 'NunitoRegular13px'; Size = 13; Weight = 400 },
    @{ Name = 'NunitoRegular16px'; Size = 16; Weight = 400 },
    @{ Name = 'NunitoBold16px'; Size = 16; Weight = 750 },
    @{ Name = 'NunitoBold17px'; Size = 17; Weight = 700 }
)
$destination = Join-Path $projectRoot 'firmware\focusdesk_device\fonts'
$artifacts = @()
Push-Location $toolRoot
try {
    foreach ($profile in $profiles) {
        $stderrFile = Join-Path $toolRoot ($profile.Name + '.stderr.txt')
        $converted = & $converter 'Nunito.ttf' $profile.Size 32 126 $profile.Weight 2> $stderrFile
        if ($LASTEXITCODE -ne 0 -or (Get-Item -LiteralPath $stderrFile).Length -gt 0) { throw "Font conversion failed: $($profile.Name)" }
        $body = ($converted -join "`n") + "`n"
        $body = $body.Replace(('Nunito' + $profile.Size + 'pt7b'), $profile.Name)
        if ([regex]::Matches($body, '(?m)^\s*\{\s*\d+,\s*\d+,\s*\d+,\s*\d+,\s*-?\d+,\s*-?\d+\s*\}').Count -ne 95) {
            throw 'Expected 95 printable ASCII glyphs.'
        }
        $notice = @"
// SPDX-License-Identifier: OFL-1.1
// Nunito Version 3.602, Google Fonts commit 8c6a9bb9732545b9ed53f29ec5e1ab0ff53c4e6f.
// Original copyright and Reserved Font Names are in Nunito-LICENSE.txt.
// Generated with FreeType 2.13.3, monochrome, interpreter 35, pixel size $($profile.Size), wght $($profile.Weight).
// TTF SHA-256 $fontHash.
#pragma once
#include <Arduino.h>
#include <gfxfont.h>

"@
        $filename = Join-Path $destination ($profile.Name + '.h')
        [System.IO.File]::WriteAllText($filename, $notice + $body, [System.Text.UTF8Encoding]::new($false))
        $artifacts += @{ name = $profile.Name; pixels = $profile.Size; weight = $profile.Weight; sha256 = (Get-FileHash -LiteralPath $filename -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
} finally { Pop-Location }
Copy-Item -LiteralPath $licenseFile -Destination (Join-Path $destination 'Nunito-LICENSE.txt') -Force
@{ family = 'Nunito'; version = '3.602'; fontSha256 = $fontHash; licenseSha256 = $licenseHash; sourceConverterSha256 = $converterHash; pixelSizing = $true; artifacts = $artifacts } |
    ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $toolRoot 'manifest.json') -Encoding utf8
Write-Output 'Generated 8 Nunito fonts with explicit pixel sizes and variable weights.'
