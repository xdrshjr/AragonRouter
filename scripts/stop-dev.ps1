#Requires -Version 5.1
<#
.SYNOPSIS
    AragonRouter 一键关闭开发服务器。

.DESCRIPTION
    执行流程：
      0. 获取本仓库的开发脚本互斥量（与 start-dev.ps1 共用同一把 System.Threading.Mutex），
         避免停机与启动互相穿插（例如刚删掉记录、启动脚本又写下新记录）；
      1. 读取 .dev-server.pid，用 `taskkill /PID <pid> /T /F` 结束整棵进程树
         （npm.cmd -> node -> next dev），并轮询确认进程真的退出；
      2. 读取 .dev-server.port 做端口兜底：若端口仍被监听，找出占用进程，
         **先确认它属于本仓库**（命令行或任一祖先进程指回仓库根目录，或位于已知 dev PID 的子树里）
         再杀，避免误杀其它项目同名的 node.exe，并等待端口释放；
      3. 未记录监听者兜底扫描（孤儿 dev server）：按端口区间（默认 3000 起 50 个）反查监听者，
         凡是**能证明属于本仓库**的 dev 进程一并结束。典型场景是并发启动留下的孤儿、或记录被
         误删而服务仍在跑 —— 旧实现会对这两种情况打印「开发服务器已停止」并退出 0；
         不属于本仓库的监听者只报告、绝不动手；
      4. 清理运行期产物 .dev-server.pid / .dev-server.port（-PurgeLogs 时连 .dev-logs 一起删除）；
      5. 幂等：没有在跑的实例、或重复执行时，打印说明并退出 0。

    安全边界（为什么不能只看进程名）：
      另一个项目的 `next start -p <同一端口>` 同样是 `node.exe`。只按名字放行时，如果本仓库上一次
      运行留下过 .dev-server.port 而进程已异常退出，本脚本就会静默杀掉那个项目。因此端口兜底击杀
      与区间扫描都一律要求“进程归属证据”，拿不到证据时只报告冲突（退出码 1）并要求人工处理 ——
      扫描中遇到的非本仓库进程只报告、不计入失败、不结束。

.PARAMETER Port
    额外兜底端口。省略时只使用 .dev-server.port 中记录的端口。

.PARAMETER PurgeLogs
    同时删除 .dev-logs 目录（默认保留日志，便于排查问题）。

.PARAMETER Quiet
    安静模式，仅输出错误与最终结果（供脚本调用）。

.PARAMETER ScanStartPort
    未记录监听者扫描区间的起点（默认与自动选端口的起点一致）。这不是把某个端口固定给开发服务，
    只是兜底扫描从哪个端口开始找。

.PARAMETER ScanSpan
    扫描区间的长度（默认 50 个端口）。区间内属于本仓库的 dev 进程会被结束。

.PARAMETER NoPortScan
    跳过区间扫描，只按 .dev-server.pid / .dev-server.port 停机（适合明确知道只停自己那一份的场景）。

.PARAMETER LockTimeoutSeconds
    等待启动互斥量的上限，默认 120 秒。超时说明另一个启动/停机流程仍在进行，脚本以退出码 1 结束，
    而不是在没有互斥保护的情况下删记录、杀进程。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stop-dev.ps1

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stop-dev.ps1 -PurgeLogs

.NOTES
    退出码：0 = 已停止或本来就没有在运行（幂等）；1 = 端口无法释放、等待互斥量超时或清理失败。
