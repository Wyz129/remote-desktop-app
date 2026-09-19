$ErrorActionPreference = 'Stop'
$global:PickerStarted = $false
$global:PickerWindowReads = 0
$global:PickerSelectionPhase = $false
$global:PickerScenario = $env:RDESKTOP_TEST_SCENARIO
$global:PickerTestDirectory = $env:RDESKTOP_TEST_DIRECTORY
$mockDocument = [PSCustomObject]@{ Folder = [PSCustomObject]@{ Self = [PSCustomObject]@{ Path = [Environment]::GetFolderPath('UserProfile') } } }
$mockDocument | Add-Member ScriptMethod SelectedItems {
  if ($global:PickerScenario -eq 'empty') { return ,@() }
  return ,@(
    [PSCustomObject]@{ Path = (Join-Path $global:PickerTestDirectory 'sample.txt'); IsFileSystem = $true },
    [PSCustomObject]@{ Path = (Join-Path $global:PickerTestDirectory 'folder'); IsFileSystem = $true }
  )
}
$unrelatedDocument = [PSCustomObject]@{ Folder = [PSCustomObject]@{ Self = [PSCustomObject]@{ Path = 'C:\unrelated' } } }
$unrelatedDocument | Add-Member ScriptMethod SelectedItems { throw 'TEST FAILURE: unrelated window selection was inspected' }
$global:PickerOldWindow = [PSCustomObject]@{ FullName = 'C:\Windows\explorer.exe'; HWND = 11; Document = $unrelatedDocument }
$global:PickerNewWindow = [PSCustomObject]@{ FullName = 'C:\Windows\explorer.exe'; HWND = 22; Document = $mockDocument }
$global:PickerExtraWindow = [PSCustomObject]@{ FullName = 'C:\Windows\explorer.exe'; HWND = 33; Document = $unrelatedDocument }
$global:PickerMockShell = [PSCustomObject]@{}
$global:PickerMockShell | Add-Member ScriptMethod Explore { param($target) $global:PickerStarted = $true }
$global:PickerMockShell | Add-Member ScriptMethod Windows {
  $global:PickerWindowReads++
  if (-not $global:PickerStarted -or ($global:PickerScenario -eq 'closed' -and $global:PickerSelectionPhase)) { return ,@($global:PickerOldWindow) }
  if ($global:PickerScenario -eq 'ambiguous') { return ,@($global:PickerOldWindow, $global:PickerNewWindow, $global:PickerExtraWindow) }
  return ,@($global:PickerOldWindow, $global:PickerNewWindow)
}
function New-Object {
  param([Parameter(Position=0)][string]$TypeName, [Parameter(Position=1)][object[]]$ArgumentList, [string]$ComObject)
  if ($ComObject) {
    if ($ComObject -ne 'Shell.Application') { throw 'TEST FAILURE: unexpected COM class' }
    return $global:PickerMockShell
  }
  Microsoft.PowerShell.Utility\New-Object @PSBoundParameters
}
function ConvertTo-Json {
  param($InputObject, [switch]$Compress, [int]$Depth)
  if ($InputObject.type -eq 'ready') { $global:PickerSelectionPhase = $true }
  Microsoft.PowerShell.Utility\ConvertTo-Json @PSBoundParameters
}
$global:LASTEXITCODE = 0
& $env:RDESKTOP_TEST_PICKER_SCRIPT
exit $LASTEXITCODE
