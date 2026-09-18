# Install Android SDK packages WITHOUT sdkmanager (direct download from dl.google.com)
#
# Why: the new cmdline-tools (23.0.0) deprecated sdkmanager and its compatibility
# shim does not accept the classic "platforms;android-36" package spec, so we fetch
# the official zips directly (links taken from the official repository2-3.xml) and
# place them into the SDK layout ourselves.
#
# Usage (no JAVA_HOME needed, pure download + unzip):
#   powershell -ExecutionPolicy Bypass -File scripts\android\install_sdk_packages.ps1
#
# NOTE: keep this file ASCII-only (Windows PowerShell 5.1 reads .ps1 as ANSI).

$ErrorActionPreference = "Stop"

$SdkRoot = "D:\Android\Sdk"
$Work = Join-Path $env:TEMP ("android_pkgs_" + (Get-Date -Format "yyyyMMddHHmmss"))
New-Item -ItemType Directory -Force -Path $Work | Out-Null

function Fetch-And-Place {
    param(
        [string]$Label,
        [string]$Url,
        [string]$MarkerFile,
        [string]$DestDir
    )

    $zip = Join-Path $Work ((Split-Path $Url -Leaf))
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

# Android 36 platform (contains android.jar)
Fetch-And-Place -Label "platforms;android-36" `
    -Url "https://dl.google.com/android/repository/platform-36_r02.zip" `
    -MarkerFile "android.jar" `
    -DestDir (Join-Path $SdkRoot "platforms\android-36")

# Build tools 36.0.0 (contains aapt2.exe)
Fetch-And-Place -Label "build-tools;36.0.0" `
    -Url "https://dl.google.com/android/repository/build-tools_r36_windows.zip" `
    -MarkerFile "aapt2.exe" `
    -DestDir (Join-Path $SdkRoot "build-tools\36.0.0")

Write-Host ""
Write-Host "=== verify ==="
foreach ($p in @(
    (Join-Path $SdkRoot "platforms\android-36\android.jar"),
    (Join-Path $SdkRoot "build-tools\36.0.0\aapt2.exe"),
    (Join-Path $SdkRoot "platform-tools\adb.exe"),
    (Join-Path $SdkRoot "cmdline-tools\latest\bin\sdkmanager.bat")
)) {
    if (Test-Path $p) { Write-Host "  OK   $p" } else { Write-Host "  MISS $p" }
}

Write-Host ""
Write-Host "done. you can delete this temp folder: $Work"
