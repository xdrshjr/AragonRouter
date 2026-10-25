#Requires -Version 5.1
<#
.SYNOPSIS
    Helper process for tests/integration/scripts-runtime.test.ts.

.DESCRIPTION
    Listens on 127.0.0.1 and prints the bound port as the first stdout line, then
    keeps the socket open until it is killed or the deadline passes.

    Its only purpose is to play the role of a *foreign* process that occupies the
    port recorded in .dev-server.port: the process name is `powershell`, which is
    not in stop-dev.ps1's allow list (node/cmd/npm). That lets the suite prove the
    port fallback refuses to kill an unrelated program instead of just asserting the
    allow list exists in the source.

.PARAMETER Port
    Port to bind. 0 picks an ephemeral one.

.PARAMETER LifetimeSeconds
    Safety net so a leaked helper exits on its own.
#>
[CmdletBinding()]
param(
    [int]$Port = 0,
    [int]$LifetimeSeconds = 120
)

$ErrorActionPreference = 'Stop'
$listener = $null
try {
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Parse('127.0.0.1'), $Port)
    $listener.Start()
    $actual = [int]$listener.LocalEndpoint.Port
    [Console]::Out.WriteLine($actual)
    [Console]::Out.Flush()

    $deadline = (Get-Date).AddSeconds($LifetimeSeconds)
    while ((Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
}
finally {
    if ($null -ne $listener) {
        try { $listener.Stop() } catch { }
    }
}
