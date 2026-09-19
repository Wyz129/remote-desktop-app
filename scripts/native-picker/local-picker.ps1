$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Send-Result($value) {
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $value -Compress -Depth 4))
  [Console]::Out.Flush()
}

function Get-ExplorerWindows($shell) {
  $result = @()
  foreach ($window in $shell.Windows()) {
    try {
      if ([IO.Path]::GetFileName([string]$window.FullName) -ieq 'explorer.exe') {
        $result += [PSCustomObject]@{ Handle = [string]$window.HWND; Window = $window }
      }
    } catch { }
  }
  return $result
}

try {
  $shell = New-Object -ComObject Shell.Application
  $before = @(Get-ExplorerWindows $shell | ForEach-Object { $_.Handle })
  $startPath = [Environment]::GetFolderPath('UserProfile')
  if (-not (Test-Path -LiteralPath $startPath -PathType Container)) { throw 'The user home directory is unavailable.' }
  # Explore requests a separate system Explorer window. No executable or DLL is generated.
  $shell.Explore($startPath)
  $deadline = [DateTime]::UtcNow.AddSeconds(12)
  $selectedWindow = $null
  $candidateHandle = $null
  $candidateSince = [DateTime]::UtcNow
  while ([DateTime]::UtcNow -lt $deadline) {
    $newWindows = @(Get-ExplorerWindows $shell | Where-Object { $before -notcontains $_.Handle })
    if ($newWindows.Count -gt 1) { throw 'More than one new Explorer window appeared. Close the extra window and try again.' }
    if ($newWindows.Count -eq 1) {
      try {
        $windowPath = [string]$newWindows[0].Window.Document.Folder.Self.Path
        if ($windowPath.TrimEnd('\') -ieq $startPath.TrimEnd('\')) {
          if ($candidateHandle -ne $newWindows[0].Handle) { $candidateHandle = $newWindows[0].Handle; $candidateSince = [DateTime]::UtcNow }
          if (([DateTime]::UtcNow - $candidateSince).TotalMilliseconds -ge 600) { $selectedWindow = $newWindows[0]; break }
        }
      } catch { }
    }
    Start-Sleep -Milliseconds 150
  }
  if ($null -eq $selectedWindow) { throw 'Could not identify a new Explorer window for the user home. Please retry using a separate window.' }
  $capturedHandle = $selectedWindow.Handle
  Send-Result @{ type = 'ready'; handle = $capturedHandle; directory = $startPath }
  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line -or $line -eq 'cancel') { break }
    if ($line -ne 'select' -and $line -ne 'ping') { continue }
    $matches = @(Get-ExplorerWindows $shell | Where-Object { $_.Handle -eq $capturedHandle })
    if ($matches.Count -ne 1) { Send-Result @{ type = 'cancelled'; reason = 'The selected Explorer window was closed.' }; break }
    if ($line -eq 'ping') { continue }
    try {
      # SelectedItems is intentionally read only from the one HWND captured above.
      $selection = $matches[0].Window.Document.SelectedItems()
      if ($selection.Count -eq 0) { Send-Result @{ type = 'selection-error'; error = 'Select one or more files or folders in the Explorer window first.' }; continue }
      if ($selection.Count -gt 1000) { throw 'A maximum of 1000 items may be selected.' }
      $paths = @()
      foreach ($item in $selection) {
        $itemPath = [string]$item.Path
        if (-not $item.IsFileSystem -or -not [IO.Path]::IsPathRooted($itemPath) -or $itemPath.IndexOf([char]0) -ge 0) { throw 'Only real filesystem files and folders may be selected.' }
        if (-not (Test-Path -LiteralPath $itemPath)) { throw 'A selected item is no longer accessible.' }
        $paths += $itemPath
      }
      Send-Result @{ type = 'selected'; handle = $capturedHandle; paths = @($paths | Select-Object -Unique) }
      break
    } catch { Send-Result @{ type = 'selection-error'; error = $_.Exception.Message } }
  }
} catch {
  Send-Result @{ type = 'error'; error = $_.Exception.Message }
  exit 1
}
