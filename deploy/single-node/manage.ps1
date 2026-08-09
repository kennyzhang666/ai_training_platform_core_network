[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('Prepare', 'Start', 'Stop', 'Status', 'Backup', 'Restore', 'Doctor')]
    [string]$Action,
    [string]$Archive,
    [string]$EnvironmentFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$deployRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $deployRoot '..\..'))
if (-not $EnvironmentFile) { $EnvironmentFile = Join-Path $deployRoot '.env' }
$EnvironmentFile = [System.IO.Path]::GetFullPath($EnvironmentFile)

function Import-DotEnv([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        $example = Join-Path $deployRoot '.env.example'
        if ($Action -eq 'Prepare') {
            Copy-Item -LiteralPath $example -Destination $Path
            Write-Host "已生成配置文件：$Path"
            Write-Host '请填写 SSO、LDAP、管理员和 Nginx 配置后重新执行 Prepare。'
            exit 0
        }
        throw "配置文件不存在：$Path。请先执行 Prepare。"
    }
    foreach ($rawLine in Get-Content -LiteralPath $Path -Encoding UTF8) {
        $line = $rawLine.Trim()
        if (-not $line -or $line.StartsWith('#')) { continue }
        $separator = $line.IndexOf('=')
        if ($separator -lt 1) { throw "配置行格式错误：$rawLine" }
        $name = $line.Substring(0, $separator).Trim()
        $value = $line.Substring($separator + 1).Trim()
        if ($name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { throw "配置名格式错误：$name" }
        if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
}

function Env([string]$Name, [string]$Default = '') {
    $value = [Environment]::GetEnvironmentVariable($Name, 'Process')
    if ([string]::IsNullOrWhiteSpace($value)) { return $Default }
    return $value.Trim()
}

function Resolve-ProjectPath([string]$Value) {
    if ([System.IO.Path]::IsPathRooted($Value)) { return [System.IO.Path]::GetFullPath($Value) }
    return [System.IO.Path]::GetFullPath((Join-Path $projectRoot $Value))
}

function Assert-ProjectChild([string]$Path, [string]$Label) {
    $full = [System.IO.Path]::GetFullPath($Path)
    $relative = [System.IO.Path]::GetRelativePath($projectRoot, $full)
    if ($relative -eq '.' -or $relative.StartsWith('..') -or [System.IO.Path]::IsPathRooted($relative)) {
        throw "$Label 必须位于项目目录内：$full"
    }
    return $full
}

function Set-AbsolutePathEnvironment([string]$Name, [string]$Default) {
    $path = Assert-ProjectChild (Resolve-ProjectPath (Env $Name $Default)) $Name
    [Environment]::SetEnvironmentVariable($Name, $path, 'Process')
    return $path
}

function Assert-Configured([string]$Name, [int]$MinimumLength = 1) {
    $value = Env $Name
    if (-not $value -or $value.Length -lt $MinimumLength -or $value -match '^<.*>$|replace-me|change-me') {
        throw "请在 $EnvironmentFile 中填写 $Name"
    }
}

function Resolve-Executable([string]$Configured, [string]$Label) {
    if ([System.IO.Path]::IsPathRooted($Configured) -or $Configured.Contains('/') -or $Configured.Contains('\')) {
        $candidate = if ([System.IO.Path]::IsPathRooted($Configured)) { [System.IO.Path]::GetFullPath($Configured) } else { Resolve-ProjectPath $Configured }
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw "$Label 不存在：$candidate" }
        return $candidate
    }
    $command = Get-Command $Configured -ErrorAction SilentlyContinue
    if (-not $command) { throw "找不到 $Label：$Configured" }
    return $command.Source
}

function Quote-Argument([string]$Value) {
    return '"' + $Value.Replace('"', '\"') + '"'
}

Import-DotEnv $EnvironmentFile
[Environment]::SetEnvironmentVariable('PROJECT_ROOT', $projectRoot, 'Process')

$dataRoot = Set-AbsolutePathEnvironment 'SINGLE_NODE_DATA_ROOT' 'deploy/single-node/data'
$runtimeRoot = Set-AbsolutePathEnvironment 'SINGLE_NODE_RUNTIME_ROOT' 'deploy/single-node/runtime'
$backupRoot = Set-AbsolutePathEnvironment 'SINGLE_NODE_BACKUP_ROOT' 'deploy/single-node/backups'
$artifactRoot = Set-AbsolutePathEnvironment 'ARTIFACT_ROOT' 'deploy/single-node/data/artifacts'
$artifactUploadRoot = Set-AbsolutePathEnvironment 'ARTIFACT_UPLOAD_TMP_ROOT' 'deploy/single-node/runtime/artifact-uploads'
$enginePackageRoot = Set-AbsolutePathEnvironment 'ENGINE_PACKAGE_ROOT' 'deploy/single-node/data/engine-packages'
$batchRoot = Set-AbsolutePathEnvironment 'EVALUATION_BATCH_ROOT' 'deploy/single-node/runtime/evaluation-batches'
$evaluationLogRoot = Set-AbsolutePathEnvironment 'EVALUATION_LOG_ROOT' 'deploy/single-node/runtime/evaluation-logs'
$engineCacheRoot = Set-AbsolutePathEnvironment 'ENGINE_CACHE_ROOT' 'deploy/single-node/data/worker-engines'
$pipCacheRoot = Set-AbsolutePathEnvironment 'PIP_CACHE_DIR' 'deploy/single-node/data/pip-cache'
$wheelhouse = Set-AbsolutePathEnvironment 'ENGINE_PIP_FIND_LINKS' 'deploy/single-node/wheelhouse'

foreach ($statePath in @($artifactRoot, $enginePackageRoot, $engineCacheRoot, $pipCacheRoot)) {
    $relative = [System.IO.Path]::GetRelativePath($dataRoot, $statePath)
    if ($relative.StartsWith('..') -or [System.IO.Path]::IsPathRooted($relative)) {
        throw "持久数据路径必须位于 SINGLE_NODE_DATA_ROOT 内：$statePath"
    }
}

$uploadRelative = [System.IO.Path]::GetRelativePath($runtimeRoot, $artifactUploadRoot)
if ($uploadRelative.StartsWith('..') -or [System.IO.Path]::IsPathRooted($uploadRelative)) {
    throw "上传临时目录必须位于 SINGLE_NODE_RUNTIME_ROOT 内：$artifactUploadRoot"
}

$pidRoot = Join-Path $runtimeRoot 'pids'
$logRoot = Join-Path $runtimeRoot 'process-logs'
$nginxRuntimeConfig = Join-Path $runtimeRoot 'nginx.conf'

function Ensure-Layout {
    foreach ($directory in @(
        $dataRoot, $artifactRoot, $enginePackageRoot,
        $engineCacheRoot, $pipCacheRoot, $wheelhouse, $runtimeRoot, $pidRoot, $logRoot,
        $artifactUploadRoot, $batchRoot, $evaluationLogRoot, $backupRoot
    )) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
}

function Assert-Preflight {
    foreach ($pair in @(
        @('NODE_ENV', 'production'),
        @('PLATFORM_DEPLOYMENT_PROFILE', 'single-node'),
        @('PLATFORM_REPOSITORY', 'postgres'),
        @('OBJECT_STORAGE_MODE', 'local'),
        @('PLATFORM_IDENTITY_MODE', 'TRUSTED_GATEWAY'),
        @('EMBEDDED_EVALUATION_WORKER', 'false')
    )) {
        if ((Env $pair[0]).ToLowerInvariant() -ne $pair[1]) { throw "$($pair[0]) 必须是 $($pair[1])" }
    }
    Assert-Configured 'DATABASE_URL'
    Assert-Configured 'TRUSTED_GATEWAY_HMAC_SECRET' 32
    Assert-Configured 'LDAP_GATEWAY_SESSION_SECRET' 32
    Assert-Configured 'PLATFORM_BOOTSTRAP_GLOBAL_ADMIN_EMPLOYEE_NO'
    Assert-Configured 'EVALUATION_WORKER_EMPLOYEE_NO'
    Assert-Configured 'EVALUATION_WORKER_NAME'
    Assert-Configured 'EVALUATION_WORKER_TRUSTED_GATEWAY_SECRET' 32
    Assert-Configured 'LDAP_SERVER'
    Assert-Configured 'LDAP_BASE_DN'
    Assert-Configured 'NGINX_EXE'
    if ((Env 'EVALUATION_WORKER_TRUSTED_GATEWAY_SECRET') -ne (Env 'TRUSTED_GATEWAY_HMAC_SECRET')) {
        throw 'EVALUATION_WORKER_TRUSTED_GATEWAY_SECRET 必须与 TRUSTED_GATEWAY_HMAC_SECRET 相同'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'apps\web\dist\index.html') -PathType Leaf)) {
        throw 'Web 构建产物不存在，发布目录不完整'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'services\platform-api\dist\main.js') -PathType Leaf)) {
        throw 'API 构建产物不存在，发布目录不完整'
    }
    $runtimeMode = (Env 'PLATFORM_RUNTIME_MODE' 'workspace').ToLowerInvariant()
    if ($runtimeMode -notin @('workspace', 'bundled')) { throw 'PLATFORM_RUNTIME_MODE 必须是 workspace 或 bundled' }
    $node = Resolve-Executable (Env 'NODE_EXE' 'node') 'Node.js'
    $pnpm = if ($runtimeMode -eq 'bundled') { $null } else { Resolve-Executable 'pnpm' 'pnpm' }
    if ($runtimeMode -eq 'bundled') {
        $prismaCli = Join-Path $projectRoot 'services\platform-api\node_modules\prisma\build\index.js'
        if (-not (Test-Path -LiteralPath $prismaCli -PathType Leaf)) { throw "Prisma 迁移工具不存在：$prismaCli" }
    }
    $python = Resolve-Executable (Env 'PYTHON' '.venv/Scripts/python.exe') '平台 Python'
    $pipHelp = & $python -m pip --help 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0 -or -not $pipHelp.Contains('--python')) {
        throw '平台 Python 的 pip 不支持 --python，无法为赛题创建隔离依赖环境'
    }
    $gatewayPython = Resolve-Executable (Env 'LDAP_GATEWAY_PYTHON' 'services/ldap3-gateway/.venv/Scripts/python.exe') 'LDAP 网关 Python'
    & $gatewayPython -c 'import ldap3' 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'LDAP 网关 Python 未安装 ldap3，请使用离线 wheelhouse 安装 requirements.txt' }
    $null = Resolve-Executable (Env 'CODE_AGENT_COMMAND') 'Code Agent'
    $nginx = Resolve-Executable (Env 'NGINX_EXE') 'Nginx'
    return @{ Node = $node; Python = $python; GatewayPython = $gatewayPython; Nginx = $nginx; Pnpm = $pnpm; RuntimeMode = $runtimeMode }
}