#>
[CmdletBinding()]
param(
    [ValidateRange(0, 65535)]
    [int]$Port = 0,

    [switch]$PurgeLogs,

    [switch]$Quiet,

    [ValidateRange(1, 65535)]
    [int]$ScanStartPort = 3000,

    [ValidateRange(1, 200)]
    [int]$ScanSpan = 50,

    [switch]$NoPortScan,

    [ValidateRange(5, 1800)]
    [int]$LockTimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'
try {
    $utf8 = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false
    [Console]::OutputEncoding = $utf8
} catch {
    # 忽略：编码设置失败不影响功能
}

. (Join-Path (Join-Path $PSScriptRoot 'lib') 'dev-common.ps1')

$ProjectRoot = Resolve-ProjectRoot -StartPath $PSScriptRoot
$artifacts = Get-DevArtifacts -ProjectRoot $ProjectRoot

# 允许结束的开发进程名。注意这只是**必要不充分**条件：真正的安全闸门是
# Get-ProcessOwnership 给出的“该进程属于本仓库”的证据（见下面 Stop-OwnedDevice 的使用处）。
# 仅凭进程名就把占用端口的任何 node.exe 杀掉，会误杀别的项目（例如另一仓库的 next start）。
$AllowedProcessNames = @('node', 'cmd', 'npm', 'npm.cmd')

# 进程快照按需加载一次：只有真的存在候选进程时才去查 CIM，幂等停机不付这个代价。
$script:SnapshotLoaded = $false
$script:Snapshot = $null

function Get-SnapshotCached {
    if (-not $script:SnapshotLoaded) {
        $script:Snapshot = Get-ProcessSnapshot
        $script:SnapshotLoaded = $true
    }
    return $script:Snapshot
}

function Get-OwnershipVerdict {
    <#
    .SYNOPSIS
        返回“该 PID 是否属于本仓库”的判定结果（含证据/原因）。
    #>
    param(
        [Parameter(Mandatory = $true)]
        [int]$ProcessId,
        [int[]]$KnownPids = @()
    )

    return Get-ProcessOwnership -Snapshot (Get-SnapshotCached) -ProcessId $ProcessId -ProjectRoot $ProjectRoot -KnownPids $KnownPids
}

function Write-Step {
    param([string]$Message)
    if (-not $Quiet) { Write-Host $Message }
}

function Stop-DevProcess {
    <#
    .SYNOPSIS
        结束指定 PID 的进程树并等待其消失。
    #>
    param(
        [Parameter(Mandatory = $true)]
        [int]$ProcessId,
        [switch]$QuietMode
    )

    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        if (-not $QuietMode) { Write-Step "PID $ProcessId 已不存在，跳过。" }
        return $false
    }

    if (-not $QuietMode) {
        Write-Step "结束进程树：PID=$ProcessId（$($process.ProcessName)）  taskkill /PID $ProcessId /T /F"
    }
    Stop-ProcessTree -ProcessId $ProcessId | Out-Null

    if (Wait-ProcessGone -ProcessId $ProcessId -TimeoutSeconds 10) { return $true }

    # 进程树里可能有子进程未被 /T 覆盖（例如已经脱离父进程的 node），再直接杀一次。
    if (-not $QuietMode) { Write-Step "PID $ProcessId 未在 10 秒内退出，尝试直接结束。" }
    $taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
    if (-not (Test-Path -LiteralPath $taskkill)) { $taskkill = 'taskkill.exe' }
    Invoke-NativeCommand -FilePath $taskkill -Arguments @('/PID', [string]$ProcessId, '/F') -MergeStderr | Out-Null
    return (Wait-ProcessGone -ProcessId $ProcessId -TimeoutSeconds 10)
}

$exitCode = 0
$stoppedAny = $false
$failures = @()
# 目标端口"仍在监听"这条失败先记账、收尾复查后再定论（见第 3b 步）。
$portNotReleasedFailure = $null
$devLock = $null
# 已经处理过的 PID：记录 PID 与端口兜底击杀过的进程都不再参与区间扫描，避免重复动手与重复报错。
$handledPids = New-Object System.Collections.Generic.List[int]

