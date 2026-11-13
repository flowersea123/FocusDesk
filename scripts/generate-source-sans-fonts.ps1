[CmdletBinding()]
param(
    [string]$CompilerPath = 'C:\Program Files\mingw64\bin\gcc.exe',
    [string]$GfxDirectory
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$toolRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot '.cache\source-font-tools'))
if (-not $toolRoot.StartsWith($projectRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Font tool cache must remain within the project.'
}
if (-not $GfxDirectory) {
    $GfxDirectory = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Arduino\libraries\Adafruit_GFX_Library'
}
$GfxDirectory = (Resolve-Path -LiteralPath $GfxDirectory).Path
if (-not (Test-Path -LiteralPath $CompilerPath -PathType Leaf)) { throw 'A local MinGW GCC compiler is required.' }
$fontconvertSource = Join-Path $GfxDirectory 'fontconvert\fontconvert.c'
$gfxHeader = Join-Path $GfxDirectory 'gfxfont.h'
$fontconvertHash = 'b73dacc8694731a9b33c439fbbfb426ad6b383b3d3a8974df756d5dff016cd11'
$gfxHeaderHash = '4e1b06371217d63102bac242d4a3ec8dcaff93cd34b4241bbc39eda521a1be11'
function Assert-Hash([string]$Filename, [string]$Expected) {
    if ((Get-FileHash -LiteralPath $Filename -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Expected) {
        throw "Pinned font build input hash mismatch: $Filename"
    }
}
Assert-Hash $fontconvertSource $fontconvertHash
Assert-Hash $gfxHeader $gfxHeaderHash
New-Item -ItemType Directory -Path $toolRoot -Force | Out-Null
function Get-PinnedFile([string]$Filename, [string]$Uri, [string]$Expected) {
    if (-not (Test-Path -LiteralPath $Filename -PathType Leaf)) {
        Invoke-WebRequest -Uri $Uri -OutFile $Filename
    }
    Assert-Hash $Filename $Expected
}

$fontCommit = '87b37a2daaed80fcb8e8ccb0085c4d72ddade12e'
$fontOrigin = 'https://raw.githubusercontent.com/adobe-fonts/source-sans/' + $fontCommit
$regularHash = '4644c81b86ec9caaa76b634889968ed3c4f4f52f054855933acc7c2b21e53b0f'
$boldHash = '9214b9d95e4231c609802815c2646c98174e2102d0d37f88978a7f8e71006e6a'
$licenseHash = '56af9b9c6715597e458284a474dc118a50a4150e9d547c70f7b4a33c3e6a9328'
$archiveHash = '0550350666d427c74daeb85d5ac7bb353acba5f76956395995311a9c6f063289'
$regularFile = Join-Path $toolRoot 'SourceSans3Regular.ttf'
$boldFile = Join-Path $toolRoot 'SourceSans3Bold.ttf'
$licenseFile = Join-Path $toolRoot 'SourceSans3-LICENSE.txt'
$archive = Join-Path $toolRoot 'freetype-2.13.3.tar.xz'
Get-PinnedFile $regularFile ($fontOrigin + '/TTF/SourceSans3-Regular.ttf') $regularHash
Get-PinnedFile $boldFile ($fontOrigin + '/TTF/SourceSans3-Bold.ttf') $boldHash
Get-PinnedFile $licenseFile ($fontOrigin + '/LICENSE.md') $licenseHash
Get-PinnedFile $archive 'https://download.savannah.gnu.org/releases/freetype/freetype-2.13.3.tar.xz' $archiveHash

$freeTypeRoot = Join-Path $toolRoot 'freetype-2.13.3'
if (-not (Test-Path -LiteralPath (Join-Path $freeTypeRoot 'include\ft2build.h'))) {
    & tar -xf $archive -C $toolRoot
    if ($LASTEXITCODE -ne 0) { throw 'FreeType source extraction failed.' }
}
# Use FreeType's documented direct-source build with the TrueType components.
$modulesHeader = @'
FT_USE_MODULE( FT_Module_Class, autofit_module_class )
FT_USE_MODULE( FT_Driver_ClassRec, tt_driver_class )
FT_USE_MODULE( FT_Module_Class, psnames_module_class )
FT_USE_MODULE( FT_Module_Class, sfnt_module_class )
FT_USE_MODULE( FT_Renderer_Class, ft_smooth_renderer_class )
FT_USE_MODULE( FT_Renderer_Class, ft_raster1_renderer_class )
'@
[System.IO.File]::WriteAllText((Join-Path $freeTypeRoot 'include\freetype\config\ftmodule.h'), $modulesHeader.Replace("`r`n", "`n") + "`n", [System.Text.UTF8Encoding]::new($false))
$components = @(
    'base/ftsystem.c', 'base/ftinit.c', 'base/ftdebug.c', 'base/ftbase.c',
    'base/ftbbox.c', 'base/ftglyph.c', 'base/ftbitmap.c', 'base/ftmm.c',
    'autofit/autofit.c', 'truetype/truetype.c', 'sfnt/sfnt.c',
    'psnames/psnames.c', 'raster/raster.c', 'smooth/smooth.c',
    'gzip/ftgzip.c', 'lzw/ftlzw.c'
)
$componentSources = @($components | ForEach-Object { Join-Path $freeTypeRoot ('src\' + $_) })
$converter = Join-Path $toolRoot 'fontconvert.exe'
$compilerLog = Join-Path $toolRoot 'compile-fontconvert.log'
& $CompilerPath -std=c99 -O2 -DFT2_BUILD_LIBRARY -I (Join-Path $freeTypeRoot 'include') $fontconvertSource @componentSources -o $converter -lm *> $compilerLog
if ($LASTEXITCODE -ne 0) { throw "Native font converter compilation failed. See $compilerLog" }

$destination = Join-Path $projectRoot 'firmware\focusdesk_device\fonts'
New-Item -ItemType Directory -Path $destination -Force | Out-Null
$profiles = @(
    @{ Name = 'SourceSans3Regular9pt7b'; File = 'SourceSans3Regular.ttf'; Size = 9; Hash = $regularHash },
    @{ Name = 'SourceSans3Bold9pt7b'; File = 'SourceSans3Bold.ttf'; Size = 9; Hash = $boldHash },
    @{ Name = 'SourceSans3Bold18pt7b'; File = 'SourceSans3Bold.ttf'; Size = 18; Hash = $boldHash },
    @{ Name = 'SourceSans3Regular12pt7b'; File = 'SourceSans3Regular.ttf'; Size = 12; Hash = $regularHash },
    @{ Name = 'SourceSans3Bold12pt7b'; File = 'SourceSans3Bold.ttf'; Size = 12; Hash = $boldHash }
)
$artifacts = @()
Push-Location $toolRoot
try {
    foreach ($profile in $profiles) {
        # Basenames keep GFX symbols portable and avoid Windows path characters.
        $stderrFile = Join-Path $toolRoot ($profile.Name + '.stderr.txt')
        $converted = & $converter $profile.File $profile.Size 32 126 2> $stderrFile
        if ($LASTEXITCODE -ne 0 -or (Get-Item -LiteralPath $stderrFile).Length -gt 0) {
            throw "Font conversion failed. See $stderrFile"
        }
        $body = ($converted -join "`n") + "`n"
        if ($body -notmatch ('const GFXfont ' + $profile.Name + '\s+PROGMEM')) {
            throw 'The font converter returned an unexpected symbol.'
        }
        if ([regex]::Matches($body, '(?m)^\s*\{\s*\d+,\s*\d+,\s*\d+,\s*\d+,\s*-?\d+,\s*-?\d+\s*\}').Count -ne 95) {
            throw 'Expected exactly 95 printable ASCII glyphs.'
        }
        $notice = @"
// SPDX-License-Identifier: OFL-1.1
// Source Sans 3 Version 3.052, Copyright 2010-2023 Adobe.
// Reserved Font Name 'Source'. Full official notice and license in SourceSans3-LICENSE.txt.
// Printable ASCII bitmap representation generated by FocusDesk, retaining original glyph designs.
// Source commit $fontCommit, TTF SHA-256 $($profile.Hash).
// Adafruit GFX 1.13.0 fontconvert + FreeType 2.13.3, 141 DPI, monochrome, TrueType interpreter 35.
#pragma once
#include <Arduino.h>
#include <gfxfont.h>

"@
        $filename = Join-Path $destination ($profile.Name + '.h')
        [System.IO.File]::WriteAllText($filename, $notice.Replace("`r`n", "`n") + $body, [System.Text.UTF8Encoding]::new($false))
        $artifacts += @{ name = $profile.Name; size = $profile.Size; sha256 = (Get-FileHash -LiteralPath $filename -Algorithm SHA256).Hash.ToLowerInvariant(); bytes = (Get-Item -LiteralPath $filename).Length }
    }
} finally { Pop-Location }
Copy-Item -LiteralPath $licenseFile -Destination (Join-Path $destination 'SourceSans3-LICENSE.txt') -Force
$manifest = [ordered]@{
    fontVersion = '3.052'; sourceCommit = $fontCommit; freetypeVersion = '2.13.3';
    regularSha256 = $regularHash; boldSha256 = $boldHash; licenseSha256 = $licenseHash;
    freetypeArchiveSha256 = $archiveHash; fontconvertSourceSha256 = $fontconvertHash;
    converterSha256 = (Get-FileHash -LiteralPath $converter -Algorithm SHA256).Hash.ToLowerInvariant();
    dpi = 141; monochrome = $true; first = 32; last = 126; artifacts = $artifacts
}
$manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $toolRoot 'build-manifest.json') -Encoding utf8
Write-Output ('Generated ' + $artifacts.Count + ' Source Sans 3 GFX fonts with 95 glyphs each.')
Write-Output ('Manifest: ' + (Join-Path $toolRoot 'build-manifest.json'))
