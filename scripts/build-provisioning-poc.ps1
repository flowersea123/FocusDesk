[CmdletBinding()]
param(
    [string]$Fqbn = 'esp32:esp32:esp32s3',
    [string]$ArduinoCli,
    [string]$SketchDirectory,
    [string]$ToolchainRoot,
    [string]$ReuseBuildDirectory,
    [int]$Jobs = 4
)

# Compile only. This script never opens a serial port or uploads firmware.
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$arduinoData = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Arduino15'
$corePath = Join-Path $arduinoData 'packages\esp32\hardware\esp32\3.3.12'
if (-not (Test-Path -LiteralPath (Join-Path $corePath 'platform.txt'))) {
    throw 'Arduino-ESP32 Core 3.3.12 is required. No dependencies will be installed automatically.'
}
if ((Get-Content -LiteralPath (Join-Path $corePath 'platform.txt') -Raw) -notmatch '(?m)^version=3\.3\.12\s*$') {
    throw 'The selected Core files do not identify as version 3.3.12.'
}
if (-not $ArduinoCli) {
    $ArduinoCli = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe'
}
if (-not (Test-Path -LiteralPath $ArduinoCli -PathType Leaf)) { throw "Arduino CLI was not found: $ArduinoCli" }
if (-not $SketchDirectory) {
    $SketchDirectory = Join-Path $projectRoot 'firmware\experiments\focusdesk_provisioning_poc'
}
$SketchDirectory = (Resolve-Path -LiteralPath $SketchDirectory).Path
$sketchName = Split-Path $SketchDirectory -Leaf
$buildFamily = if ($sketchName -eq 'focusdesk_device') { 'device' } else { 'p1' }
if (-not (Test-Path -LiteralPath (Join-Path $SketchDirectory ($sketchName + '.ino')))) {
    throw 'The sketch directory must contain a matching .ino file.'
}
if ($Fqbn -notmatch '^esp32:esp32:esp32s3(:|$)') { throw 'Use the ESP32S3 Dev Module FQBN and explicit board options for this PoC.' }
if ($Jobs -lt 1 -or $Jobs -gt 16) { throw 'Jobs must be between 1 and 16.' }
if (-not $ToolchainRoot) {
    $cachedTools = Join-Path $projectRoot '.cache\arduino-data\packages\esp32\tools'
    if (Test-Path -LiteralPath (Join-Path $cachedTools 'esp32s3-libs\3.3.12\sdkconfig')) {
        $ToolchainRoot = $cachedTools
    } else {
        $ToolchainRoot = Join-Path $arduinoData 'packages\esp32\tools'
    }
}
$ToolchainRoot = (Resolve-Path -LiteralPath $ToolchainRoot).Path
$compilerPath = Join-Path $ToolchainRoot 'esp-x32\2601\bin'
$sdkPath = Join-Path $ToolchainRoot 'esp32s3-libs\3.3.12'
if (-not (Test-Path -LiteralPath (Join-Path $compilerPath 'xtensa-esp32s3-elf-g++.exe'))) { throw 'The installed ESP32 2601 compiler was not found.' }
if (-not (Test-Path -LiteralPath (Join-Path $sdkPath 'sdkconfig'))) { throw 'The ESP32-S3 3.3.12 SDK was not found.' }

