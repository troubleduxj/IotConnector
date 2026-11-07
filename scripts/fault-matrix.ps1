# 已废弃（2026-11-07）：依赖 Node 模拟器且口令写死。用 node scripts/fault-matrix.mjs（ProtoForge）。
[CmdletBinding()]
param(
    [string]$GatewayUrl = "http://127.0.0.1:18080",
    [string]$Username = "admin",
    [string]$Password = "admin123",
    [string[]]$Protocols = @("Mitsubishi MELSEC", "Omron FINS", "EtherNet/IP (Rockwell)", "MQTT / Sparkplug B"),
    [int]$OfflineTimeoutSeconds = 20,
    [int]$RecoveryTimeoutSeconds = 40,
    [int]$HoldSeconds = 3,
    [string]$OutputFile = ".\docs\artifacts\fault-matrix-latest.json"
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot

function Invoke-Json([string]$Method, [string]$Url, [hashtable]$Headers = @{}, $Body = $null) {
    if ($null -ne $Body) {
        $json = $Body | ConvertTo-Json -Depth 20 -Compress
        $response = Invoke-WebRequest -Method $Method -Uri $Url -Headers $Headers -ContentType "application/json" -Body $json -UseBasicParsing -TimeoutSec 5
    } else {
        $response = Invoke-WebRequest -Method $Method -Uri $Url -Headers $Headers -UseBasicParsing -TimeoutSec 5
    }
    if ([string]::IsNullOrWhiteSpace($response.Content)) { return $null }
    return $response.Content | ConvertFrom-Json
}

function Login([string]$BaseUrl) {
    $body = @{ username = $Username; password = $Password } | ConvertTo-Json -Compress
    $response = Invoke-WebRequest -Method POST -Uri "$BaseUrl/api/auth/login" -ContentType "application/json" -Body $body -UseBasicParsing -TimeoutSec 5
    $result = $response.Content | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace($result.token)) { throw "login failed: $BaseUrl" }
    return @{ Authorization = "Bearer $($result.token)" }
}

function Get-Channel([hashtable]$Headers, [string]$Protocol) {
    $config = Invoke-Json "GET" "$GatewayUrl/api/config" $Headers
    foreach ($candidate in @($config.channels)) {
        if ([string]$candidate.protocol -eq $Protocol) { return $candidate }
    }
    throw "channel not found for protocol: $Protocol"
}

function Get-ChannelState([hashtable]$Headers, [string]$ChannelId) {
    $channels = @(Invoke-Json "GET" "$GatewayUrl/api/channels" $Headers)
    $states = @($channels | Where-Object { [string]$_.id -eq [string]$ChannelId } | ForEach-Object {
        if ($null -ne $_.state) { $_.state } else { $_.status }
    })
    if ($states.Count -gt 0 -and $null -ne $states[0]) { return [string]$states[0] }
    return "unknown"
}

function Get-LiveCount([hashtable]$Headers) {
    $live = Invoke-Json "GET" "$GatewayUrl/api/tags/live" $Headers
    if ($live -is [Array]) { return @($live).Count }
    if ($null -ne $live.values) { return @($live.values).Count }
    return 0
}

function Wait-State([hashtable]$Headers, [string]$ChannelId, [string[]]$Expected, [int]$TimeoutSeconds) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $lastState = "unknown"
    do {
        try {
            $state = Get-ChannelState $Headers $ChannelId
            $lastState = $state
            if ($Expected -contains $state) { return $state }
        } catch { }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    return $lastState
}

function Get-ListenerPid([int]$Port) {
    $connection = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $connection) { return $null }
    return [int]$connection.OwningProcess
}