function Invoke-PlatformPackage([string[]]$Arguments) {
    $pnpm = Resolve-Executable 'pnpm' 'pnpm'
    & $pnpm --filter '@ai-training/platform-api' @Arguments
    if ($LASTEXITCODE -ne 0) { throw "平台数据库命令执行失败：$($Arguments -join ' ')" }
}

function Invoke-PlatformNode([string]$Script, [string[]]$Arguments) {
    $node = Resolve-Executable (Env 'NODE_EXE' 'node') 'Node.js'
    Push-Location $projectRoot
    try {
        & $node $Script @Arguments
        if ($LASTEXITCODE -ne 0) { throw "平台命令执行失败：$Script $($Arguments -join ' ')" }
    } finally {
        Pop-Location
    }
}

function Use-BundledRuntime {
    return (Env 'PLATFORM_RUNTIME_MODE' 'workspace').ToLowerInvariant() -eq 'bundled'
}

function Deploy-Database {
    if (Use-BundledRuntime) {
        $prismaCli = Join-Path $projectRoot 'services\platform-api\node_modules\prisma\build\index.js'
        $schema = Join-Path $projectRoot 'services\platform-api\prisma\schema.prisma'
        Invoke-PlatformNode $prismaCli @('migrate', 'deploy', '--schema', $schema)
    } else {
        Invoke-PlatformPackage @('prisma:migrate:deploy')
    }
}

