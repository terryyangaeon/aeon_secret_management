<#
.SYNOPSIS
  Makes the Secret Management service principal an Owner of the app registrations
  it should look after.

.DESCRIPTION
  Secret Management holds the Microsoft Graph permission
  Application.ReadWrite.OwnedBy, which exposes ONLY the app registrations where its
  service principal is listed as an Owner. That is the opt-in model: a registration
  nobody opted in stays invisible and is never touched.

  The Entra admin center cannot do this. Its Owners picker searches users only, so a
  service principal can never be selected there, even though Entra itself allows one
  to be an owner. It has to go through Microsoft Graph — hence this script.

.PREREQUISITES
  PowerShell 7+, and the Graph modules (one-off, a few minutes):

      Install-Module Microsoft.Graph.Authentication, Microsoft.Graph.Applications -Scope CurrentUser

  You sign in interactively; the script never handles a secret. Adding an owner needs
  Application.ReadWrite.All, so run it as someone who can consent to that — a Global,
  Privileged Role or Cloud Application Administrator.

.EXAMPLE
  # See what it would do, change nothing:
  .\add-owner.ps1 -WhatIf

.EXAMPLE
  # Do it:
  .\add-owner.ps1

.EXAMPLE
  # Just one registration:
  .\add-owner.ps1 -Apps 'AEON Document Log'

.NOTES
  Safe to re-run: a registration that already has the owner is reported and skipped.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    # Application (client) ID of AEON Secret Management.
    [string] $ToolAppId = 'c9256bf9-2522-4dd7-b5cf-17af1ae2934b',

    # Registrations to opt in, by display name.
    [string[]] $Apps = @(
        'AEON Access Control Attendance - Hikvision',
        'AEON Device Management',
        'AEON Document Log',
        'AEON IoT Smart Toilet',
        'AEON IT Tracker',
        'AEON OneView',
        'AEON PWH Attendance Record',
        'AEON Secret Management'      # itself, so it warns about its own 6-month secret
    )
)

$ErrorActionPreference = 'Stop'

foreach ($m in 'Microsoft.Graph.Authentication', 'Microsoft.Graph.Applications') {
    if (-not (Get-Module -ListAvailable $m)) {
        throw "$m is not installed. Run:`n  Install-Module Microsoft.Graph.Authentication, Microsoft.Graph.Applications -Scope CurrentUser"
    }
}

Write-Host 'Signing in to Microsoft Graph...' -ForegroundColor Cyan
Connect-MgGraph -Scopes 'Application.ReadWrite.All', 'Directory.Read.All' -NoWelcome

# The OWNER is the service principal (the enterprise-app side), not the registration.
$sp = Get-MgServicePrincipal -Filter "appId eq '$ToolAppId'" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $sp) { throw "No service principal found for appId $ToolAppId. Check the Application (client) ID." }
Write-Host "Owner to add: $($sp.DisplayName)  (service principal $($sp.Id))`n" -ForegroundColor Cyan

$added = 0; $already = 0; $failed = 0

foreach ($name in $Apps) {
    $escaped = $name.Replace("'", "''")
    $matches = @(Get-MgApplication -Filter "displayName eq '$escaped'" -ErrorAction SilentlyContinue)

    if ($matches.Count -eq 0) {
        Write-Host ("  SKIP     {0,-46} no registration with that display name" -f $name) -ForegroundColor Yellow
        $failed++; continue
    }
    if ($matches.Count -gt 1) {
        Write-Host ("  SKIP     {0,-46} {1} registrations share that name - add it by hand" -f $name, $matches.Count) -ForegroundColor Yellow
        $failed++; continue
    }
    $app = $matches[0]

    $owners = @(Get-MgApplicationOwner -ApplicationId $app.Id -All -ErrorAction SilentlyContinue)
    if ($owners.Id -contains $sp.Id) {
        Write-Host ("  ALREADY  {0,-46} {1}" -f $name, $app.AppId) -ForegroundColor DarkGray
        $already++; continue
    }

    if ($PSCmdlet.ShouldProcess($name, "add $($sp.DisplayName) as an owner")) {
        try {
            New-MgApplicationOwnerByRef -ApplicationId $app.Id -BodyParameter @{
                '@odata.id' = "https://graph.microsoft.com/v1.0/directoryObjects/$($sp.Id)"
            }
            Write-Host ("  ADDED    {0,-46} {1}" -f $name, $app.AppId) -ForegroundColor Green
            $added++
        } catch {
            Write-Host ("  FAILED   {0,-46} {1}" -f $name, $_.Exception.Message) -ForegroundColor Red
            $failed++
        }
    }
}

Write-Host "`nadded $added, already owned $already, not done $failed" -ForegroundColor Cyan
Write-Host 'Now open Configuration -> Applications in Secret Management; the list is what it can see.'
