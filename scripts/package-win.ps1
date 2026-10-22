# Windows向けElectron出力をPostClip/で始まる単独ZIPへまとめる。
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$package = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [string]$package.version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid package.json version' }
$dist = Join-Path $root 'dist'
$runtime = Join-Path $dist 'PostClip-win32-x64'
$exe = Join-Path $runtime 'PostClip.exe'
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Windows EXE not found. Run npm run build:win first.' }
if (-not (Test-Path -LiteralPath (Join-Path $runtime 'resources\app.asar') -PathType Leaf)) { throw 'app.asar not found.' }
if (-not (Test-Path -LiteralPath (Join-Path $runtime 'LICENSE') -PathType Leaf)) { throw 'Electron LICENSE not found.' }
if (-not (Test-Path -LiteralPath (Join-Path $runtime 'LICENSES.chromium.html') -PathType Leaf)) { throw 'Chromium licenses not found.' }

# WindowsのEXEとソースのバージョンが一致しない古いビルドを拒否する。
$actualVersion = (Get-Item -LiteralPath $exe).VersionInfo.FileVersion
if ($actualVersion -ne $version -and $actualVersion -ne "$version.0") { throw "EXE version mismatch: expected $version, found $actualVersion" }

$stage = Join-Path $dist '_postclip_zip_stage'
$bundle = Join-Path $stage 'PostClip'
$zip = Join-Path $dist ("postclip-win-x64-v{0}.zip" -f $version)
$tempZip = $zip + '.partial.zip'
try {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
    New-Item -ItemType Directory -Path $bundle -Force | Out-Null
    Get-ChildItem -LiteralPath $runtime -Force | Copy-Item -Destination $bundle -Recurse -Force
    Copy-Item -LiteralPath (Join-Path $root 'README.md') -Destination (Join-Path $bundle 'README.md') -Force
    Copy-Item -LiteralPath (Join-Path $root 'LICENSE') -Destination (Join-Path $bundle 'LICENSE-PostClip.txt') -Force
    $imageDir = Join-Path $bundle 'images'
    New-Item -ItemType Directory -Path $imageDir -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $root 'images\ss.jpg') -Destination (Join-Path $imageDir 'ss.jpg') -Force

    if (Test-Path -LiteralPath $tempZip) { Remove-Item -LiteralPath $tempZip -Force }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $tempZip, [System.IO.Compression.CompressionLevel]::Optimal, $false)
    $archive = [System.IO.Compression.ZipFile]::OpenRead($tempZip)
    try {
        $names = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
        foreach ($required in @('PostClip/PostClip.exe', 'PostClip/resources/app.asar', 'PostClip/README.md', 'PostClip/LICENSE', 'PostClip/LICENSE-PostClip.txt', 'PostClip/LICENSES.chromium.html', 'PostClip/images/ss.jpg')) {
            if ($names -cnotcontains $required) { throw "ZIP is missing $required" }
        }
        foreach ($name in $names) {
            if ($name -match '^PostClip/(booth|docs|tests|scripts)/') { throw "Unexpected release file: $name" }
            if ($name -notmatch '^PostClip/') { throw "Unexpected ZIP root: $name" }
        }
    } finally {
        $archive.Dispose()
    }
    if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
    Move-Item -LiteralPath $tempZip -Destination $zip
    Write-Host ("[OK] {0}" -f $zip)
} finally {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
    if (Test-Path -LiteralPath $tempZip) { Remove-Item -LiteralPath $tempZip -Force }
}
