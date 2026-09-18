# Install Android SDK packages WITHOUT sdkmanager (direct download from dl.google.com)
#
# Why: the new cmdline-tools (23.0.0) deprecated sdkmanager and its compatibility
# shim does not accept the classic "platforms;android-36" package spec, so we fetch
# the official zips directly (links taken from the official repository2-3.xml) and
# place them into the SDK layout ourselves.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\android\install_sdk_packages.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\android\install_sdk_packages.ps1 -Packages build-tools-35
#   powershell -ExecutionPolicy Bypass -File scripts\android\install_sdk_packages.ps1 -Packages platform-36,build-tools-35
#
# Available package names: platform-36 | build-tools-35 | build-tools-36
# Default (no -Packages): all three.
#
# NOTE: keep this file ASCII-only (Windows PowerShell 5.1 reads .ps1 as ANSI).

param(
    [string[]]$Packages = @("platform-36", "build-tools-35", "build-tools-36")
)

$ErrorActionPreference = "Stop"

$SdkRoot = "D:\Android\Sdk"
$BaseUrl = "https://dl.google.com/android/repository/"
$Work = Join-Path $env:TEMP ("android_pkgs_" + (Get-Date -Format "yyyyMMddHHmmss"))
New-Item -ItemType Directory -Force -Path $Work | Out-Null

# name -> url / marker file / destination folder (relative to SDK root)
$Recipes = @{
    "platform-36" = @{
        Label  = "platforms;android-36 (compileSdk 36)"
        Url    = $BaseUrl + "platform-36_r02.zip"
        Marker = "android.jar"
        Dest   = "platforms\android-36"
    }
    "build-tools-35" = @{
        Label  = "build-tools;35.0.0 (what AGP 8.13 + Capacitor expect)"
        Url    = $BaseUrl + "build-tools_r35_windows.zip"
        Marker = "aapt2.exe"
        Dest   = "build-tools\35.0.0"
    }
    "build-tools-36" = @{
        Label  = "build-tools;36.0.0"
        Url    = $BaseUrl + "build-tools_r36_windows.zip"
        Marker = "aapt2.exe"
        Dest   = "build-tools\36.0.0"
    }
}

function Fetch-And-Place {
    param(
        [string]$Label,
        [string]$Url,
        [string]$MarkerFile,
        [string]$DestDir
    )

    $zip = Join-Path $Work (Split-Path $Url -Leaf)
    Write-Host ""
    Write-Host "=== $Label ==="
    Write-Host "  downloading: $Url"
    & curl.exe -L --fail --silent --show-error -o $zip $Url
    if ($LASTEXITCODE -ne 0) { throw "download failed: $Url" }

    $extract = Join-Path $Work ([System.IO.Path]::GetFileNameWithoutExtension($zip))
    if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
    Write-Host "  extracting..."
    Expand-Archive -Path $zip -DestinationPath $extract -Force

    # find the folder which actually contains the marker file
    $marker = Get-ChildItem -Path $extract -Recurse -Filter $MarkerFile -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $marker) { throw "marker file '$MarkerFile' not found inside $zip" }
    $srcDir = $marker.Directory.FullName
    Write-Host "  found payload: $srcDir"

    $parent = Split-Path $DestDir -Parent
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    if (Test-Path $DestDir) { Remove-Item $DestDir -Recurse -Force }
    Move-Item -Path $srcDir -Destination $DestDir
    Write-Host "  installed -> $DestDir"
}

foreach ($name in $Packages) {
    $recipe = $Recipes[$name]
    if (-not $recipe) {
        throw "unknown package '$name'. available: $($Recipes.Keys -join ', ')"
    }
    Fetch-And-Place -Label $recipe.Label -Url $recipe.Url -MarkerFile $recipe.Marker -DestDir (Join-Path $SdkRoot $recipe.Dest)
}

Write-Host ""
Write-Host "=== verify ==="
foreach ($p in @(
    (Join-Path $SdkRoot "platforms\android-36\android.jar"),
    (Join-Path $SdkRoot "build-tools\35.0.0\aapt2.exe"),
    (Join-Path $SdkRoot "build-tools\36.0.0\aapt2.exe"),
    (Join-Path $SdkRoot "platform-tools\adb.exe"),
    (Join-Path $SdkRoot "cmdline-tools\latest\bin\sdkmanager.bat")
)) {
    if (Test-Path $p) { Write-Host "  OK   $p" } else { Write-Host "  MISS $p" }
}

Write-Host ""
Write-Host "done. you can delete this temp folder: $Work"
