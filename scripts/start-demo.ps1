param([string]$CodePath = '')
$ErrorActionPreference = 'Stop'
if (-not $CodePath) { $CodePath = (Get-Command code.cmd -ErrorAction Stop).Source }
$projectPath = Split-Path -Parent $PSScriptRoot
$profilePath = Join-Path $projectPath '.test-data\demo-profile'
$extensionsPath = Join-Path $projectPath '.test-data\demo-extensions'
$userSettingsPath = Join-Path $profilePath 'User'
if (-not (Test-Path -LiteralPath $CodePath)) { throw "VS Code CLI not found: $CodePath" }
New-Item -ItemType Directory -Force -Path $userSettingsPath,$extensionsPath | Out-Null
$settingsPath = Join-Path $userSettingsPath 'settings.json'
if (-not (Test-Path -LiteralPath $settingsPath)) {
  @{
    'remoteDesktopDemo.openOnStartup' = $true
    'workbench.startupEditor' = 'none'
    'window.newWindowDimensions' = 'maximized'
    'telemetry.telemetryLevel' = 'off'
    'extensions.ignoreRecommendations' = $true
    'workbench.colorTheme' = 'Default Dark Modern'
  } | ConvertTo-Json | Set-Content -Encoding utf8 -LiteralPath $settingsPath
}
& $CodePath --new-window --user-data-dir $profilePath --extensions-dir $extensionsPath --extensionDevelopmentPath $projectPath --skip-welcome --skip-release-notes $projectPath
if ($LASTEXITCODE -ne 0) { throw "VS Code exited with code $LASTEXITCODE" }
Write-Output 'Demo development window launched. Command: Remote Desktop: Open'