$buildId = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$runDirectory = Join-Path $projectRoot ('.cache\' + $buildFamily + '-builds\' + $buildId)
$buildDirectory = Join-Path $runDirectory 'build'
if ($ReuseBuildDirectory) {
    $resolvedBuild = (Resolve-Path -LiteralPath $ReuseBuildDirectory).Path
    $allowedBuildRoots = @(
        (Join-Path $projectRoot '.cache\p1-builds\'),
        (Join-Path $projectRoot '.cache\device-builds\')
    )
    $withinBuildRoot = $false
    foreach ($allowedRoot in $allowedBuildRoots) {
        if ($resolvedBuild.StartsWith($allowedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            $withinBuildRoot = $true
        }
    }
    if (-not $withinBuildRoot -or
        (Split-Path $resolvedBuild -Leaf) -ne 'build' -or
        -not (Test-Path -LiteralPath (Join-Path $resolvedBuild 'build.options.json'))) {
        throw 'Only an existing build directory created by this PoC script can be reused.'
    }
    $buildDirectory = $resolvedBuild
}
New-Item -ItemType Directory -Path $runDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $buildDirectory -Force | Out-Null
$logPath = Join-Path $runDirectory 'compile.log'
$configPath = Join-Path $projectRoot '.cache\arduino-cli.yaml'
if (-not (Test-Path -LiteralPath $configPath)) { throw 'Expected the existing local .cache/arduino-cli.yaml configuration.' }

# Include project-local dependencies of wrapper sketches in the source freeze.
# The integrated sketch reuses the provisioning module and the original renderer.
$localSources = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
$projectPrefix = $projectRoot + [System.IO.Path]::DirectorySeparatorChar
function Register-LocalSource([string]$sourcePath) {
    $absoluteSource = [System.IO.Path]::GetFullPath($sourcePath)
    if (-not $absoluteSource.StartsWith($projectPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not (Test-Path -LiteralPath $absoluteSource -PathType Leaf) -or
        -not $localSources.Add($absoluteSource)) {
        return
    }
    $sourceText = Get-Content -LiteralPath $absoluteSource -Raw
    $includes = [regex]::Matches($sourceText, '(?m)^\s*#\s*include\s*"([^"\r\n]+)"')
    foreach ($include in $includes) {
        $includePath = Join-Path (Split-Path $absoluteSource -Parent) $include.Groups[1].Value
        if (-not (Test-Path -LiteralPath $includePath -PathType Leaf)) {
            $includePath = Join-Path $SketchDirectory $include.Groups[1].Value
        }
        Register-LocalSource $includePath
    }
}
$sketchSources = Get-ChildItem -LiteralPath $SketchDirectory -File -Recurse |
    Where-Object Extension -In @('.ino', '.h', '.hpp', '.cpp', '.c')
foreach ($file in $sketchSources) { Register-LocalSource $file.FullName }
$sourceFiles = @($localSources | Sort-Object | ForEach-Object { Get-Item -LiteralPath $_ })
$sourceHashes = @{}
foreach ($file in $sourceFiles) { $sourceHashes[$file.FullName] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
$cliArguments = @('compile', '--no-color', '--verbose', '--config-file', $configPath,
    '--fqbn', $Fqbn, '--build-path', $buildDirectory, '--jobs', $Jobs.ToString(),
    '--build-property', ('compiler.path=' + $compilerPath + '\'),
    '--build-property', ('compiler.sdk.path=' + $sdkPath),
    '--build-property', 'build.code_debug=0', $SketchDirectory)

Write-Host "Compiling only: $SketchDirectory"
Write-Host "FQBN: $Fqbn (a build profile, not a hardware identification result)"
Write-Host "Log: $logPath"
$propertiesLog = Join-Path $runDirectory 'build-properties.txt'
$propertiesArguments = @('compile', '--no-color', '--show-properties=expanded', '--config-file', $configPath,
    '--fqbn', $Fqbn, '--build-path', $buildDirectory,
    '--build-property', ('compiler.path=' + $compilerPath + '\'),
    '--build-property', ('compiler.sdk.path=' + $sdkPath),
    '--build-property', 'build.code_debug=0', $SketchDirectory)
& $ArduinoCli @propertiesArguments *> $propertiesLog
if ($LASTEXITCODE -ne 0) { throw "Cannot resolve the selected build profile. See $propertiesLog" }
$platformMatch = [regex]::Match((Get-Content -LiteralPath $propertiesLog -Raw), '(?m)^runtime\.platform\.path=(.+)\r?$')
if (-not $platformMatch.Success -or -not [string]::Equals(
    [System.IO.Path]::GetFullPath($platformMatch.Groups[1].Value.Trim()), $corePath,
    [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Arduino CLI did not select the required Core 3.3.12. The build was not started.'
}
$startTime = Get-Date
& $ArduinoCli @cliArguments *> $logPath
$compileExit = $LASTEXITCODE
$logText = Get-Content -LiteralPath $logPath -Raw
if ($compileExit -ne 0) {
    Get-Content -LiteralPath $logPath -Tail 60 | Where-Object { $_.Length -lt 700 } | Select-Object -Last 25 | Write-Host
    throw "Arduino compilation failed with exit code $compileExit. Full log: $logPath"
}
foreach ($file in $sourceFiles) {
    if ((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sourceHashes[$file.FullName]) {
        throw 'Source changed during compilation. Run a new build before reporting the result.'
    }
}
$applicationBinary = Join-Path $buildDirectory ($sketchName + '.ino.bin')
$elfPath = Join-Path $buildDirectory ($sketchName + '.ino.elf')
if (-not (Test-Path -LiteralPath $applicationBinary) -or -not (Test-Path -LiteralPath $elfPath)) {
    throw 'CLI returned success without both an application .bin and .elf. Do not report this as a complete build.'
}
$flashMatch = [regex]::Match($logText, 'Sketch uses\s+([\d,]+)\s+bytes.*Maximum is\s+([\d,]+)\s+bytes')
$ramMatch = [regex]::Match($logText, 'Global variables use\s+([\d,]+)\s+bytes.*leaving\s+([\d,]+)\s+bytes.*Maximum is\s+([\d,]+)\s+bytes')
$summary = [ordered]@{
    core = '3.3.12'
    fqbn = $Fqbn
    hardwareSettingsConfirmed = $false
    debugLevel = 0
    sketch = $SketchDirectory
    sourceSha256 = $sourceHashes
    compileSeconds = [math]::Round(((Get-Date) - $startTime).TotalSeconds, 2)
    compilerDirectory = $compilerPath
    sdkDirectory = $sdkPath
    sdkVersions = Get-Content -LiteralPath (Join-Path $sdkPath 'versions.txt')
    applicationBinary = $applicationBinary
    applicationBinaryBytes = (Get-Item -LiteralPath $applicationBinary).Length
    applicationBinarySha256 = (Get-FileHash -LiteralPath $applicationBinary -Algorithm SHA256).Hash.ToLowerInvariant()
    elf = $elfPath
    log = $logPath
    flashUsedBytes = $null
    flashCapacityBytes = $null
    staticRamUsedBytes = $null
    staticRamCapacityBytes = $null
    runtimeHeapMeasured = $false
    uploaded = $false
}
if ($flashMatch.Success) {
    $summary.flashUsedBytes = [long]$flashMatch.Groups[1].Value.Replace(',', '')
    $summary.flashCapacityBytes = [long]$flashMatch.Groups[2].Value.Replace(',', '')
}
if ($ramMatch.Success) {
    $summary.staticRamUsedBytes = [long]$ramMatch.Groups[1].Value.Replace(',', '')
    $summary.staticRamCapacityBytes = [long]$ramMatch.Groups[3].Value.Replace(',', '')
}
$manifestPath = Join-Path $runDirectory 'build-manifest.json'
$summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding utf8
@{ manifest = $manifestPath } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $projectRoot ('.cache\' + $buildFamily + '-latest-build.json')) -Encoding utf8
Get-Content -LiteralPath $logPath | Select-String 'Sketch uses|Global variables use' | ForEach-Object { Write-Host $_.Line }
Write-Host "Manifest: $manifestPath"
Write-Host 'Complete compile/link only. Runtime heap and hardware behavior require the separate manual board test.'
