<#
.SYNOPSIS
  Read-only audit: every app registration in the tenant, with how long each
  client secret and certificate has left.

.DESCRIPTION
  Secret Management itself can only see registrations it OWNS — that is the
  deliberate opt-in model (Application.ReadWrite.OwnedBy). The blind spot is a
  registration nobody opted in: it is never shown and never warned about.

  This script closes that blind spot from the outside. It signs you in as
  yourself, reads the whole tenant with Application.Read.All, and lists what is
  expiring. Run it occasionally to catch registrations that should be added to
  Secret Management but have not been.

  It changes NOTHING. No secret is created, read or deleted — Graph never
  returns secret values, only their metadata and expiry dates.

.PREREQUISITES
      Install-Module Microsoft.Graph.Authentication, Microsoft.Graph.Applications -Scope CurrentUser

.EXAMPLE
  .\audit-secrets.ps1                      # everything, soonest expiry first
  .\audit-secrets.ps1 -ExpiringWithinDays 90
  .\audit-secrets.ps1 -Search ITQPOMS      # find one by name
  .\audit-secrets.ps1 -CsvPath .\secrets.csv
#>
[CmdletBinding()]
param(
    # Only show credentials expiring within this many days (0 = show all).
    [int] $ExpiringWithinDays = 0,

    # Only registrations whose display name contains this text.
    [string] $Search,

    # Also write the full result to a CSV.
    [string] $CsvPath,

    # Include registrations that have no credentials at all.
    [switch] $IncludeEmpty
)

$ErrorActionPreference = 'Stop'

foreach ($m in 'Microsoft.Graph.Authentication', 'Microsoft.Graph.Applications') {
    if (-not (Get-Module -ListAvailable $m)) {
        throw "$m is not installed. Run:`n  Install-Module Microsoft.Graph.Authentication, Microsoft.Graph.Applications -Scope CurrentUser"
    }
}

Write-Host 'Signing in to Microsoft Graph (read-only)...' -ForegroundColor Cyan
Connect-MgGraph -Scopes 'Application.Read.All' -NoWelcome

Write-Host 'Reading every app registration in the tenant...' -ForegroundColor Cyan
$apps = Get-MgApplication -All
Write-Host "  $($apps.Count) registrations`n" -ForegroundColor Cyan

$now  = Get-Date
$rows = foreach ($app in $apps) {
    if ($Search -and $app.DisplayName -notlike "*$Search*") { continue }

    $creds = @()
    foreach ($c in $app.PasswordCredentials) { $creds += [pscustomobject]@{ Kind = 'secret'; Name = $c.DisplayName; End = $c.EndDateTime } }
    foreach ($c in $app.KeyCredentials)      { $creds += [pscustomobject]@{ Kind = 'cert';   Name = $c.DisplayName; End = $c.EndDateTime } }

    if (-not $creds) {
        if ($IncludeEmpty) {
            [pscustomobject]@{
                App = $app.DisplayName; AppId = $app.AppId; Kind = '-'
                Credential = '(none)'; Expires = $null; DaysLeft = $null; Status = 'NO CREDENTIAL'
            }
        }
        continue
    }

    foreach ($c in $creds) {
        $days = if ($c.End) { [int][math]::Floor(($c.End - $now).TotalDays) } else { $null }
        $status = if ($null -eq $days) { 'unknown' }
                  elseif ($days -lt 0)  { 'EXPIRED' }
                  elseif ($days -le 7)  { 'URGENT' }
                  elseif ($days -le 30) { 'soon' }
                  else                  { 'ok' }
        [pscustomobject]@{
            App        = $app.DisplayName
            AppId      = $app.AppId
            Kind       = $c.Kind
            Credential = if ($c.Name) { $c.Name } else { '(unnamed)' }
            Expires    = if ($c.End) { $c.End.ToString('yyyy-MM-dd') } else { '' }
            DaysLeft   = $days
            Status     = $status
        }
    }
}

$rows = @($rows | Sort-Object { if ($null -eq $_.DaysLeft) { [int]::MaxValue } else { $_.DaysLeft } })
if ($ExpiringWithinDays -gt 0) {
    $rows = @($rows | Where-Object { $null -ne $_.DaysLeft -and $_.DaysLeft -le $ExpiringWithinDays })
}

if (-not $rows) { Write-Host 'Nothing matched.' -ForegroundColor Yellow; return }

foreach ($r in $rows) {
    $colour = switch ($r.Status) {
        'EXPIRED'       { 'Red' }
        'URGENT'        { 'Red' }
        'soon'          { 'Yellow' }
        'NO CREDENTIAL' { 'DarkGray' }
        default         { 'Gray' }
    }
    Write-Host ("  {0,-46} {1,-7} {2,-24} {3,-11} {4,6}  {5}" -f
        $r.App.Substring(0, [Math]::Min(46, $r.App.Length)), $r.Kind,
        $r.Credential.Substring(0, [Math]::Min(24, $r.Credential.Length)),
        $r.Expires, $(if ($null -ne $r.DaysLeft) { $r.DaysLeft } else { '?' }), $r.Status) -ForegroundColor $colour
}

$expired = @($rows | Where-Object Status -eq 'EXPIRED').Count
$urgent  = @($rows | Where-Object Status -eq 'URGENT').Count
$soon    = @($rows | Where-Object Status -eq 'soon').Count
Write-Host "`n  $($rows.Count) credentials — expired $expired, within 7 days $urgent, within 30 days $soon" -ForegroundColor Cyan

if ($CsvPath) {
    $rows | Export-Csv -Path $CsvPath -NoTypeInformation -Encoding UTF8
    Write-Host "  written to $CsvPath" -ForegroundColor Cyan
}

Write-Host "`nAnything here that Secret Management is not already tracking should be added:"
Write-Host "  .\scripts\add-owner.ps1 -Apps '<display name>'"
