# 已废弃（2026-11-07）：Go/Node 双后端对比门禁已完成使命，Node 网关已冻结。
[CmdletBinding()]
param(
    [string]$GoUrl = "http://127.0.0.1:18080",
    [string]$NodeUrl = "http://127.0.0.1:18081",
    [string]$Username = "admin",
    [string]$Password = "admin123",
    [string]$OutputFile = ""
)

$ErrorActionPreference = "Stop"

function Invoke-Json([string]$Method, [string]$Url, [hashtable]$Headers = @{}, $Body = $null) {
    if ($null -ne $Body) {
        $json = $Body | ConvertTo-Json -Depth 20 -Compress
        $response = Invoke-WebRequest -Method $Method -Uri $Url -Headers $Headers -ContentType "application/json" -Body $json -UseBasicParsing
    } else {
        $response = Invoke-WebRequest -Method $Method -Uri $Url -Headers $Headers -UseBasicParsing
    }
    if ([string]::IsNullOrWhiteSpace($response.Content)) { return $null }
    return $response.Content | ConvertFrom-Json
}

function Login([string]$BaseUrl) {
    $body = @{ username = $Username; password = $Password } | ConvertTo-Json -Compress
    $response = Invoke-WebRequest -Method POST -Uri "$BaseUrl/api/auth/login" -ContentType "application/json" -Body $body -UseBasicParsing
    $result = $response.Content | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace($result.token)) {
        throw "login failed: $BaseUrl"
    }
    return @{ Authorization = "Bearer $($result.token)" }
}

function Normalize-Config($Config) {
    $channels = @($Config.channels | ForEach-Object {
        [ordered]@{
            id = $_.id
            protocol = $_.protocol
            host = $_.host
            port = [int]$_.port
            enabled = [bool]$_.enabled
        }
    } | Sort-Object id)
    $tags = @($Config.tags | ForEach-Object {
        [ordered]@{
            id = $_.id
            channelId = $_.channelId
            name = $_.name
            address = $_.address
            dataType = $_.dataType
        }
    } | Sort-Object id)
    return [ordered]@{ channels = $channels; tags = $tags }
}

function Normalize-Channels($Channels) {
    return @($Channels | ForEach-Object {
        [ordered]@{
            id = $_.id
            state = if ($null -ne $_.state) { $_.state } else { $_.status }
        }
    } | Sort-Object id)
}

function Normalize-LiveQuality($Live) {
    return @($Live | ForEach-Object {
        [ordered]@{
            id = [string]$_.id
            quality = [string]$_.quality
        }
    } | Sort-Object id)
}

function Compare-Json($Left, $Right) {
    $leftText = $Left | ConvertTo-Json -Depth 30 -Compress
    $rightText = $Right | ConvertTo-Json -Depth 30 -Compress
    return $leftText -eq $rightText
}

$report = [ordered]@{
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    go = [ordered]@{ url = $GoUrl }
    node = [ordered]@{ url = $NodeUrl }
    checks = @()
    pass = $true
}

foreach ($target in @(
    @{ Name = "go"; Url = $GoUrl },
    @{ Name = "node"; Url = $NodeUrl }
)) {
    $headers = Login $target.Url
    $health = Invoke-Json "GET" "$($target.Url)/api/health" $headers
    $config = Invoke-Json "GET" "$($target.Url)/api/config" $headers
    $channels = Invoke-Json "GET" "$($target.Url)/api/channels" $headers
    $live = Invoke-Json "GET" "$($target.Url)/api/tags/live" $headers
    $report[$target.Name].health = $health
    $report[$target.Name].config = Normalize-Config $config
    $report[$target.Name].channels = Normalize-Channels $channels
    $report[$target.Name].liveCount = if ($live -is [System.Array]) { @($live).Count } elseif ($null -ne $live.values) { @($live.values).Count } else { 0 }
    $report[$target.Name].liveQuality = Normalize-LiveQuality $live
    $report[$target.Name].liveQualityKey = @($report[$target.Name].liveQuality | ForEach-Object { "$($_.id)=$($_.quality)" } | Sort-Object) -join "|"
}

$configEqual = Compare-Json $report.go.config $report.node.config
$goChannelIds = @($report.go.channels | ForEach-Object { $_.id } | Sort-Object) -join ","
$nodeChannelIds = @($report.node.channels | ForEach-Object { $_.id } | Sort-Object) -join ","
$channelTopologyEqual = $goChannelIds -eq $nodeChannelIds
$stateDiffs = @()
$goState = @{}
foreach ($channel in $report.go.channels) { $goState[$channel.id] = $channel.state }
foreach ($channel in $report.node.channels) {
    if ($goState.ContainsKey($channel.id) -and $goState[$channel.id] -ne $channel.state) {
        $stateDiffs += [ordered]@{ id = $channel.id; go = $goState[$channel.id]; node = $channel.state }
    }
}
$configCheck = [ordered]@{ name = "config-topology"; pass = $configEqual; detail = "channel and tag identity/protocol/address/type" }
$channelCheck = [ordered]@{ name = "channel-topology"; pass = $channelTopologyEqual; detail = "channel identity set" }
$stateCheck = [ordered]@{ name = "channel-state-parity"; pass = $stateDiffs.Count -eq 0; detail = $stateDiffs }
$storageCheck = [ordered]@{ name = "storage-health"; pass = ($report.go.health.storage.state -eq "online" -and $report.node.health.storage.state -eq "online"); detail = "TDengine online on both backends" }
$liveCheck = [ordered]@{ name = "live-samples"; pass = ($report.go.liveCount -gt 0 -and $report.node.liveCount -gt 0); detail = "both backends expose live samples" }
$qualityCheck = [ordered]@{ name = "live-quality-parity"; pass = ($report.go.liveQualityKey -eq $report.node.liveQualityKey); detail = "live tag identity and quality code" }
$report.checks = @($configCheck, $channelCheck, $stateCheck, $storageCheck, $liveCheck, $qualityCheck)
$report.pass = @($report.checks | Where-Object { -not $_.pass }).Count -eq 0

$report | ConvertTo-Json -Depth 30 | Write-Output
if ($OutputFile -ne "") {
    $parent = Split-Path -Parent $OutputFile
    if ($parent -ne "") { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    $report | ConvertTo-Json -Depth 30 | Set-Content -Encoding UTF8 $OutputFile
}
if (-not $report.pass) { exit 1 }