try {
    if (-not $Quiet) {
        Write-Host ''
        Write-Host 'AragonRouter 开发服务器停止器' -ForegroundColor Cyan
        Write-Host "项目根目录：$ProjectRoot"
    }

    # ---- 0) 与启动脚本互斥 ------------------------------------------------
    # 没有这把锁时，停机可能在启动脚本"刚写完记录、服务还没就绪"的窗口里把记录删掉，
    # 或者反过来在停机过程中被启动脚本覆盖记录 —— 两种都会留下对不上号的现场。
    Write-Step "获取启动互斥量（最多等待 $LockTimeoutSeconds 秒）..."
    $devLock = Enter-DevLock -ProjectRoot $ProjectRoot -TimeoutSeconds $LockTimeoutSeconds
    if (-not $devLock.Acquired) {
        throw ("等待启动互斥量超时（$LockTimeoutSeconds 秒，锁名 $($devLock.Name)）：另一个 start-dev.ps1 / stop-dev.ps1 正在处理本仓库的开发服务器。" +
            '本次没有停止任何进程。请等它结束后重试。')
    }
    if ($devLock.Abandoned -and -not $Quiet) {
        Write-Step '上一个持锁脚本被强制结束（锁由系统收回）：下面会同时依据 PID 记录与端口重新核对。'
    }

    # 记录的端口先算出来：判断 PID 文件的归属时，需要知道“这个进程是否正在服务我们记录的端口”。
    # 端口一律来自 .dev-server.port（-Port 可覆盖），不硬编码。
    $targetPort = 0
    if ($Port -gt 0) { $targetPort = $Port }
    else { $targetPort = Read-DevPort -Artifacts $artifacts }

    # ---- 1) 依据 PID 文件结束进程树 --------------------------------------
    $devPid = Read-DevPid -Artifacts $artifacts
    $recordedProcess = $null
    if ($devPid -gt 0) { $recordedProcess = Get-Process -Id $devPid -ErrorAction SilentlyContinue }

    # dev 进程的形状一定是 node/cmd/npm：名字对不上说明这个 PID 已被系统回收复用。
    $recordedPidIsDevShape = ($null -ne $recordedProcess) -and ($AllowedProcessNames -contains $recordedProcess.ProcessName)
    $knownPids = @()
    if ($recordedPidIsDevShape) { $knownPids = @($devPid) }

    if ($devPid -gt 0) {
        if ($null -eq $recordedProcess) {
            if (-not $Quiet) { Write-Step "PID 文件里的 PID $devPid 已不存在（上次运行异常退出），跳过击杀。" }
        }
        else {
            $ownership = $null
            if ($recordedPidIsDevShape) { $ownership = Get-OwnershipVerdict -ProcessId $devPid }

            $killAllowed = $false
            $blockReason = ''
            $ownershipNote = ''
            if (-not $recordedPidIsDevShape) {
                $blockReason = "PID 文件里的 PID $devPid 现在是 $($recordedProcess.ProcessName)，不是本仓库的 dev 进程（PID 已被系统回收复用）"
            }
            elseif (-not $ownership.SnapshotAvailable) {
                # 拿不到命令行时无法验证归属；PID 文件是本脚本上一次启动时写的，退回按 PID 处理，
                # 但把这一判断的依据打印出来，便于事后审计。
                $killAllowed = $true
                $ownershipNote = '（无法读取进程命令行，按 .dev-server.pid 记录处理）'
                if (-not $Quiet) { Write-Step '无法读取进程命令行（CIM/WMI 不可用），按 .dev-server.pid 记录的进程处理。' }
            }
            elseif ($ownership.Owned) {
                $killAllowed = $true
                $ownershipNote = "（归属证据：$($ownership.Evidence)）"
            }
            elseif (Test-ProcessServesPort -Snapshot (Get-SnapshotCached) -ProcessId $devPid -Port $targetPort) {
                # npm.cmd 的命令行里只有 nodejs 安装目录，没有仓库路径；但它正是记录端口上
                # 服务进程的祖先 —— 这同样足以证明它是本仓库的 dev server。
                $killAllowed = $true
                $ownershipNote = "（归属证据：它正在服务本仓库记录的端口 $targetPort）"
            }
            else {
                $blockReason = "无法确认 PID $devPid 属于本仓库（$($ownership.Reason)，且它没有在服务记录的端口 $targetPort）"
            }

            if ($killAllowed) {
                if ($devPid -gt 0) { $handledPids.Add($devPid) }
                if (Stop-DevProcess -ProcessId $devPid -QuietMode:$Quiet) {
                    $stoppedAny = $true
                    if (-not $Quiet) { Write-Host "已结束 PID $devPid 的进程树$ownershipNote。" -ForegroundColor Green }
                }
                else {
                    $alive = Get-Process -Id $devPid -ErrorAction SilentlyContinue
                    if ($null -ne $alive) {
                        $failures += "PID $devPid 仍在运行，无法结束。"
                    }
                }
            }
            elseif (-not $Quiet) {
                Write-Host "$blockReason，为安全起见不结束该进程（它很可能属于其它项目）。" -ForegroundColor Yellow
                Write-Step '只清理运行期产物；如果端口仍被占用，下面的端口检查会报告冲突。'
            }
        }
    }
    elseif (-not $Quiet) {
        Write-Step '未找到 .dev-server.pid（可能未启动或已被清理）。继续按端口做兜底检查。'
    }

    # ---- 2) 依据端口文件兜底击杀（必须确认进程属于本仓库） ---------------
    if ($targetPort -gt 0) {
        $owners = @(Get-PortOwnerPids -Port $targetPort)
        foreach ($owner in $owners) {
            if ($owner -le 4) { continue }
            $ownerProcess = Get-Process -Id $owner -ErrorAction SilentlyContinue
            if ($null -eq $ownerProcess) { continue }
            if ($owner -eq $devPid) { continue }
            if ($AllowedProcessNames -notcontains $ownerProcess.ProcessName) {
                if (-not $Quiet) {
                    Write-Host "端口 $targetPort 被非开发进程占用（PID=$owner，$($ownerProcess.ProcessName)），为安全起见跳过。" -ForegroundColor Yellow
                }
                $failures += "端口 $targetPort 被非开发进程（PID=$owner，$($ownerProcess.ProcessName)）占用，未结束该进程。"
                continue
            }

            # 关键安全闸门：名字是 node/cmd/npm 也可能属于别的仓库，必须有归属证据。
            $ownership = Get-OwnershipVerdict -ProcessId $owner -KnownPids $knownPids
            if (-not $ownership.Owned) {
                $hint = "请先确认该进程的真实主人：netstat -ano | findstr :$targetPort  ->  taskkill /PID $owner /T /F"
                if (-not $Quiet) {
                    Write-Host "端口 $targetPort 被不属于本仓库的进程占用（PID=$owner，$($ownerProcess.ProcessName)）：$($ownership.Reason)。" -ForegroundColor Yellow
                    Write-Host "  为避免误杀其它项目，已跳过；$hint" -ForegroundColor Yellow
                }
                $failures += "端口 $targetPort 被不属于本仓库的进程（PID=$owner，$($ownerProcess.ProcessName)）占用，未结束该进程。$hint"
                continue
            }

            if (-not $Quiet) {
                Write-Host "端口 $targetPort 的占用者 PID $owner（$($ownerProcess.ProcessName)）已确认属于本仓库：$($ownership.Evidence)。" -ForegroundColor DarkGray
            }
            $handledPids.Add($owner)
            if (Stop-DevProcess -ProcessId $owner -QuietMode:$Quiet) {
                $stoppedAny = $true
                if (-not $Quiet) { Write-Host "已结束占用端口 $targetPort 的进程 PID $owner。" -ForegroundColor Green }
            }
            else {
                $failures += "占用端口 $targetPort 的 PID $owner 无法结束。"
            }
        }

        if (Wait-PortFree -Port $targetPort -TimeoutSeconds 15) {
            if (-not $Quiet) { Write-Host "端口 $targetPort 已释放。" -ForegroundColor Green }
        }
        else {
            # 先记账，第 3b 步收尾复查会以"复查时的真实监听者"为准重新判定。
            # 进程树刚被 taskkill 时内核可能还没回收监听套接字；紧接着的区间扫描也会清掉
            # 未记录的孤儿 dev 进程 —— 这两件事都可能让这次轮询失败，却并不代表最终没释放。
            $portNotReleasedFailure = "端口 $targetPort 仍在监听，未能释放。"
            $failures += $portNotReleasedFailure
        }
    }
    elseif (-not $Quiet) {
        Write-Step '未找到 .dev-server.port（可能未启动或已被清理）。'
    }

    # ---- 3) 未记录监听者兜底扫描（孤儿 dev server） -----------------------
    # 记录只能描述"上一次正常收尾的运行"。并发启动留下的孤儿、记录被误删而服务仍在跑、
    # 或旧版本写坏记录时，只看记录就会打印"已停止"并退出 0，实际还有服务在占用端口与 .next。
    # 这里按端口区间反查监听者，仍然只对**有归属证据**的进程动手。
    if (-not $NoPortScan) {
        $scanEndPort = $ScanStartPort + $ScanSpan - 1
        if ($scanEndPort -gt 65535) { $scanEndPort = 65535 }
        $scanCandidates = @()
        try {
            $scanCandidates = @(Find-DevListenersInRange -ProjectRoot $ProjectRoot -StartPort $ScanStartPort -EndPort $scanEndPort -KnownPids $knownPids -AllowedProcessNames $AllowedProcessNames -ExcludePids $handledPids.ToArray())
        }
        catch {
            if (-not $Quiet) {
                Write-Host "端口区间扫描失败（不影响按记录停机）：$($_.Exception.Message)" -ForegroundColor Yellow
            }
            $scanCandidates = @()
        }

        $ownedCandidates = @($scanCandidates | Where-Object { $_.Owned -and $_.NameAllowed })
        if ($scanCandidates.Count -eq 0) {
            if (-not $Quiet) { Write-Step "端口区间 $ScanStartPort-$scanEndPort 内没有其它监听者。" }
        }
        else {
            foreach ($item in @($scanCandidates | Where-Object { -not ($_.Owned -and $_.NameAllowed) })) {
                if ($Quiet) { continue }
                $why = [string]$item.Reason
                if (-not $item.SnapshotAvailable) { $why = '无法读取进程命令行，不能确认归属' }
                elseif (-not $item.NameAllowed) { $why = "进程名 $($item.ProcessName) 不在 $([string]::Join('/', $AllowedProcessNames)) 之内" }
                Write-Host "扫描到端口 $($item.Port) 的监听者 PID $($item.ProcessId)（$($item.ProcessName)）：$why；跳过。" -ForegroundColor DarkGray
            }

            foreach ($item in $ownedCandidates) {
                if (-not $Quiet) {
                    Write-Host "扫描到未记录的监听者：端口 $($item.Port) / PID $($item.ProcessId)（$($item.ProcessName)）已确认属于本仓库：$($item.Evidence)。" -ForegroundColor DarkGray
                }
                $handledPids.Add($item.ProcessId)
                $ended = Stop-DevProcess -ProcessId $item.ProcessId -QuietMode:$Quiet
                if ($ended) {
                    $stoppedAny = $true
                    if (-not $Quiet) { Write-Host "已结束未记录的 dev 进程 PID $($item.ProcessId)（端口 $($item.Port)）。" -ForegroundColor Green }
                }
                else {
                    $alive = Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue
                    if ($null -ne $alive) {
                        $failures += "未记录的 dev 进程 PID $($item.ProcessId)（端口 $($item.Port)）仍在运行，无法结束。"
                        continue
                    }
                }

                # 端口是否真的空闲，要看"是否还有属于本仓库的监听者"，而不是"是否还有任何监听者"：
                # 同一个端口上完全可能同时存在别的程序（Windows 允许不同地址重叠绑定），
                # 把别人的监听算作我们的失败会让停机结果永远非 0，反而掩盖真正的问题。
                $stillOurs = @()
                try {
                    # 进程刚结束时内核可能还没回收监听套接字，稍等一下再判定。
                    Start-Sleep -Milliseconds 300
                    $stillOurs = @(Find-DevListenersInRange -ProjectRoot $ProjectRoot -StartPort $item.Port -EndPort $item.Port -AllowedProcessNames $AllowedProcessNames | Where-Object { $_.Owned -and $_.NameAllowed })
                }
                catch {
                    $stillOurs = @()
                }
                if ($stillOurs.Count -gt 0) {
                    $pids = [string]::Join(', ', @($stillOurs | ForEach-Object { $_.ProcessId }))
                    $failures += "端口 $($item.Port) 在结束 PID $($item.ProcessId) 后仍被本仓库的 dev 进程监听（PID $pids）。"
                }
                elseif (Test-PortInUse -Port $item.Port) {
                    if (-not $Quiet) {
                        Write-Host "端口 $($item.Port) 仍被不属于本仓库的进程占用（不是我们的服务，已跳过）。" -ForegroundColor DarkGray
                    }
                }
                else {
                    if (-not $Quiet) { Write-Host "端口 $($item.Port) 已释放。" -ForegroundColor Green }
                }
            }
        }
    }
    elseif (-not $Quiet) {
        Write-Step '已指定 -NoPortScan：跳过未记录监听者的区间扫描。'
    }

    # ---- 3b) 收尾复查：目标端口到底释放了没有 -----------------------------
    # 第 2 步的 Wait-PortFree 是"杀完之后立刻"的一次有限轮询，它失败并不等于最终没释放：
    #   * taskkill 结束一棵进程树后，内核回收监听套接字有延迟，Windows 上尤其明显；
    #   * 紧接着的第 3 步还会清掉未记录（记录里查不到）的孤儿 dev 进程 —— 它可能正是占着
    #     目标端口的那个。
    # 所以最终的退出码以这里为准，判据与第 3 步一致：
    #   端口上没有任何监听者                     -> 已释放；
    #   监听者全都能证明不属于本仓库（别人的服务） -> 不是我们的责任，不判失败（只报告）；
    #   仍有属于本仓库的 dev 监听者 / 归属无法判定 -> 保留失败，退出码 1。
    # 这样既不会因为"另一个项目的 next start 刚好占用了这个端口"而永远返回非 0，也不会在
    # 我们的 dev server 还活着时把停机报成成功。
    if ($targetPort -gt 0 -and $null -ne $portNotReleasedFailure -and $failures -contains $portNotReleasedFailure) {
        $remaining = @()
        try {
            $remaining = @(Find-DevListenersInRange -ProjectRoot $ProjectRoot -StartPort $targetPort -EndPort $targetPort -AllowedProcessNames $AllowedProcessNames)
        }
        catch {
            $remaining = @()
        }
        $stillOurs = @($remaining | Where-Object { $_.Owned })
        $undecidable = @($remaining | Where-Object { -not $_.Owned -and -not $_.SnapshotAvailable })
        if ($stillOurs.Count -eq 0 -and $undecidable.Count -eq 0) {
            $failures = @($failures | Where-Object { $_ -ne $portNotReleasedFailure })
            if (-not $Quiet) {
                if ($remaining.Count -eq 0) {
                    Write-Host "复查：端口 $targetPort 已释放（已无监听者）。" -ForegroundColor Green
                }
                else {
                    Write-Host "复查：端口 $targetPort 的监听者不属于本仓库，已跳过（不计为停机失败）。" -ForegroundColor DarkGray
                }
            }
        }
        elseif (-not $Quiet) {
            $evidencePids = @(($stillOurs + $undecidable) | ForEach-Object { "$($_.ProcessId)（$($_.ProcessName)）" })
            Write-Host "复查：端口 $targetPort 仍被 PID $([string]::Join('、', $evidencePids)) 监听，且无法证明它不属于本仓库。" -ForegroundColor Yellow
        }
    }

    # ---- 4) 清理运行期产物 -----------------------------------------------
    foreach ($path in @($artifacts.PidFile, $artifacts.PortFile)) {
        if (Test-Path -LiteralPath $path) {
            try {
                Remove-Item -LiteralPath $path -Force -ErrorAction Stop
                if (-not $Quiet) { Write-Step "已删除 $path" }
            }
            catch {
                $failures += "删除 $path 失败：$($_.Exception.Message)"
            }
        }
    }

    if ($PurgeLogs) {
        if (Test-Path -LiteralPath $artifacts.LogDir) {
            try {
                Remove-Item -LiteralPath $artifacts.LogDir -Recurse -Force -ErrorAction Stop
                if (-not $Quiet) { Write-Step "已删除日志目录 $($artifacts.LogDir)" }
            }
            catch {
                $failures += "删除日志目录失败：$($_.Exception.Message)"
            }
        }
    }
    elseif (-not $Quiet -and (Test-Path -LiteralPath $artifacts.LogDir)) {
        Write-Step "保留日志目录：$($artifacts.LogDir)（加 -PurgeLogs 可一并删除）"
    }

    # ---- 5) 汇总 ---------------------------------------------------------
    if ($failures.Count -gt 0) {
        Write-Host ''
        Write-Host '停止过程中出现问题：' -ForegroundColor Red
        foreach ($failure in $failures) { Write-Host "  - $failure" -ForegroundColor Red }
        $exitCode = 1
    }
    elseif (-not $Quiet) {
        Write-Host ''
        if ($stoppedAny) { Write-Host '开发服务器已停止。' -ForegroundColor Green }
        else { Write-Host '没有正在运行的开发服务器（无需停止）。' -ForegroundColor Green }
    }
}
catch {
    Write-Host ''
    Write-Host "停止失败：$($_.Exception.Message)" -ForegroundColor Red
    $exitCode = 1
}

# 退出前一定释放互斥量（不用 finally：PowerShell 在 try/finally 里 exit 会把退出码重置成 0）。
Exit-DevLock -Lock $devLock | Out-Null
$devLock = $null

exit $exitCode
