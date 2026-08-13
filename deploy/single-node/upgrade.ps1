[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallRoot,
    [string]$EnvironmentFile,
    [string]$RecoveryRoot,
    [ValidateRange(1, 86400)]
    [int]$DrainTimeoutSec = 900,
    [switch]$CheckOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$packageRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptRoot '..\..'))
$packagePython = Join-Path $packageRoot 'runtime\python\python.exe'
$packagePowerShell = Join-Path $packageRoot 'runtime\powershell\pwsh.exe'
$packageHelper = Join-Path $packageRoot 'scripts\offline-upgrade-helper.py'
$env:PYTHONDONTWRITEBYTECODE = '1'
$managedServices = @('api', 'ldap3', 'worker', 'nginx')
$directorySeparator = [System.IO.Path]::DirectorySeparatorChar
$script:upgradeLockStream = $null

function Get-FullPath([string]$Path, [string]$BasePath) {
    if ([string]::IsNullOrWhiteSpace($Path)) { throw '路径不能为空' }
    if ($Path.Contains('"')) { throw '路径不能包含双引号' }
    $candidate = if ([System.IO.Path]::IsPathRooted($Path)) { $Path } else { Join-Path $BasePath $Path }
    $full = [System.IO.Path]::GetFullPath($candidate)
    $root = [System.IO.Path]::GetPathRoot($full)
    if ($full.Length -gt $root.Length) { $full = $full.TrimEnd('\', '/') }
    return $full
}

function Test-PathWithin([string]$Parent, [string]$Candidate, [switch]$AllowSame) {
    $parentFull = [System.IO.Path]::GetFullPath($Parent)
    $candidateFull = [System.IO.Path]::GetFullPath($Candidate)
    $relative = [System.IO.Path]::GetRelativePath($parentFull, $candidateFull)
    if ($relative -eq '.') { return [bool]$AllowSame }
    return -not [System.IO.Path]::IsPathRooted($relative) -and $relative -ne '..' -and -not $relative.StartsWith("..$directorySeparator", [StringComparison]::Ordinal)
}

function Assert-Disjoint([string]$Left, [string]$Right, [string]$Label) {
    if ((Test-PathWithin $Left $Right -AllowSame) -or (Test-PathWithin $Right $Left -AllowSame)) {
        throw "$Label 路径不能相同或互相包含：$Left / $Right"
    }
}

function Assert-ExistingDirectory([string]$Path, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { throw "$Label 不存在：$Path" }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "$Label 不能是重解析点：$Path" }
}

function Assert-ProjectChild([string]$Root, [string]$Path, [string]$Label) {
    if (-not (Test-PathWithin $Root $Path)) { throw "$Label 必须位于安装根目录内：$Path" }
    if (Test-Path -LiteralPath $Path) {
        $item = Get-Item -LiteralPath $Path -Force
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "$Label 不能是重解析点：$Path" }
    }
}

