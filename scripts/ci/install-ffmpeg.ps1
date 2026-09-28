# Installs the same pinned FFmpeg build the app downloads, for the render tests
# on CI. Verifies the SHA-256 before extracting and adds it to PATH.
$ErrorActionPreference = 'Stop'

$url = 'https://github.com/GyanD/codexffmpeg/releases/download/8.1.1/ffmpeg-8.1.1-essentials_build.zip'
$sha = '6f58ce889f59c311410f7d2b18895b33c03456463486f3b1ebc93d97a0f54541'
$dir = Join-Path $env:RUNNER_TEMP 'ffmpeg'
$zip = Join-Path $env:RUNNER_TEMP 'ffmpeg.zip'

Invoke-WebRequest -Uri $url -OutFile $zip
$actual = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower()
if ($actual -ne $sha) { throw "FFmpeg checksum mismatch: $actual" }

Expand-Archive -Path $zip -DestinationPath $dir -Force
$bin = Join-Path $dir 'ffmpeg-8.1.1-essentials_build\bin'
Add-Content -Path $env:GITHUB_PATH -Value $bin
& (Join-Path $bin 'ffmpeg.exe') -hide_banner -version | Select-Object -First 1