function Test-Database {
    $schema = Join-Path $projectRoot 'services\platform-api\prisma\schema.prisma'
    if (Use-BundledRuntime) {
        $prismaCli = Join-Path $projectRoot 'services\platform-api\node_modules\prisma\build\index.js'
        Invoke-PlatformNode $prismaCli @('migrate', 'status', '--schema', $schema)
    } else {
        Invoke-PlatformPackage @('exec', 'prisma', 'migrate', 'status', '--schema', $schema)
    }
}

function Export-Database([string]$Output) {
    if (Use-BundledRuntime) {
        Invoke-PlatformNode (Join-Path $projectRoot 'services\platform-api\scripts\backup-postgres.mjs') @('--output', $Output)
    } else {
        Invoke-PlatformPackage @('backup:postgres', '--', '--output', $Output)
    }
}

function Import-Database([string]$Source) {
    if (Use-BundledRuntime) {
        Invoke-PlatformNode (Join-Path $projectRoot 'services\platform-api\scripts\restore-postgres.mjs') @('--source', $Source, '--confirm', '--confirm-production')
    } else {
        Invoke-PlatformPackage @('restore:postgres', '--', '--source', $Source, '--confirm', '--confirm-production')
    }
}

function New-NginxConfig([string]$NginxExecutable) {
    $template = Get-Content -LiteralPath (Join-Path $deployRoot 'nginx-http.conf.template') -Raw -Encoding UTF8
    $nginxRoot = Split-Path -Parent $NginxExecutable
    $values = @{
        '__NGINX_PID__' = (Join-Path $runtimeRoot 'nginx.pid')
        '__NGINX_ERROR_LOG__' = (Join-Path $logRoot 'nginx-error.log')
        '__NGINX_ACCESS_LOG__' = (Join-Path $logRoot 'nginx-access.log')
        '__NGINX_MIME_TYPES__' = (Join-Path $nginxRoot 'conf\mime.types')
        '__LISTEN_PORT__' = (Env 'SINGLE_NODE_LISTEN_PORT' '8080')
        '__SERVER_NAME__' = (Env 'SINGLE_NODE_SERVER_NAME' '_')
        '__WEB_ROOT__' = (Join-Path $projectRoot 'apps\web\dist')
    }
    foreach ($item in $values.GetEnumerator()) {
        $replacement = [string]$item.Value
        if ($item.Key -ne '__LISTEN_PORT__' -and $item.Key -ne '__SERVER_NAME__') {
            $replacement = $replacement.Replace('\', '/')
        }
        $template = $template.Replace($item.Key, $replacement)
    }
    Set-Content -LiteralPath $nginxRuntimeConfig -Value $template -Encoding UTF8
    & $NginxExecutable -t -p ((Split-Path -Parent $NginxExecutable) + [System.IO.Path]::DirectorySeparatorChar) -c $nginxRuntimeConfig
    if ($LASTEXITCODE -ne 0) { throw 'Nginx 配置检查失败' }
}

function PidFile([string]$Name) { return Join-Path $pidRoot "$Name.pid" }

function Get-ManagedProcess([string]$Name) {
    $path = PidFile $Name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    $pidText = (Get-Content -LiteralPath $path -Raw).Trim()
    if ($pidText -notmatch '^\d+$') { return $null }
    return Get-Process -Id ([int]$pidText) -ErrorAction SilentlyContinue
}

function Start-ManagedProcess([string]$Name, [string]$Executable, [string[]]$Arguments, [string]$WorkingDirectory) {
    if (Get-ManagedProcess $Name) {
        Write-Host "$Name 已在运行"
        return
    }
    $stdout = Join-Path $logRoot "$Name.stdout.log"
    $stderr = Join-Path $logRoot "$Name.stderr.log"
    $process = Start-Process -FilePath $Executable -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    Set-Content -LiteralPath (PidFile $Name) -Value $process.Id -Encoding ASCII
    Start-Sleep -Milliseconds 500
    if (-not (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) {
        throw "$Name 启动失败，请查看 $stderr"
    }
}

function Stop-ManagedProcess([string]$Name) {
    $process = Get-ManagedProcess $Name
    if (-not $process) {
        Remove-Item -LiteralPath (PidFile $Name) -Force -ErrorAction SilentlyContinue
        return
    }
    $record = Get-CimInstance Win32_Process -Filter "ProcessId=$($process.Id)" -ErrorAction SilentlyContinue
    if ($record -and $Name -eq 'nginx') {
        $expected = [System.IO.Path]::GetFullPath((Resolve-Executable (Env 'NGINX_EXE') 'Nginx'))
        $actual = if ($record.ExecutablePath) { [System.IO.Path]::GetFullPath($record.ExecutablePath) } else { '' }
        if (-not $actual -or $actual -ne $expected) { throw "拒绝停止不属于当前部署的进程：$Name PID $($process.Id)" }
    } elseif ($record -and $record.CommandLine -and $record.CommandLine.IndexOf($projectRoot, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        throw "拒绝停止不属于当前部署的进程：$Name PID $($process.Id)"
    }
    Stop-Process -Id $process.Id -Force
    $process.WaitForExit()
    Remove-Item -LiteralPath (PidFile $Name) -Force -ErrorAction SilentlyContinue
}

function Wait-Health([string]$Name, [string]$Uri) {
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        try {
            $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -eq 200) { return }
        } catch {}
        Start-Sleep -Milliseconds 500
    }
    throw "$Name 健康检查失败：$Uri"
}

function Start-All {
    Ensure-Layout
    $runtime = Assert-Preflight
    Deploy-Database
    New-NginxConfig $runtime.Nginx
    $node = $runtime.Node
    Start-ManagedProcess 'api' $node @((Quote-Argument (Join-Path $projectRoot 'services\platform-api\dist\main.js'))) $projectRoot
    Start-ManagedProcess 'ldap3' $runtime.GatewayPython @((Quote-Argument (Join-Path $projectRoot 'services\ldap3-gateway\ldap3_gateway.py'))) (Join-Path $projectRoot 'services\ldap3-gateway')
    Wait-Health '平台 API' 'http://127.0.0.1:3000/api/v1/health'
    Wait-Health 'LDAP 网关' 'http://127.0.0.1:8081/healthz'
    Start-ManagedProcess 'worker' $node @(
        (Quote-Argument (Join-Path $projectRoot 'scripts\evaluation-worker.mjs')),
        '--api', (Env 'PLATFORM_API' 'http://127.0.0.1:3000/api/v1'),
        '--employee', (Env 'EVALUATION_WORKER_EMPLOYEE_NO'),
        '--worker', (Env 'EVALUATION_WORKER_ID' 'single-node-worker'),
        '--batch-root', (Quote-Argument $batchRoot),
        '--cache', (Quote-Argument $engineCacheRoot)
    ) $projectRoot
    $nginxPrefix = (Split-Path -Parent $runtime.Nginx) + [System.IO.Path]::DirectorySeparatorChar
    Start-ManagedProcess 'nginx' $runtime.Nginx @('-p', (Quote-Argument $nginxPrefix), '-c', (Quote-Argument $nginxRuntimeConfig)) (Split-Path -Parent $runtime.Nginx)
    Write-Host "单服务器平台已启动：http://127.0.0.1:$(Env 'SINGLE_NODE_LISTEN_PORT' '8080')/"
}

function Stop-All {
    $nginxExecutable = Env 'NGINX_EXE'
    if ($nginxExecutable) {
        try {
            $nginx = Resolve-Executable $nginxExecutable 'Nginx'
            if (Test-Path -LiteralPath $nginxRuntimeConfig) {
                & $nginx -s quit -p ((Split-Path -Parent $nginx) + [System.IO.Path]::DirectorySeparatorChar) -c $nginxRuntimeConfig 2>$null
                Start-Sleep -Seconds 1
            }
        } catch {}
    }
    foreach ($name in @('nginx', 'worker', 'ldap3', 'api')) { Stop-ManagedProcess $name }
    Write-Host '单服务器平台已停止'
}

function Show-Status {
    $rows = foreach ($name in @('api', 'ldap3', 'worker', 'nginx')) {
        $process = Get-ManagedProcess $name
        [pscustomobject]@{ Service = $name; Status = if ($process) { '运行中' } else { '已停止' }; PID = if ($process) { $process.Id } else { '' } }
    }
    $rows | Format-Table -AutoSize
}

function Get-PlatformVersion {
    $versionFile = Join-Path $projectRoot 'VERSION'
    if (Test-Path -LiteralPath $versionFile -PathType Leaf) {
        return (Get-Content -LiteralPath $versionFile -Raw -Encoding UTF8).Trim()
    }
    $packageFile = Join-Path $projectRoot 'package.json'
    if (Test-Path -LiteralPath $packageFile -PathType Leaf) {
        return ((Get-Content -LiteralPath $packageFile -Raw -Encoding UTF8 | ConvertFrom-Json).version)
    }
    return 'unknown'
}

function Invoke-Doctor {
    Ensure-Layout
    $runtime = Assert-Preflight
    New-NginxConfig $runtime.Nginx
    Test-Database
    Write-Host "部署检查通过：$($runtime.RuntimeMode) / Windows x64"
}

function New-Backup {
    Ensure-Layout
    $wasRunning = [bool](@('api', 'ldap3', 'worker', 'nginx') | Where-Object { Get-ManagedProcess $_ } | Select-Object -First 1)
    if ($wasRunning) { Stop-All }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $destination = if ($Archive) { [System.IO.Path]::GetFullPath($Archive) } else { Join-Path $backupRoot "ai-training-single-node-$stamp.zip" }
    if (Test-Path -LiteralPath $destination) { throw "备份文件已存在，拒绝覆盖：$destination" }
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    $staging = Assert-ProjectChild (Join-Path $runtimeRoot "backup-$stamp") '备份临时目录'
    try {
        New-Item -ItemType Directory -Path $staging -Force | Out-Null
        Export-Database (Join-Path $staging 'database.json')
        Copy-Item -LiteralPath $dataRoot -Destination (Join-Path $staging 'data') -Recurse
        @{ version = (Get-PlatformVersion); database = 'postgresql'; createdAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $staging 'manifest.json') -Encoding UTF8
        Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $destination -CompressionLevel Optimal
        Write-Host "备份已生成：$destination"
    } finally {
        if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
        if ($wasRunning) { Start-All }
    }
}

function Restore-Backup {
    if (-not $Archive) { throw 'Restore 必须通过 -Archive 指定备份 ZIP' }
    $source = [System.IO.Path]::GetFullPath($Archive)
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "备份不存在：$source" }
    Stop-All
    Ensure-Layout
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $staging = Assert-ProjectChild (Join-Path $runtimeRoot "restore-$stamp") '恢复临时目录'
    $previousData = Assert-ProjectChild (Join-Path $deployRoot "data.before-restore-$stamp") '恢复前数据目录'
    $failedData = Assert-ProjectChild (Join-Path $deployRoot "data.failed-restore-$stamp") '失败恢复数据目录'
    $previousUploads = Assert-ProjectChild (Join-Path $runtimeRoot "artifact-uploads.before-restore-$stamp") '恢复前上传临时目录'
    $failedUploads = Assert-ProjectChild (Join-Path $runtimeRoot "artifact-uploads.failed-restore-$stamp") '失败恢复上传临时目录'
    try {
        New-Item -ItemType Directory -Path $staging -Force | Out-Null
        Expand-Archive -LiteralPath $source -DestinationPath $staging
        if (-not (Test-Path -LiteralPath (Join-Path $staging 'manifest.json') -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $staging 'database.json') -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $staging 'data') -PathType Container)) {
            throw '备份结构无效'
        }
        Deploy-Database
        if (Test-Path -LiteralPath $dataRoot) { Move-Item -LiteralPath $dataRoot -Destination $previousData }
        Move-Item -LiteralPath (Join-Path $staging 'data') -Destination $dataRoot
        if (Test-Path -LiteralPath $artifactUploadRoot) { Move-Item -LiteralPath $artifactUploadRoot -Destination $previousUploads }
        New-Item -ItemType Directory -Path $artifactUploadRoot -Force | Out-Null
        Import-Database (Join-Path $staging 'database.json')
        Write-Host "恢复完成。原数据保留在：$previousData；未完成上传保留在：$previousUploads"
    } catch {
        if (Test-Path -LiteralPath $previousUploads) {
            if (Test-Path -LiteralPath $artifactUploadRoot) { Move-Item -LiteralPath $artifactUploadRoot -Destination $failedUploads }
            Move-Item -LiteralPath $previousUploads -Destination $artifactUploadRoot
        }
        if (Test-Path -LiteralPath $previousData) {
            if (Test-Path -LiteralPath $dataRoot) { Move-Item -LiteralPath $dataRoot -Destination $failedData }
            Move-Item -LiteralPath $previousData -Destination $dataRoot
        }
        throw
    } finally {
        if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
    }
}

switch ($Action) {
    'Prepare' {
        Ensure-Layout
        $runtime = Assert-Preflight
        Deploy-Database
        New-NginxConfig $runtime.Nginx
        Write-Host '单服务器部署检查通过'
    }
    'Start' { Start-All }
    'Stop' { Stop-All }
    'Status' { Show-Status }
    'Backup' { New-Backup }
    'Restore' { Restore-Backup }
    'Doctor' { Invoke-Doctor }
}