function Read-DotEnv([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "旧配置文件不存在：$Path" }
    $values = @{}
    foreach ($rawLine in Get-Content -LiteralPath $Path -Encoding UTF8) {
        $line = $rawLine.Trim()
        if (-not $line -or $line.StartsWith('#')) { continue }
        $separator = $line.IndexOf('=')
        if ($separator -lt 1) { throw '旧配置文件包含格式错误的配置行' }
        $name = $line.Substring(0, $separator).Trim()
        $value = $line.Substring($separator + 1).Trim()
        if ($name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { throw '旧配置文件包含格式错误的配置名' }
        if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        $values[$name] = $value
    }
    return $values
}

function Get-EnvironmentValue([System.Collections.IDictionary]$Values, [string]$Name, [string]$Default = '') {
    if ($Values.Contains($Name) -and -not [string]::IsNullOrWhiteSpace([string]$Values[$Name])) { return ([string]$Values[$Name]).Trim() }
    return $Default
}

function Resolve-ConfiguredChildPath(
    [System.Collections.IDictionary]$Values,
    [string]$Name,
    [string]$Default,
    [string]$Root
) {
    $resolved = Get-FullPath (Get-EnvironmentValue $Values $Name $Default) $Root
    Assert-ProjectChild $Root $resolved $Name
    return $resolved
}

function Get-RelativeChildPath([string]$Root, [string]$Child, [string]$Label) {
    Assert-ProjectChild $Root $Child $Label
    $relative = [System.IO.Path]::GetRelativePath($Root, $Child)
    if ($relative -eq '.' -or [System.IO.Path]::IsPathRooted($relative) -or $relative.StartsWith('..')) { throw "$Label 不是有效的安装目录子路径" }
    return $relative
}

function Join-VerifiedChild([string]$Root, [string]$Relative, [string]$Label) {
    $path = [System.IO.Path]::GetFullPath((Join-Path $Root $Relative))
    Assert-ProjectChild $Root $path $Label
    return $path
}

function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Enter-UpgradeLock([string]$InstallParent, [string]$InstallLeaf) {
    $lockPath = Join-Path $InstallParent ".$InstallLeaf.upgrade.lock"
    try {
        $script:upgradeLockStream = [System.IO.File]::Open(
            $lockPath,
            [System.IO.FileMode]::OpenOrCreate,
            [System.IO.FileAccess]::ReadWrite,
            [System.IO.FileShare]::None
        )
    } catch [System.IO.IOException] {
        throw '另一个平台升级正在进行'
    }
}

function Quote-ProcessArgument([string]$Value) {
    if ($Value.Contains('"')) { throw '命令参数不能包含双引号' }
    return '"' + $Value + '"'
}

function Invoke-ElevatedCopy {
    $arguments = @(
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', (Quote-ProcessArgument $PSCommandPath),
        '-InstallRoot', (Quote-ProcessArgument $InstallRoot)
    )
    if ($EnvironmentFile) { $arguments += @('-EnvironmentFile', (Quote-ProcessArgument $EnvironmentFile)) }
    if ($RecoveryRoot) { $arguments += @('-RecoveryRoot', (Quote-ProcessArgument $RecoveryRoot)) }
    $arguments += @('-DrainTimeoutSec', $DrainTimeoutSec.ToString())
    if ($CheckOnly) { $arguments += '-CheckOnly' }
    $process = Start-Process -FilePath $packagePowerShell -ArgumentList ($arguments -join ' ') -Verb RunAs -Wait -PassThru
    exit $process.ExitCode
}

function Invoke-Helper([string]$Command, [string[]]$Arguments) {
    & $packagePython $packageHelper $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "离线升级辅助命令失败：$Command" }
}

function Get-ActiveEvaluationCount([string]$ManagerEnvironmentFile) {
    $output = & $packagePython $packageHelper 'database-active-evaluations' '--environment-file' $ManagerEnvironmentFile
    if ($LASTEXITCODE -ne 0) { throw '无法确认运行中评测数量' }
    $value = 0
    if (-not [int]::TryParse(([string]$output).Trim(), [ref]$value) -or $value -lt 0) { throw '运行中评测数量格式无效' }
    return $value
}

function Get-DatabaseSize([string]$ManagerEnvironmentFile) {
    $output = & $packagePython $packageHelper 'database-size' '--environment-file' $ManagerEnvironmentFile
    if ($LASTEXITCODE -ne 0) { throw '无法确认数据库占用空间' }
    [long]$value = 0
    if (-not [long]::TryParse(([string]$output).Trim(), [ref]$value) -or $value -lt 0) { throw '数据库占用空间格式无效' }
    return $value
}

function Wait-ActiveEvaluations([string]$ManagerEnvironmentFile) {
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($DrainTimeoutSec)
    while ($true) {
        $count = Get-ActiveEvaluationCount $ManagerEnvironmentFile
        if ($count -eq 0) { return }
        if ([DateTimeOffset]::UtcNow -ge $deadline) { throw "等待运行中评测结束超时，仍有 $count 个运行任务" }
        Write-Host "仍有 $count 个评测运行中，等待完成后再停服……"
        Start-Sleep -Seconds 5
    }
}

function Invoke-Manager(
    [string]$Root,
    [string]$Action,
    [string]$ManagerEnvironmentFile,
    [string]$Archive = ''
) {
    $powerShell = Join-Path $Root 'runtime\powershell\pwsh.exe'
    $manager = Join-Path $Root 'deploy\single-node\manage.ps1'
    if (-not (Test-Path -LiteralPath $powerShell -PathType Leaf)) { throw "发布目录缺少 PowerShell 运行时：$Root" }
    if (-not (Test-Path -LiteralPath $manager -PathType Leaf)) { throw "发布目录缺少平台管理器：$Root" }
    $arguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $manager, $Action, '-EnvironmentFile', $ManagerEnvironmentFile)
    if ($Archive) { $arguments += @('-Archive', $Archive) }
    & $powerShell @arguments
    if ($LASTEXITCODE -ne 0) { throw "平台管理命令失败：$Action" }
}

