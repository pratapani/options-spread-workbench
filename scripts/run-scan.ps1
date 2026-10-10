param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot '..\services\scanner\scan_config.json'),
    [string]$BreezeSessionToken
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $projectRoot '.env'
$controllerPath = Join-Path $projectRoot 'apps\controller\controller.mjs'
$controllerProcess = $null
$ownsController = $false
$scanSubmitted = $false
$scanFinished = $false
$stdoutPath = Join-Path $env:TEMP ("options-spread-controller-$([guid]::NewGuid().ToString('N')).out.log")
$stderrPath = Join-Path $env:TEMP ("options-spread-controller-$([guid]::NewGuid().ToString('N')).err.log")

if (Test-Path -LiteralPath $envFile) {
    Get-Content -LiteralPath $envFile | ForEach-Object {
        if ($_ -match '^\s*([^#=\s]+)\s*=\s*(.*?)\s*$') {
            $name = $matches[1]
            if (-not [Environment]::GetEnvironmentVariable($name, 'Process')) {
                $value = $matches[2].Trim().Trim('"', "'")
                [Environment]::SetEnvironmentVariable($name, $value, 'Process')
            }
        }
    }
}

$controllerPort = if ($env:BPS_CONTROLLER_PORT) { $env:BPS_CONTROLLER_PORT } else { '8787' }
$baseUrl = "http://127.0.0.1:$controllerPort"

function Get-ConfigNumber {
    param(
        [Parameter(Mandatory = $true)]$Config,
        [Parameter(Mandatory = $true)][string]$Name
    )

    $property = $Config.PSObject.Properties[$Name]
    if (-not $property -or $null -eq $property.Value) {
        throw "Config value '$Name' is required."
    }

    $parsed = 0.0
    $valid = [double]::TryParse(
        [string]$property.Value,
        [Globalization.NumberStyles]::Float,
        [Globalization.CultureInfo]::InvariantCulture,
        [ref]$parsed
    )
    if (-not $valid -or [double]::IsNaN($parsed) -or [double]::IsInfinity($parsed)) {
        throw "Config value '$Name' must be a finite number."
    }

    return $parsed
}

function Test-Controller {
    try {
        Invoke-RestMethod -Uri "$baseUrl/api/status" -TimeoutSec 3 | Out-Null
        return $true
    } catch {
        return $false
    }
}