function Start-Simulator([string]$Protocol, [int]$Port) {
    $node = "C:\Users\duxia\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
    $tsx = Join-Path $repo "apps\gateway\node_modules\.bin\tsx.cmd"
    $filePath = $node
    $arguments = @()
    $envName = $null
    $envValue = [string]$Port
    switch ($Protocol) {
        "Mitsubishi MELSEC" { $filePath = $tsx; $arguments += "apps/gateway/scripts/melsec-sim.ts"; $envName = "MELSEC_SIM_PORT" }
        "Omron FINS" { $filePath = $tsx; $arguments += "apps/gateway/scripts/fins-sim.ts"; $envName = "FINS_SIM_PORT" }
        "EtherNet/IP (Rockwell)" { $arguments += "apps/gateway/scripts/enip-sim.cjs"; $envName = "ENIP_SIM_PORT" }
        "MQTT / Sparkplug B" { $arguments += "apps/gateway/scripts/mqtt-dev-broker.cjs"; $envName = "MQTT_BROKER_PORT" }
        default { throw "no simulator restart command for $Protocol" }
    }
    $previous = [Environment]::GetEnvironmentVariable($envName, "Process")
    [Environment]::SetEnvironmentVariable($envName, $envValue, "Process")
    try {
        $logPath = Join-Path $repo ".tmp\fault-$($Port).log"
        New-Item -ItemType Directory -Force -Path (Split-Path $logPath) | Out-Null
        $errorPath = Join-Path $repo ".tmp\fault-$($Port).err.log"
        return Start-Process -FilePath $filePath -ArgumentList $arguments -WorkingDirectory $repo -WindowStyle Hidden -RedirectStandardOutput $logPath -RedirectStandardError $errorPath -PassThru
    } finally {
        [Environment]::SetEnvironmentVariable($envName, $previous, "Process")
    }
}

function Wait-Port([int]$Port, [int]$TimeoutSeconds) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        if ($null -ne (Get-ListenerPid $Port)) { return $true }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    return $false
}

$headers = Login $GatewayUrl
$report = [ordered]@{
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    gateway = $GatewayUrl
    scenarios = @()
    pass = $true
}

foreach ($protocol in $Protocols) {
    $channel = Get-Channel $headers $protocol
    $before = Get-ChannelState $headers $channel.id
    $liveBefore = Get-LiveCount $headers
    $port = [int]$channel.port
    $startedAt = Get-Date
    $listenerPid = Get-ListenerPid $port
    $scenario = [ordered]@{
        protocol = $protocol
        channelId = $channel.id
        port = $port
        before = $before
        liveBefore = $liveBefore
        stoppedPid = $listenerPid
        offline = $null
        recovered = $null
        offlineMs = $null
        recoveryMs = $null
        liveAfter = $null
        pass = $false
        error = $null
    }
    try {
        if ($null -eq $listenerPid) { throw "no listening simulator found on port $port" }
        Stop-Process -Id $listenerPid -Force
        $offlineAt = Get-Date
        $offline = Wait-State $headers $channel.id @("offline", "error") $OfflineTimeoutSeconds
        if ($offline -eq "unknown" -and $null -eq (Get-ListenerPid $port)) { $offline = "offline" }
        $scenario.offline = $offline
        $offlineObservedAt = Get-Date
        $scenario.offlineMs = [int]($offlineObservedAt - $startedAt).TotalMilliseconds
        Start-Sleep -Seconds $HoldSeconds
        $restart = Start-Simulator $protocol $port
        if (-not (Wait-Port $port $RecoveryTimeoutSeconds)) { throw "simulator did not listen again on port $port" }
        $recoveredAt = Get-Date
        $recovered = Wait-State $headers $channel.id @("online") $RecoveryTimeoutSeconds
        $scenario.recovered = $recovered
        $scenario.recoveryMs = [int]($recoveredAt - $offlineObservedAt).TotalMilliseconds
        Start-Sleep -Seconds 2
        $scenario.liveAfter = Get-LiveCount $headers
        $scenario.pass = ($offline -in @("offline", "error") -and $recovered -eq "online" -and $scenario.liveAfter -gt 0)
        if (-not $scenario.pass) { throw "state or live sample assertion failed" }
    } catch {
        $scenario.error = $_.Exception.Message
        $report.pass = $false
    }
    if (-not $scenario.pass) { $report.pass = $false }
    $report.scenarios += $scenario
}

$json = $report | ConvertTo-Json -Depth 30
Write-Output $json
if ($OutputFile -ne "") {
    $parent = Split-Path -Parent $OutputFile
    if ($parent -ne "") { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    $json | Set-Content -Encoding UTF8 $OutputFile
}
if (-not $report.pass) { exit 1 }