function Start-InstalledPlatform(
    [string]$Root,
    [string]$ManagerEnvironmentFile,
    [bool]$PreferStartupTask
) {
    $task = if ($PreferStartupTask) { Get-ScheduledTask -TaskName 'AITrainingPlatform' -ErrorAction SilentlyContinue } else { $null }
    if ($task -and $task.State -ne 'Disabled') {
        Start-ScheduledTask -TaskName 'AITrainingPlatform'
        $runtimeValues = Read-DotEnv $ManagerEnvironmentFile
        $runtime = Resolve-ConfiguredChildPath $runtimeValues 'SINGLE_NODE_RUNTIME_ROOT' 'runtime-state' $Root
        for ($attempt = 0; $attempt -lt 60; $attempt++) {
            if ((Get-RunningManagedServices $runtime $Root).Count -eq $managedServices.Count) { return }
            Start-Sleep -Milliseconds 500
        }
        throw '开机任务没有在预期时间内启动全部平台进程'
    }
    Invoke-Manager $Root 'Start' $ManagerEnvironmentFile
}

function Get-ReleaseVersion([string]$Root, [string]$Label) {
    $versionFile = Join-Path $Root 'VERSION'
    if (-not (Test-Path -LiteralPath $versionFile -PathType Leaf)) { throw "$Label 缺少 VERSION 文件" }
    $version = (Get-Content -LiteralPath $versionFile -Raw -Encoding UTF8).Trim()
    if ($version -notmatch '^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$') { throw "$Label VERSION 格式无效" }
    return $version
}

function Get-SemVerCore([string]$Version) {
    $match = [regex]::Match($Version, '^(\d+)\.(\d+)\.(\d+)')
    if (-not $match.Success) { throw '版本号格式无效' }
    return [version]::new([int]$match.Groups[1].Value, [int]$match.Groups[2].Value, [int]$match.Groups[3].Value)
}

function Get-DirectoryBytes([string]$Path) {
    [long]$total = 0
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return $total }
    foreach ($file in Get-ChildItem -LiteralPath $Path -File -Recurse -Force) { $total += $file.Length }
    return $total
}

function Get-AvailableBytes([string]$Path) {
    $root = [System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($Path))
    try { return [long]([System.IO.DriveInfo]::new($root).AvailableFreeSpace) } catch { return [long]::MaxValue }
}

function Assert-DiskCapacity(
    [string]$StageParent,
    [string]$RecoveryPath,
    [long]$PackageBytes,
    [long]$DataBytes,
    [long]$DatabaseBytes
) {
    [long]$reserve = 512MB
    [long]$installRequired = $PackageBytes + $DataBytes + $reserve
    [long]$recoveryRequired = $DataBytes + (2 * $DatabaseBytes) + 1GB
    $stageVolume = [System.IO.Path]::GetPathRoot($StageParent)
    $recoveryVolume = [System.IO.Path]::GetPathRoot($RecoveryPath)
    if ([string]::Equals($stageVolume, $recoveryVolume, [StringComparison]::OrdinalIgnoreCase)) {
        if ((Get-AvailableBytes $StageParent) -lt ($installRequired + $recoveryRequired)) { throw '安装卷空间不足，无法同时暂存新包并创建升级恢复点' }
    } else {
        if ((Get-AvailableBytes $StageParent) -lt $installRequired) { throw '安装卷空间不足，无法暂存新包和平台备份' }
        if ((Get-AvailableBytes $RecoveryPath) -lt $recoveryRequired) { throw '恢复卷空间不足，无法保存升级恢复点' }
    }
}

function Copy-ReleaseTree([string]$Source, [string]$Destination) {
    if (Test-Path -LiteralPath $Destination) { throw "同卷暂存目录已存在：$Destination" }
    New-Item -ItemType Directory -Path $Destination | Out-Null
    foreach ($entry in Get-ChildItem -LiteralPath $Source -Force) {
        Copy-Item -LiteralPath $entry.FullName -Destination $Destination -Recurse -Force
    }
}

function Copy-ProtectedFile([string]$Source, [string]$Destination) {
    if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { throw '要复制的受保护文件不存在' }
    New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
    try {
        $acl = Get-Acl -LiteralPath $Source
        Set-Acl -LiteralPath $Destination -AclObject $acl
    } catch {
        throw '无法保留配置文件访问控制列表'
    }
}

