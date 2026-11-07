[CmdletBinding()]
param(
    [string]$GoUrl = "http://127.0.0.1:18080",
    [string]$NodeUrl = "http://127.0.0.1:18081",
    [string]$Username = "admin",
    [string]$Password = $env:GATEWAY_PASSWORD,
    [string]$OutputFile = ""
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrEmpty($Password)) { throw "Set -Password or GATEWAY_PASSWORD" }

function Invoke-Json([string]$Method, [string]$Url, [hashtable]$Headers = @{}, $Body = $null) {
    if ($null -eq $Body) {
        $response = Invoke-WebRequest -Method $Method -Uri $Url -Headers $Headers -UseBasicParsing
    } else {
        $json = $Body | ConvertTo-Json -Depth 20 -Compress
        $response = Invoke-WebRequest -Method $Method -Uri $Url -Headers $Headers -ContentType "application/json" -Body $json -UseBasicParsing
    }
    if ([string]::IsNullOrWhiteSpace($response.Content)) { return $null }
    return $response.Content | ConvertFrom-Json
}

function Login([string]$BaseUrl) {
    $result = Invoke-Json "POST" "$BaseUrl/api/auth/login" @{} @{ username = $Username; password = $Password }
    if ([string]::IsNullOrWhiteSpace($result.token)) { throw "login failed: $BaseUrl" }
    return @{ Authorization = "Bearer $($result.token)" }
}

# Values are written to simulator-backed points and are intentionally small,
# deterministic values so the probe is safe to repeat.
$probes = @(
    [ordered]@{ protocol = "MELSEC"; tagId = "31"; value = 1234 },
    [ordered]@{ protocol = "EtherNet/IP"; tagId = "35"; value = 333 },
    [ordered]@{ protocol = "FINS"; tagId = "34"; value = 1500 }
)

$report = [ordered]@{
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    go = [ordered]@{ url = $GoUrl; results = @() }
    node = [ordered]@{ url = $NodeUrl; results = @() }
    pass = $true
}

foreach ($target in @(
    @{ Name = "go"; Url = $GoUrl },
    @{ Name = "node"; Url = $NodeUrl }
)) {
    $headers = Login $target.Url
    foreach ($probe in $probes) {
        $item = [ordered]@{
            protocol = $probe.protocol
            tagId = $probe.tagId
            value = $probe.value
            ok = $false
            error = ""
        }
        try {
            $result = Invoke-Json "POST" "$($target.Url)/api/tags/$($probe.tagId)/write" $headers @{ value = $probe.value }
            $item.ok = [bool]$result.ok
            if (-not $item.ok) { $item.error = [string]$result.error }
        } catch {
            $item.error = $_.Exception.Message
        }
        $report[$target.Name].results += $item
        if (-not $item.ok) { $report.pass = $false }
    }
}

$json = $report | ConvertTo-Json -Depth 20
$json | Write-Output
if ($OutputFile -ne "") {
    $parent = Split-Path -Parent $OutputFile
    if ($parent -ne "") { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    $json | Set-Content -Encoding UTF8 $OutputFile
}
if (-not $report.pass) { exit 1 }