try {
    $resolvedConfigPath = (Resolve-Path -LiteralPath $ConfigPath).Path
    $config = Get-Content -LiteralPath $resolvedConfigPath -Raw | ConvertFrom-Json

    $strategy = ([string]$config.strategy).Trim().ToUpperInvariant()
    if ($strategy -notin @('BULL_PUT', 'BEAR_CALL')) {
        throw "Config strategy must be BULL_PUT or BEAR_CALL."
    }
    $expiry = ([string]$config.expiry).Trim()
    if ([string]::IsNullOrWhiteSpace($expiry)) {
        throw "Set a valid expiry in '$resolvedConfigPath' before running the scan."
    }

    $minOtm = Get-ConfigNumber $config 'min_otm_percent'
    $maxOtm = Get-ConfigNumber $config 'max_otm_percent'
    $maxWidth = Get-ConfigNumber $config 'max_spread_width'
    $minPL = Get-ConfigNumber $config 'min_profit_to_loss'
    $maxPL = Get-ConfigNumber $config 'max_profit_to_loss'
    $minOI = Get-ConfigNumber $config 'min_oi'
    $minVolume = Get-ConfigNumber $config 'min_volume'

    if ($minOtm -lt 0 -or $maxOtm -lt $minOtm) { throw 'Config OTM range is invalid.' }
    if ($maxWidth -le 0) { throw 'Config max_spread_width must be greater than zero.' }
    if ($minPL -lt 0 -or $maxPL -lt $minPL) { throw 'Config P:L range is invalid.' }
    if ($minOI -lt 0 -or $minVolume -lt 0) { throw 'Config OI and volume must be zero or greater.' }
    $sessionToken = if ([string]::IsNullOrWhiteSpace($BreezeSessionToken)) {
        $env:BREEZE_SESSION_TOKEN
    } else {
        $BreezeSessionToken.Trim()
    }
    if ([string]::IsNullOrWhiteSpace($sessionToken)) {
        throw 'Set BREEZE_SESSION_TOKEN in .env or pass -BreezeSessionToken.'
    }

    if (-not (Test-Controller)) {
        $node = Get-Command node -ErrorAction SilentlyContinue
        if (-not $node) { throw 'Node.js is required to start the local EC2 controller.' }

        $controllerProcess = Start-Process `
            -FilePath $node.Source `
            -ArgumentList @('apps/controller/controller.mjs') `
            -WorkingDirectory $projectRoot `
            -WindowStyle Hidden `
            -RedirectStandardOutput $stdoutPath `
            -RedirectStandardError $stderrPath `
            -PassThru
        $ownsController = $true

        $ready = $false
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            if (Test-Controller) { $ready = $true; break }
            $controllerProcess.Refresh()
            if ($controllerProcess.HasExited) { break }
            Start-Sleep -Seconds 1
        }
        if (-not $ready) {
            $details = ''
            if (Test-Path -LiteralPath $stderrPath) {
                $details = (Get-Content -LiteralPath $stderrPath -Raw).Trim()
            }
            throw "Local controller did not start. $details"
        }
    }

    $controllerConfig = Invoke-RestMethod -Uri "$baseUrl/api/config" -TimeoutSec 10
    if ([string]::IsNullOrWhiteSpace([string]$controllerConfig.instanceId)) {
        throw 'BPS_EC2_INSTANCE_ID must be configured in .env.'
    }
    if ([string]::IsNullOrWhiteSpace([string]$controllerConfig.securityGroupId)) {
        throw 'BPS_EC2_SECURITY_GROUP_ID must be configured in .env.'
    }
    if ([string]::IsNullOrWhiteSpace([string]$controllerConfig.keyPath)) {
        throw 'BPS_EC2_KEY_PATH must be configured in .env.'
    }

    $payload = [ordered]@{
        strategy = $strategy
        expiry = $expiry
        minOtm = $minOtm
        maxOtm = $maxOtm
        maxWidth = $maxWidth
        minPL = $minPL
        maxPL = $maxPL
        minOI = $minOI
        minVolume = $minVolume
        sessionToken = $sessionToken
        host = $controllerConfig.host
        user = $controllerConfig.user
        keyPath = $controllerConfig.keyPath
        remoteDir = $controllerConfig.remoteDir
        instanceId = $controllerConfig.instanceId
        securityGroupId = $controllerConfig.securityGroupId
    }

    $jsonBody = $payload | ConvertTo-Json -Depth 5 -Compress
    Invoke-RestMethod `
        -Uri "$baseUrl/api/run" `
        -Method Post `
        -ContentType 'application/json' `
        -Body $jsonBody `
        -TimeoutSec 15 | Out-Null
    $scanSubmitted = $true

    Write-Host "Started $strategy scan for expiry $expiry. Waiting for the CSV report..."
    $lastLineCount = 0
    do {
        Start-Sleep -Seconds 2
        $status = Invoke-RestMethod -Uri "$baseUrl/api/status" -TimeoutSec 10
        $lines = @($status.lines)
        for ($index = $lastLineCount; $index -lt $lines.Count; $index++) {
            if ($lines[$index]) { Write-Host $lines[$index] }
        }
        $lastLineCount = $lines.Count
    } while ($status.running)

    $scanFinished = $true
    if ($status.status -ne 'complete') {
        throw "Scan failed: $($status.error -or $status.message)"
    }

    $reportPath = Join-Path $projectRoot ("apps\controller\public\$($status.resultFile)")
    $latestName = if ($strategy -eq 'BEAR_CALL') { 'latest_bcs_results.csv' } else { 'latest_bps_results.csv' }
    $latestPath = Join-Path $projectRoot "apps\controller\public\$latestName"
    Write-Host "Scan complete. Report: $reportPath"
    Write-Host "Latest report: $latestPath"
} finally {
    if ($ownsController -and $controllerProcess) {
        if (-not $scanSubmitted -or $scanFinished) {
            $controllerProcess.Refresh()
            if (-not $controllerProcess.HasExited) {
                Stop-Process -Id $controllerProcess.Id -Force -ErrorAction SilentlyContinue
            }
            Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
        } else {
            Write-Warning 'The scan may still be running; the controller was left running so it can finish.'
        }
    }
}