function Test-OwnedProcess([string]$PidFile, [string]$Root) {
    if (-not (Test-Path -LiteralPath $PidFile -PathType Leaf)) { return $false }
    $pidText = (Get-Content -LiteralPath $PidFile -Raw).Trim()
    if ($pidText -notmatch '^\d+$') { return $false }
    $record = Get-CimInstance Win32_Process -Filter "ProcessId=$pidText" -ErrorAction SilentlyContinue
    if (-not $record -or -not $record.CommandLine) { return $false }
    return $record.CommandLine.IndexOf($Root, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Get-RunningManagedServices([string]$RuntimeRoot, [string]$Root) {
    $pidRoot = Join-Path $RuntimeRoot 'pids'
    return @($managedServices | Where-Object { Test-OwnedProcess (Join-Path $pidRoot "$_.pid") $Root })
}

function Assert-PlatformBackup([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf) -or (Get-Item -LiteralPath $Path).Length -le 0) { throw '平台一致性备份没有生成有效文件' }
    $archive = [System.IO.Compression.ZipFile]::OpenRead($Path)
    try {
        $names = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
        if ('manifest.json' -notin $names -or 'database.json' -notin $names -or -not ($names | Where-Object { $_ -eq 'data/' -or $_.StartsWith('data/') } | Select-Object -First 1)) {
            throw '平台一致性备份结构无效'
        }
    } finally {
        $archive.Dispose()
    }
}

function Remove-PackagePlaceholder([string]$Path, [string]$Root, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    Assert-ProjectChild $Root $Path $Label
    $unexpected = @(Get-ChildItem -LiteralPath $Path -Force -Recurse | Where-Object { -not $_.PSIsContainer -and $_.Name -ne '.keep' })
    if ($unexpected.Count) { throw "$Label 包含非占位文件，拒绝替换" }
    Remove-Item -LiteralPath $Path -Recurse -Force
}

function Move-DirectoryExact([string]$Source, [string]$Destination, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Source -PathType Container)) { throw "$Label 源目录不存在：$Source" }
    if (Test-Path -LiteralPath $Destination) { throw "$Label 目标目录已存在：$Destination" }
    New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
    Move-Item -LiteralPath $Source -Destination $Destination
}

function Write-JsonAtomically([string]$Path, [object]$Value) {
    $temporary = "$Path.tmp-$([guid]::NewGuid().ToString('N'))"
    $Value | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temporary -Encoding UTF8
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Set-UpgradePhase([System.Collections.IDictionary]$State, [string]$StatePath, [string]$Phase, [string]$ErrorMessage = '') {
    $State['phase'] = $Phase
    $State['updatedAt'] = (Get-Date).ToUniversalTime().ToString('o')
    if ($ErrorMessage) { $State['lastError'] = $ErrorMessage } elseif ($State.Contains('lastError')) { $State.Remove('lastError') }
    Write-JsonAtomically $StatePath $State
}

function Get-SafeErrorMessage([object]$ErrorRecord) {
    $message = if ($ErrorRecord -is [System.Management.Automation.ErrorRecord]) { $ErrorRecord.Exception.Message } elseif ($ErrorRecord -is [Exception]) { $ErrorRecord.Message } else { [string]$ErrorRecord }
    $message = $message -replace '(?i)(postgres(?:ql)?://[^:/\s]+:)[^@\s]+@', '$1***@'
    $message = $message -replace '(?i)\b(password|secret|token|cookie|credential)=\S+', '$1=***'
    if ($message.Length -gt 1000) { $message = $message.Substring(0, 1000) }
    return $message
}

function Wait-EntryHealth([System.Collections.IDictionary]$Values) {
    $portText = Get-EnvironmentValue $Values 'SINGLE_NODE_LISTEN_PORT' '8080'
    $port = 0
    if (-not [int]::TryParse($portText, [ref]$port) -or $port -lt 1 -or $port -gt 65535) { throw 'SINGLE_NODE_LISTEN_PORT 格式无效' }
    $uri = "http://127.0.0.1:$port/"
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        try {
            $response = Invoke-WebRequest -Uri $uri -UseBasicParsing -MaximumRedirection 5 -TimeoutSec 3
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) { return }
        } catch {}
        Start-Sleep -Milliseconds 500
    }
    throw "平台入口健康检查失败：$uri"
}

function Invoke-OfflineUpgrade {
    $resolvedInstallRoot = Get-FullPath $InstallRoot (Get-Location).Path
    Assert-ExistingDirectory $resolvedInstallRoot '现有安装根目录'
    if ($resolvedInstallRoot -eq [System.IO.Path]::GetPathRoot($resolvedInstallRoot)) { throw '安装根目录不能是卷根目录' }
    Assert-ExistingDirectory $packageRoot '新发布包根目录'
    Assert-Disjoint $resolvedInstallRoot $packageRoot '现有安装根目录与新发布包'

    foreach ($required in @($packagePython, $packagePowerShell, $packageHelper, (Join-Path $packageRoot 'release-manifest.json'))) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "新完整发布包缺少必要文件：$required" }
    }

    $resolvedEnvironmentFile = if ($EnvironmentFile) {
        Get-FullPath $EnvironmentFile $resolvedInstallRoot
    } else {
        Join-Path $resolvedInstallRoot 'deploy\single-node\.env'
    }
    if (-not (Test-Path -LiteralPath $resolvedEnvironmentFile -PathType Leaf)) { throw "旧配置文件不存在：$resolvedEnvironmentFile" }
    if (Test-PathWithin $packageRoot $resolvedEnvironmentFile -AllowSame) { throw '旧配置文件不能位于新发布包目录内' }
    if (-not (Test-PathWithin $resolvedInstallRoot $resolvedEnvironmentFile)) { throw '旧配置文件必须位于现有安装根目录内' }
    $environmentRelative = Get-RelativeChildPath $resolvedInstallRoot $resolvedEnvironmentFile '旧配置文件'

    $installParent = Split-Path -Parent $resolvedInstallRoot
    Assert-ExistingDirectory $installParent '安装根目录的父目录'
    $installLeaf = Split-Path -Leaf $resolvedInstallRoot
    $resolvedRecoveryRoot = if ($RecoveryRoot) {
        Get-FullPath $RecoveryRoot (Get-Location).Path
    } else {
        Join-Path $installParent "$installLeaf-upgrade-recovery"
    }
    if ($resolvedRecoveryRoot -eq [System.IO.Path]::GetPathRoot($resolvedRecoveryRoot)) { throw '恢复根目录不能是卷根目录' }
    Assert-Disjoint $resolvedRecoveryRoot $resolvedInstallRoot '恢复根目录与安装根目录'
    Assert-Disjoint $resolvedRecoveryRoot $packageRoot '恢复根目录与新发布包'
    if (Test-Path -LiteralPath $resolvedRecoveryRoot) { Assert-ExistingDirectory $resolvedRecoveryRoot '恢复根目录' }

    $environmentValues = Read-DotEnv $resolvedEnvironmentFile
    $dataRoot = Resolve-ConfiguredChildPath $environmentValues 'SINGLE_NODE_DATA_ROOT' 'data' $resolvedInstallRoot
    $backupRoot = Resolve-ConfiguredChildPath $environmentValues 'SINGLE_NODE_BACKUP_ROOT' 'backups' $resolvedInstallRoot
    $runtimeRoot = Resolve-ConfiguredChildPath $environmentValues 'SINGLE_NODE_RUNTIME_ROOT' 'runtime-state' $resolvedInstallRoot
    Assert-Disjoint $dataRoot $backupRoot '持久数据目录与备份目录'
    Assert-Disjoint $runtimeRoot $dataRoot '运行状态目录与持久数据目录'
    Assert-Disjoint $runtimeRoot $backupRoot '运行状态目录与备份目录'

    $dataRelative = Get-RelativeChildPath $resolvedInstallRoot $dataRoot '持久数据目录'
    $backupRelative = Get-RelativeChildPath $resolvedInstallRoot $backupRoot '备份目录'
    $targetVersion = Get-ReleaseVersion $packageRoot '新发布包'
    $sourceVersion = Get-ReleaseVersion $resolvedInstallRoot '现有安装'
    if ((Get-SemVerCore $targetVersion) -le (Get-SemVerCore $sourceVersion)) { throw "目标版本必须高于现有版本：$sourceVersion -> $targetVersion" }

    $null = Invoke-Helper 'verify-release' @('--release-root', $packageRoot, '--source-root', $resolvedInstallRoot)
    $null = Invoke-Helper 'database-check' @('--environment-file', $resolvedEnvironmentFile)

    $runningServices = Get-RunningManagedServices $runtimeRoot $resolvedInstallRoot
    if ($runningServices.Count -ne 0 -and $runningServices.Count -ne $managedServices.Count) {
        throw "现有平台处于部分运行状态，请先恢复为全部运行或全部停止：$($runningServices -join ', ')"
    }
    $wasRunning = $runningServices.Count -eq $managedServices.Count
    $activeEvaluations = Get-ActiveEvaluationCount $resolvedEnvironmentFile

    [long]$packageBytes = Get-DirectoryBytes $packageRoot
    [long]$dataBytes = Get-DirectoryBytes $dataRoot
    [long]$databaseBytes = Get-DatabaseSize $resolvedEnvironmentFile
    Assert-DiskCapacity $installParent $resolvedRecoveryRoot $packageBytes $dataBytes $databaseBytes

    if ($CheckOnly) {
        Write-Host "离线升级预检通过：$sourceVersion -> $targetVersion；当前运行中评测 $activeEvaluations 个"
        return
    }
    if (-not (Test-Administrator)) { Invoke-ElevatedCopy }
    Enter-UpgradeLock $installParent $installLeaf

    $transactionId = "$(Get-Date -Format 'yyyyMMdd-HHmmss')-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
    $stageRoot = Join-Path $installParent ".$installLeaf.upgrade-stage-$transactionId"
    $previousRoot = Join-Path $installParent "$installLeaf.previous-$sourceVersion-$transactionId"
    $failedRoot = Join-Path $installParent "$installLeaf.failed-$targetVersion-$transactionId"
    $transactionRecovery = Join-Path $resolvedRecoveryRoot $transactionId
    foreach ($path in @($stageRoot, $previousRoot, $failedRoot, $transactionRecovery)) {
        if (Test-Path -LiteralPath $path) { throw "升级事务路径已存在，拒绝覆盖：$path" }
    }
    if (-not [string]::Equals([System.IO.Path]::GetPathRoot($stageRoot), [System.IO.Path]::GetPathRoot($resolvedInstallRoot), [StringComparison]::OrdinalIgnoreCase)) {
        throw '同卷暂存目录必须与安装根目录位于同一卷'
    }
    Assert-Disjoint $stageRoot $resolvedInstallRoot '暂存目录与安装根目录'
    Assert-Disjoint $previousRoot $resolvedInstallRoot '旧版本保留目录与安装根目录'
    Assert-Disjoint $failedRoot $resolvedInstallRoot '失败版本保留目录与安装根目录'

    New-Item -ItemType Directory -Path $transactionRecovery -Force | Out-Null
    $statePath = Join-Path $transactionRecovery 'upgrade-state.json'
    $state = [ordered]@{
        schemaVersion = '1.0'
        transactionId = $transactionId
        phase = 'PREFLIGHT_VERIFIED'
        sourceVersion = $sourceVersion
        targetVersion = $targetVersion
        installRoot = $resolvedInstallRoot
        packageRoot = $packageRoot
        stageRoot = $stageRoot
        previousRoot = $previousRoot
        failedRoot = $failedRoot
        recoveryRoot = $transactionRecovery
        wasRunning = $wasRunning
        runningServices = @($runningServices)
        createdAt = (Get-Date).ToUniversalTime().ToString('o')
        updatedAt = (Get-Date).ToUniversalTime().ToString('o')
    }
    Write-JsonAtomically $statePath $state

    $oldStopped = $false
    $nativeBackupCreated = $false
    $databaseMutated = $false
    $oldRootRenamed = $false
    $newRootActivated = $false
    $dataAttached = $false
    $backupsAttached = $false
    $newStarted = $false
    $platformBackup = Join-Path $transactionRecovery 'platform-backup.zip'
    $nativeDatabaseBackup = Join-Path $transactionRecovery 'database-native.dump'
    $recoveryEnvironment = Join-Path $transactionRecovery 'environment.env'
    $stagedEnvironment = Join-VerifiedChild $stageRoot $environmentRelative '暂存环境配置'

    try {
        Copy-ReleaseTree $packageRoot $stageRoot
        $null = Invoke-Helper 'verify-release' @('--release-root', $stageRoot, '--source-root', $resolvedInstallRoot)
        Set-UpgradePhase $state $statePath 'STAGED'

        Wait-ActiveEvaluations $resolvedEnvironmentFile
        Invoke-Manager $resolvedInstallRoot 'Stop' $resolvedEnvironmentFile
        $oldStopped = $true
        if ((Get-RunningManagedServices $runtimeRoot $resolvedInstallRoot).Count -ne 0) { throw '旧平台仍有受管进程未停止' }
        $remaining = Get-ActiveEvaluationCount $resolvedEnvironmentFile
        if ($remaining -ne 0) {
            Write-Host '停服竞态中出现新的运行任务，恢复旧服务并再次排空……'
            Start-InstalledPlatform $resolvedInstallRoot $resolvedEnvironmentFile $wasRunning
            Wait-ActiveEvaluations $resolvedEnvironmentFile
            Invoke-Manager $resolvedInstallRoot 'Stop' $resolvedEnvironmentFile
            if ((Get-ActiveEvaluationCount $resolvedEnvironmentFile) -ne 0) { throw '停服后仍存在运行中评测，拒绝继续升级' }
        }
        Set-UpgradePhase $state $statePath 'SOURCE_STOPPED'

        Invoke-Manager $resolvedInstallRoot 'Backup' $resolvedEnvironmentFile $platformBackup
        Assert-PlatformBackup $platformBackup
        $state['platformBackupSha256'] = (Get-FileHash -LiteralPath $platformBackup -Algorithm SHA256).Hash.ToLowerInvariant()
        Set-UpgradePhase $state $statePath 'PLATFORM_BACKUP_CREATED'

        Copy-ProtectedFile $resolvedEnvironmentFile $recoveryEnvironment
        Copy-ProtectedFile $resolvedEnvironmentFile $stagedEnvironment
        $state['environmentSha256'] = (Get-FileHash -LiteralPath $recoveryEnvironment -Algorithm SHA256).Hash.ToLowerInvariant()
        Set-UpgradePhase $state $statePath 'CONFIG_COPIED'

        Invoke-Helper 'database-backup' @('--environment-file', $resolvedEnvironmentFile, '--output', $nativeDatabaseBackup)
        if (-not (Test-Path -LiteralPath $nativeDatabaseBackup -PathType Leaf) -or (Get-Item -LiteralPath $nativeDatabaseBackup).Length -le 0) { throw '原生数据库恢复点没有生成有效文件' }
        $nativeBackupCreated = $true
        $state['nativeDatabaseBackupSha256'] = (Get-FileHash -LiteralPath $nativeDatabaseBackup -Algorithm SHA256).Hash.ToLowerInvariant()
        $recoveryManifest = [ordered]@{
            schemaVersion = '1.0'
            transactionId = $transactionId
            sourceVersion = $sourceVersion
            targetVersion = $targetVersion
            createdAt = (Get-Date).ToUniversalTime().ToString('o')
            files = @(
                @{ path = 'platform-backup.zip'; sha256 = $state['platformBackupSha256']; size = (Get-Item -LiteralPath $platformBackup).Length },
                @{ path = 'database-native.dump'; sha256 = $state['nativeDatabaseBackupSha256']; size = (Get-Item -LiteralPath $nativeDatabaseBackup).Length },
                @{ path = 'environment.env'; sha256 = $state['environmentSha256']; size = (Get-Item -LiteralPath $recoveryEnvironment).Length }
            )
        }
        Write-JsonAtomically (Join-Path $transactionRecovery 'recovery-manifest.json') $recoveryManifest
        Set-UpgradePhase $state $statePath 'RECOVERY_VERIFIED'

        Move-DirectoryExact $resolvedInstallRoot $previousRoot '旧安装目录保留'
        $oldRootRenamed = $true
        Set-UpgradePhase $state $statePath 'SOURCE_RENAMED'

        Move-DirectoryExact $stageRoot $resolvedInstallRoot '新安装目录激活'
        $newRootActivated = $true
        Set-UpgradePhase $state $statePath 'TARGET_ACTIVATED'

        $previousData = Join-VerifiedChild $previousRoot $dataRelative '旧持久数据目录'
        $activeData = Join-VerifiedChild $resolvedInstallRoot $dataRelative '新持久数据目录'
        Remove-PackagePlaceholder $activeData $resolvedInstallRoot '新包持久数据占位目录'
        Move-DirectoryExact $previousData $activeData '持久数据归位'
        $dataAttached = $true
        Set-UpgradePhase $state $statePath 'DATA_ATTACHED'

        $previousBackups = Join-VerifiedChild $previousRoot $backupRelative '旧备份目录'
        $activeBackups = Join-VerifiedChild $resolvedInstallRoot $backupRelative '新备份目录'
        Remove-PackagePlaceholder $activeBackups $resolvedInstallRoot '新包备份占位目录'
        Move-DirectoryExact $previousBackups $activeBackups '历史备份归位'
        $backupsAttached = $true
        Set-UpgradePhase $state $statePath 'BACKUPS_ATTACHED'

        $activeEnvironment = Join-VerifiedChild $resolvedInstallRoot $environmentRelative '激活环境配置'
        Set-UpgradePhase $state $statePath 'MIGRATION_STARTED'
        $databaseMutated = $true
        Invoke-Manager $resolvedInstallRoot 'Prepare' $activeEnvironment
        Set-UpgradePhase $state $statePath 'MIGRATION_APPLIED'

        Start-InstalledPlatform $resolvedInstallRoot $activeEnvironment $wasRunning
        $newStarted = $true
        Set-UpgradePhase $state $statePath 'TARGET_STARTED'

        Invoke-Manager $resolvedInstallRoot 'Doctor' $activeEnvironment
        Set-UpgradePhase $state $statePath 'TARGET_DOCTOR_PASSED'
        Wait-EntryHealth (Read-DotEnv $activeEnvironment)
        Set-UpgradePhase $state $statePath 'ENTRY_HEALTHY'

        if (-not $wasRunning) {
            Invoke-Manager $resolvedInstallRoot 'Stop' $activeEnvironment
            Set-UpgradePhase $state $statePath 'TARGET_STOPPED_TO_MATCH_SOURCE'
        }

        Set-UpgradePhase $state $statePath 'COMMITTED'
        Write-Host "离线升级完成：$sourceVersion -> $targetVersion"
        Write-Host "旧版本已保留：$previousRoot"
        Write-Host "升级恢复材料已保留：$transactionRecovery"
    } catch {
        $upgradeError = Get-SafeErrorMessage $_
        try { Set-UpgradePhase $state $statePath 'ROLLBACK_STARTED' $upgradeError } catch {}
        $rollbackFailures = [System.Collections.Generic.List[string]]::new()

        if ($newRootActivated -and (Test-Path -LiteralPath $resolvedInstallRoot -PathType Container)) {
            try {
                $activeEnvironment = Join-VerifiedChild $resolvedInstallRoot $environmentRelative '失败版本环境配置'
                if (Test-Path -LiteralPath $activeEnvironment -PathType Leaf) { Invoke-Manager $resolvedInstallRoot 'Stop' $activeEnvironment }
                $newStarted = $false
            } catch { $rollbackFailures.Add((Get-SafeErrorMessage $_)) }
        }

        if ($rollbackFailures.Count -eq 0 -and $newRootActivated) {
            try {
                $previousData = Join-VerifiedChild $previousRoot $dataRelative '回滚旧持久数据目录'
                $activeData = Join-VerifiedChild $resolvedInstallRoot $dataRelative '回滚新持久数据目录'
                if ($dataAttached -and (Test-Path -LiteralPath $activeData -PathType Container)) {
                    Move-DirectoryExact $activeData $previousData '回滚持久数据归位'
                    $dataAttached = $false
                }
                $previousBackups = Join-VerifiedChild $previousRoot $backupRelative '回滚旧备份目录'
                $activeBackups = Join-VerifiedChild $resolvedInstallRoot $backupRelative '回滚新备份目录'
                if ($backupsAttached -and (Test-Path -LiteralPath $activeBackups -PathType Container)) {
                    Move-DirectoryExact $activeBackups $previousBackups '回滚历史备份归位'
                    $backupsAttached = $false
                }
                Move-DirectoryExact $resolvedInstallRoot $failedRoot '失败新版本保留'
                $newRootActivated = $false
            } catch { $rollbackFailures.Add((Get-SafeErrorMessage $_)) }
        }

        if ($rollbackFailures.Count -eq 0 -and $oldRootRenamed) {
            try {
                if (-not (Test-Path -LiteralPath $resolvedInstallRoot)) {
                    Move-DirectoryExact $previousRoot $resolvedInstallRoot '旧版本目录反切'
                    $oldRootRenamed = $false
                }
            } catch { $rollbackFailures.Add((Get-SafeErrorMessage $_)) }
        }

        if ($rollbackFailures.Count -eq 0 -and $nativeBackupCreated -and $databaseMutated) {
            try {
                Invoke-Helper 'database-restore' @('--environment-file', $recoveryEnvironment, '--source', $nativeDatabaseBackup, '--confirm')
            } catch { $rollbackFailures.Add((Get-SafeErrorMessage $_)) }
        }

        if ($rollbackFailures.Count -eq 0 -and $wasRunning -and (Test-Path -LiteralPath $resolvedInstallRoot -PathType Container)) {
            try {
                $restoredEnvironment = Join-VerifiedChild $resolvedInstallRoot $environmentRelative '恢复环境配置'
                Start-InstalledPlatform $resolvedInstallRoot $restoredEnvironment $true
            } catch { $rollbackFailures.Add((Get-SafeErrorMessage $_)) }
        }

        if ($rollbackFailures.Count -eq 0) {
            try { Set-UpgradePhase $state $statePath 'ROLLED_BACK' $upgradeError } catch {}
            throw "离线升级失败，旧版本已恢复。恢复材料保留在：$transactionRecovery"
        }

        $rollbackSummary = ($rollbackFailures | Select-Object -First 3) -join '; '
        try { Set-UpgradePhase $state $statePath 'MANUAL_RECOVERY_REQUIRED' "$upgradeError; rollback: $rollbackSummary" } catch {}
        throw "离线升级失败且自动回滚未完成。请停止操作并使用保留材料人工恢复：$transactionRecovery"
    }
}

try {
    Invoke-OfflineUpgrade
} catch {
    Write-Error (Get-SafeErrorMessage $_)
    exit 1
} finally {
    if ($script:upgradeLockStream) {
        $script:upgradeLockStream.Dispose()
        $script:upgradeLockStream = $null
    }
}
