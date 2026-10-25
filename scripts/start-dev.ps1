#Requires -Version 5.1
<#
.SYNOPSIS
    AragonRouter 一键启动开发服务器（后台运行，就绪后打印 URL / PID / 日志路径）。

.DESCRIPTION
    执行流程：
      1. 硬校验 Node.js >= 22.5（node:sqlite 内置版本要求），并探活 node:sqlite；
      2. 获取本仓库的开发脚本互斥量（System.Threading.Mutex，见下），把「依赖安装 →
         .env.local 初始化 → 是否已在运行的判断 → 选端口 → 启动 → 写记录 → 就绪确认」
         整段变成临界区；
      3. 首次运行自动生成 .env.local（ADMIN_PASSWORD / SESSION_SECRET / ENCRYPTION_KEY /
         DATABASE_PATH），缺失或使用公开样例值时自动补齐，并打印管理口令；
      4. 依赖缺失（node_modules/next 不存在）时自动执行 npm install；
      5. 选择端口：未指定 -Port 时从 3000 起递增挑空闲端口，绝不硬编码；
      6. 后台启动 `npm run dev -- -p <port> -H 127.0.0.1`，写入 .dev-server.pid /
         .dev-server.port，输出重定向到 .dev-logs/dev.log / .dev-logs/dev.err.log；
      7. 轮询 HTTP 就绪（默认最长 120 秒），再**复查端口归属**：只有确认记录端口上的监听者
         确实是我们刚启动的进程树，才认为启动成功；
      8. 成功后打印访问地址、PID 与日志路径。

    并发安全（缺陷修复）：
      旧实现只用 .dev-server.pid / .dev-server.port 判断「是否已在运行」，而这两个文件在
      服务就绪后才写，也没有任何互斥。两次并发调用会各自拉起一个 next dev，后完成的那次
      覆盖记录，先前那个变成孤儿进程（仍监听端口、仍占用 .next），而 stop-dev.ps1 只按记录
      去杀，于是打印「开发服务器已停止」并退出 0 —— 静默把还在跑的服务报成已停止。
      现在同一仓库的所有启动/停机都串行在同一把命名互斥量上：
        * 先到者独占总个启动过程（含 npm install 与 .env.local 生成，避免并发写坏配置）；
        * 后到者在锁上等待，拿到锁后读到先到者写的记录并直接复用（打印「已在运行」）；
        * 等锁超时则明确报错退出（退出码 1），不会去启动第二个实例；
        * 写记录前再复查一次端口归属，避免把记录写在别人的服务上。
      互斥量名由项目根目录路径的 SHA-256 派生（Global\ 前缀，退回 Local\），同一仓库路径
      的任意数量终端窗口共用同一把锁，不同工作副本互不影响。

.PARAMETER Port
    指定端口。省略时自动从 3000 开始挑选空闲端口；指定但被占用则直接报错退出。

.PARAMETER SkipInstall
    依赖缺失时不自动执行 npm install，而是报错退出（适合 CI 或离线环境）。

.PARAMETER Foreground
    前台运行（Ctrl+C 停止）：仍然写 .dev-server.pid / .dev-server.port 并把 dev 输出落到
    .dev-logs/dev.log（C11 的三个运行期产物在前后台模式下都成立），同时把新增日志实时回显到控制台。

.PARAMETER TimeoutSeconds
    就绪等待上限，默认 120 秒。

.PARAMETER LockTimeoutSeconds
    等待启动互斥量的上限，默认 300 秒。
    同一仓库已有另一份 start-dev.ps1（或 stop-dev.ps1）持锁时，本次调用会等它结束再继续：
    等到了就复用先到者启动的实例；等超时则报错退出（退出码 1），绝不会启动第二个实例。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-dev.ps1

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-dev.ps1 -Port 3100 -SkipInstall

.NOTES
    退出码：
      0 = 已就绪（或本来就有一个可复用的实例）；
      1 = 校验失败 / 启动失败 / 等待启动互斥量超时。
#>
[CmdletBinding()]
param(
    [ValidateRange(0, 65535)]
    [int]$Port = 0,

    [switch]$SkipInstall,

    [switch]$Foreground,

    [ValidateRange(5, 900)]
    [int]$TimeoutSeconds = 120,

    [ValidateRange(5, 3600)]
    [int]$LockTimeoutSeconds = 300
)

$ErrorActionPreference = 'Stop'
try {
    $utf8 = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false
    [Console]::OutputEncoding = $utf8
} catch {
    # 控制台编码设置失败不影响功能
}

. (Join-Path (Join-Path $PSScriptRoot 'lib') 'dev-common.ps1')

$ProjectRoot = Resolve-ProjectRoot -StartPath $PSScriptRoot
$artifacts = Get-DevArtifacts -ProjectRoot $ProjectRoot
$MinimumNodeVersion = [version]'22.5.0'

# 孤儿 dev server 兜底扫描区间。这里只是"起点 + 跨度"，不是把某个端口当成开发端口：
# 真正的端口始终来自 Find-FreePort 的选择或 .dev-server.port 的记录。
$ScanStartPort = 3000
$ScanSpan = 50

function Write-Info {
    param([string]$Message)
    Write-Host $Message
}

function Write-Ok {
    param([string]$Message)
    Write-Host $Message -ForegroundColor Green
}

function Write-Warn {
    param([string]$Message)
    Write-Host $Message -ForegroundColor Yellow
}

function Test-ChildExited {
    <#
    .SYNOPSIS
        安全地判断子进程是否已退出（进程对象被释放后访问 HasExited 会抛异常）。
    #>
    param($Process)
    if ($null -eq $Process) { return $true }
    try { return [bool]$Process.HasExited } catch { return $true }
}

function Get-ChildExitCode {
    param($Process)
    if ($null -eq $Process) { return 1 }
    try { return [int]$Process.ExitCode } catch { return 1 }
}

function Assert-NodeRuntime {
    <#
    .SYNOPSIS
        硬校验 Node.js 版本 >= 22.5，并确认 node:sqlite 可用。
    #>
    $nodeExe = Get-NodeExecutable
    $probe = Invoke-NativeCommand -FilePath $nodeExe -Arguments @('-p', 'process.versions.node') -MergeStderr
    $versionText = ''
    foreach ($line in $probe.Output) {
        $candidate = $line.Trim()
        if ($candidate -match '^\d+\.\d+\.\d+$') { $versionText = $candidate; break }
    }
    if ($probe.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($versionText)) {
        throw "无法读取 Node.js 版本（exit=$($probe.ExitCode)）。输出：$([string]::Join(' ', $probe.Output))"
    }

    $nodeVersion = $null
    try { $nodeVersion = [version]$versionText } catch { $nodeVersion = $null }
    if ($null -eq $nodeVersion) {
        throw "无法解析 Node.js 版本号 '$versionText'。请安装 Node.js 22.5 或更高版本。"
    }
    if ($nodeVersion -lt $MinimumNodeVersion) {
        throw @"
Node.js 版本过低：当前 $versionText，AragonRouter 要求 >= 22.5（网关内的 SQLite 数据层依赖内置的 node:sqlite 模块）。
升级方式（任选其一）：
  * 官网下载 LTS 安装包覆盖安装：https://nodejs.org/zh-cn/download
  * winget：  winget upgrade --id OpenJS.NodeJS.LTS
  * nvm-windows：nvm install 22.5.0 ; nvm use 22.5.0
升级后请重开终端再运行本脚本。
"@
    }

    # node:sqlite 在 22.5/22.6 等版本仍可能被 --experimental-sqlite 门控，这里显式探活。
    $sqliteProbe = Invoke-NativeCommand -FilePath $nodeExe -Arguments @(
        '-e',
        'try{require("node:sqlite");process.stdout.write("ARAGON_SQLITE_OK")}catch(e){process.stdout.write("ARAGON_SQLITE_MISSING")}'
    ) -MergeStderr
    $joined = [string]::Join(' ', $sqliteProbe.Output)
    if ($joined -notmatch 'ARAGON_SQLITE_OK') {
        throw @"
当前 Node.js ($versionText) 无法加载内置模块 node:sqlite，网关的数据层无法工作。
处理方式（任选其一）：
  * 升级到 22.13+/23+ 等已默认启用 node:sqlite 的版本：https://nodejs.org/zh-cn/download
  * 或使用带实验开关的启动方式：set NODE_OPTIONS=--experimental-sqlite 后重新运行本脚本
探活输出：$joined
"@
    }

    return [pscustomobject]@{ Executable = $nodeExe; Version = $versionText }
}

function Get-AdminPasswordVerdict {
    <#
    .SYNOPSIS
        判断 .env.local 里已有的 ADMIN_PASSWORD 是否可用。
    .DESCRIPTION
        按**强度与结构**判断，而不是只比对一份占位符名单：名单式判断在边界上会给出误导性诊断 ——
        一个 8~23 字符、恰好不在名单里的弱口令会被当成“可用”而不再生成，随后 admin/session 以
        400 'password is required' / 401 'invalid password' 拒登，操作员只看到 .env.local 存在，
        以为环境没问题。这里逐条给出原因，调用方据此重新生成并把原因打印出来。

        结构类规则同样重要：值里出现换行、引号或 `#` 时，dotenv 解析出来的值与生成值不一致，
        登录必然失败，而这与“口令是否正确”看起来毫无关系。
    #>
    [CmdletBinding()]
    param(
        [string]$Password,
        [string[]]$PublicPlaceholders = @(),
        [int]$MinimumLength = 12,
        [int]$MaximumLength = 256
    )

    if ([string]::IsNullOrEmpty($Password)) {
        return [pscustomobject]@{ Usable = $false; Reason = '为空' }
    }
    if ($Password -ne $Password.Trim()) {
        return [pscustomobject]@{ Usable = $false; Reason = '首尾含空白字符（读到后与网关比对不一致）' }
    }
    if ($Password.Length -lt $MinimumLength) {
        return [pscustomobject]@{ Usable = $false; Reason = "只有 $($Password.Length) 个字符，低于脚本要求的 $MinimumLength 位下限（弱口令，且网关登录可能不稳定）" }
    }
    if ($Password.Length -gt $MaximumLength) {
        return [pscustomobject]@{ Usable = $false; Reason = "长度 $($Password.Length) 超过 $MaximumLength 个字符，疑似粘贴了错误内容" }
    }
    if ($Password -match '[\x00-\x1f]') {
        return [pscustomobject]@{ Usable = $false; Reason = '含控制字符（换行/制表符会截断 .env.local 里的值）' }
    }
    if ($Password -match '["#''=]') {
        return [pscustomobject]@{ Usable = $false; Reason = '含有 " # '' = 之一（.env.local 解析会截断或改变取值）' }
    }
    if ($PublicPlaceholders -contains $Password.ToLowerInvariant()) {
        return [pscustomobject]@{ Usable = $false; Reason = '仍是模板里的公开占位值' }
    }
    return [pscustomobject]@{ Usable = $true; Reason = '' }
}

function Initialize-EnvLocal {
    <#
    .SYNOPSIS
        首次运行生成 .env.local，或修补缺失/不安全/结构上不可用的字段。
    .DESCRIPTION
        判断标准与 .env.example 一致：
          ADMIN_PASSWORD  非空、>= 12 个字符、无引号/井号/控制字符，且不是模板占位值
                          （按强度判断，不再只看占位符名单：见 Get-AdminPasswordVerdict）；
          SESSION_SECRET  至少 32 个字符，且不是模板占位值；
          ENCRYPTION_KEY  恰好 64 位十六进制，且不是公开的全零样例；
          DATABASE_PATH   缺失时写入默认值 ./data/aragon.db。
        写入后会把文件读回来核对取值（round-trip），确保 dotenv 看到的就是生成的值。
    #>
    param(
        [Parameter(Mandatory = $true)]
        $Artifacts
    )

    $existing = Read-EnvFile -Path $Artifacts.EnvFile
    $fileExists = Test-Path -LiteralPath $Artifacts.EnvFile
    $updates = [ordered]@{}
    $generatedKeys = @()
    $generatedPassword = ''
    $passwordWasReplaced = $false
    $passwordReplaceReason = ''

    $password = ''
    if ($existing.Contains('ADMIN_PASSWORD')) { $password = [string]$existing['ADMIN_PASSWORD'] }
    $passwordPlaceholders = @('change-me-in-env-local', 'changeme', 'password', 'admin', 'replace-me', 'your-password-here')
    $verdict = Get-AdminPasswordVerdict -Password $password -PublicPlaceholders $passwordPlaceholders
    if (-not $verdict.Usable) {
        $generatedPassword = New-RandomBase64Url -ByteCount 18
        $updates['ADMIN_PASSWORD'] = $generatedPassword
        $generatedKeys += 'ADMIN_PASSWORD'
        if (-not [string]::IsNullOrEmpty($password)) {
            $passwordWasReplaced = $true
            $passwordReplaceReason = $verdict.Reason
        }
    }

    $secret = ''
    if ($existing.Contains('SESSION_SECRET')) { $secret = [string]$existing['SESSION_SECRET'] }
    if ($secret.Length -lt 32 -or $secret.StartsWith('replace-me')) {
        $updates['SESSION_SECRET'] = New-RandomBase64Url -ByteCount 48
        $generatedKeys += 'SESSION_SECRET'
    }

    $encryptionKey = ''
    if ($existing.Contains('ENCRYPTION_KEY')) { $encryptionKey = [string]$existing['ENCRYPTION_KEY'] }
    $zeroKey = ('0' * 64)
    if (-not ($encryptionKey -match '^[0-9a-fA-F]{64}$') -or $encryptionKey -eq $zeroKey) {
        $updates['ENCRYPTION_KEY'] = New-RandomHex -ByteCount 32
        $generatedKeys += 'ENCRYPTION_KEY'
    }

    $databasePath = ''
    if ($existing.Contains('DATABASE_PATH')) { $databasePath = [string]$existing['DATABASE_PATH'] }
    if ([string]::IsNullOrWhiteSpace($databasePath)) {
        $updates['DATABASE_PATH'] = './data/aragon.db'
        $generatedKeys += 'DATABASE_PATH'
    }

    if ($updates.Count -gt 0) {
        Set-EnvValues -Path $Artifacts.EnvFile -Values $updates
    }

    # round-trip 校验：写进去的值必须能被 dotenv 风格的读取器原样读回来。
    # 少了这一步，像 " 口令/含 # 的口令" 这类结构问题会拖到登录时才以 "invalid password" 暴露。
    $reread = Read-EnvFile -Path $Artifacts.EnvFile
    foreach ($key in @('ADMIN_PASSWORD', 'SESSION_SECRET', 'ENCRYPTION_KEY')) {
        if (-not $updates.Contains($key)) { continue }
        $written = [string]$updates[$key]
        $readBack = ''
        if ($reread.Contains($key)) { $readBack = [string]$reread[$key] }
        if ($readBack -ne $written) {
            throw ".env.local 写入后回读不一致（$key）：写入值长度 $($written.Length)，回读长度 $($readBack.Length)。请检查该文件是否被其它程序同时修改或包含异常字符。"
        }
    }

    $effectivePassword = $password
    if ($generatedPassword.Length -gt 0) { $effectivePassword = $generatedPassword }

    return [pscustomobject]@{
        FileExisted           = $fileExists
        Updated               = ($updates.Count -gt 0)
        GeneratedKeys         = $generatedKeys
        GeneratedPassword     = $generatedPassword
        PasswordWasReplaced   = $passwordWasReplaced
        PasswordReplaceReason = $passwordReplaceReason
        AdminPassword         = $effectivePassword
        EnvFile               = $Artifacts.EnvFile
    }
}

function Write-EnvBanner {
    param($EnvResult)

    if (-not $EnvResult.Updated) {
        Write-Info "环境变量：使用现有 .env.local（未改动）。查看管理口令：Get-Content .env.local"
        return
    }

    Write-Host ''
    Write-Host '============================================================' -ForegroundColor Cyan
    if (-not $EnvResult.FileExisted) {
        Write-Host ' 已创建 .env.local（首次运行，已自动生成密钥）' -ForegroundColor Cyan
    }
    else {
        Write-Host ' 已修补 .env.local（补齐缺失或不安全的字段）' -ForegroundColor Cyan
    }
    Write-Host '------------------------------------------------------------' -ForegroundColor Cyan
    if ($EnvResult.GeneratedPassword.Length -gt 0) {
        if ($EnvResult.PasswordWasReplaced) {
            Write-Host "  管理口令 ADMIN_PASSWORD : $($EnvResult.GeneratedPassword)（已重新生成）" -ForegroundColor Yellow
            Write-Host "  原口令不可用，原因：$($EnvResult.PasswordReplaceReason)" -ForegroundColor Yellow
            Write-Host '  旧口令已失效，请用上面的新口令登录（若仍被拒绝，删除 .env.local 后重新运行本脚本）。' -ForegroundColor Yellow
        }
        else {
            Write-Host "  管理口令 ADMIN_PASSWORD : $($EnvResult.GeneratedPassword)" -ForegroundColor Yellow
        }
    }
    else {
        Write-Info '  管理口令 ADMIN_PASSWORD : 沿用 .env.local 中已有值'
    }
    foreach ($key in $EnvResult.GeneratedKeys) {
        if ($key -eq 'ADMIN_PASSWORD') { continue }
        switch ($key) {
            'SESSION_SECRET' { Write-Info '  会话签名 SESSION_SECRET : 已生成（48 字节随机，base64url）' }
            'ENCRYPTION_KEY' { Write-Info '  加密密钥 ENCRYPTION_KEY : 已生成（32 字节随机，64 位十六进制）' }
            'DATABASE_PATH' { Write-Info '  数据库   DATABASE_PATH  : ./data/aragon.db' }
            default { Write-Info "  $key : 已生成" }
        }
    }
    Write-Host '------------------------------------------------------------' -ForegroundColor Cyan
    Write-Info " 配置文件：$($EnvResult.EnvFile)"
    Write-Info ' 该文件已被 .gitignore 覆盖，请勿提交；丢失口令时删除该文件重新运行本脚本。'
    Write-Host '============================================================' -ForegroundColor Cyan
    Write-Host ''
}

function Reset-DevEnvironment {
    <#
    .SYNOPSIS
        清理从父进程继承、但必须由 .env.local 提供的环境变量，保证 dev server 的配置可预测。
    .DESCRIPTION
        两个坑都会表现成“口令明明写在 .env.local 里，却登录不上”：
          1. NODE_ENV：从测试运行器（vitest 会设 NODE_ENV=test）或 CI 继承的 NODE_ENV 会让
             Next.js 跳过 .env.local（@next/env 在 test 环境下不加载该文件），管理口令随即变成
             未定义，所有登录请求都 401 —— 现场看起来像口令错了，实际是配置文件根本没被读。
          2. 网关自身的四个变量：dotenv 不会覆盖已存在的进程环境变量，父进程里的同名残留会悄悄
             盖住 .env.local。
        返回被清理掉的变量说明（给操作员一条可追踪的警告）。
    #>
    [CmdletBinding()]
    param()

    $normalized = @()
    $nodeEnv = [Environment]::GetEnvironmentVariable('NODE_ENV', 'Process')
    if (-not [string]::IsNullOrWhiteSpace($nodeEnv) -and $nodeEnv -ne 'development') {
        [Environment]::SetEnvironmentVariable('NODE_ENV', $null, 'Process')
        $normalized += "NODE_ENV=$nodeEnv"
    }
    foreach ($name in @('ADMIN_PASSWORD', 'SESSION_SECRET', 'ENCRYPTION_KEY', 'DATABASE_PATH')) {
        $value = [Environment]::GetEnvironmentVariable($name, 'Process')
        if ([string]::IsNullOrEmpty($value)) { continue }
        [Environment]::SetEnvironmentVariable($name, $null, 'Process')
        $normalized += $name
    }
    return , $normalized
}

function Assert-Dependencies {
    param(
        [Parameter(Mandatory = $true)]
        $Artifacts,
        [switch]$SkipInstallFlag
    )

    if (Test-Path -LiteralPath $Artifacts.NextPackageFile) { return }

    if ($SkipInstallFlag) {
        throw "依赖缺失：$($Artifacts.NextPackageFile) 不存在。已指定 -SkipInstall，请先手动执行 'npm install' 后重试。"
    }

    $npmExe = Get-NpmExecutable
    Write-Info "依赖未安装（未找到 node_modules\next），正在执行 npm install（首次安装可能需要几分钟）..."
    Write-Info "  $npmExe install --no-audit --no-fund"

    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $npmExit = 0
    try {
        Push-Location -LiteralPath $Artifacts.Root
        & $npmExe install --no-audit --no-fund 2>&1 | ForEach-Object { Write-Host ("  " + [string]$_) }
        $npmExit = $LASTEXITCODE
    }
    finally {
        Pop-Location
        $ErrorActionPreference = $previous
    }

    if ($npmExit -ne 0) {
        throw "npm install 失败（exit=$npmExit）。请检查网络/代理后重试，或手动执行 npm install。"
    }
    if (-not (Test-Path -LiteralPath $Artifacts.NextPackageFile)) {
        throw 'npm install 执行完成，但仍未找到 node_modules\next，请检查 package.json 与网络。'
    }
    Write-Ok '依赖安装完成。'
}

function Remove-StaleArtifacts {
    param($Artifacts)

    foreach ($path in @($Artifacts.PidFile, $Artifacts.PortFile)) {
        if (Test-Path -LiteralPath $path) {
            try { Remove-Item -LiteralPath $path -Force -ErrorAction Stop } catch { }
        }
    }
}

function Get-RunningDevServer {
    <#
    .SYNOPSIS
        返回当前记录在案的开发服务器信息；进程已退出、归属不明或端口未就绪时返回 $null。
    .DESCRIPTION
        必须验证归属：PID 会被系统回收复用，如果 .dev-server.pid 里的 PID 现在属于别的程序，
        而我们只凭“PID 存在 + 端口能连上”就断言“已在运行”，就会把别人的服务当成自己的。
        还要验证“记录的端口确实由记录的那个进程树在服务”：记录只是文件，上一次运行被打断时
        完全可能留下“端口已释放、记录还在”或“端口被别人抢走”的组合。
    #>
    param($Artifacts)

    $devPid = Read-DevPid -Artifacts $Artifacts
    if ($devPid -le 0) { return $null }
    $process = Get-Process -Id $devPid -ErrorAction SilentlyContinue
    if ($null -eq $process) { return $null }
    $devPort = Read-DevPort -Artifacts $Artifacts
    if ($devPort -le 0) { return $null }
    $url = "http://127.0.0.1:$devPort"
    if (-not (Test-HttpReady -Url "$url/api/admin/session" -TimeoutSec 3)) { return $null }

    $snapshot = Get-ProcessSnapshot
    $ownership = Get-ProcessOwnership -Snapshot $snapshot -ProcessId $devPid -ProjectRoot $ProjectRoot
    $servesPort = Test-ProcessServesPort -Snapshot $snapshot -ProcessId $devPid -Port $devPort

    if ($ownership.SnapshotAvailable -and -not $ownership.Owned -and -not $servesPort) {
        Write-Warn "忽略 .dev-server.pid：PID $devPid 无法确认属于本仓库（$($ownership.Reason)）。"
        return $null
    }

    # 记录端口上的监听者必须是记录 PID 的进程树：否则这条记录描述的不是"我们的"服务，
    # 复用它会给出一个错误的 URL，也会让后面的停止逻辑找错目标。
    if ($ownership.SnapshotAvailable -and -not $servesPort) {
        $owners = @(Get-PortOwnerPids -Port $devPort)
        if ($owners.Count -gt 0) {
            Write-Warn "忽略 .dev-server.pid：记录的端口 $devPort 由 PID $([string]::Join(', ', $owners)) 监听，不在记录 PID $devPid 的进程树内（记录已过期）。"
            return $null
        }
    }

    return [pscustomobject]@{ ProcessId = $devPid; Port = $devPort; Url = $url; ProcessName = $process.ProcessName }
}

function Write-OrphanWarning {
    <#
    .SYNOPSIS
        报告"未记录但可能属于本仓库"的监听进程（孤儿 dev server 兜底提示）。
    .DESCRIPTION
        出现这种进程说明上一次运行没有走正常退出路径（记录被删、进程树被打断，或旧版本并发
        启动留下的孤儿）。启动脚本不替操作员做决定 —— 不静默杀掉未知进程 —— 但必须把它说出来，
        否则运维看到的仍是"一切正常"，实际却有两台服务在跑。
    #>
    param(
        [int[]]$ExcludePids = @()
    )

    $endPort = $ScanStartPort + $ScanSpan - 1
    if ($endPort -gt 65535) { $endPort = 65535 }
    $found = @()
    try {
        $found = @(Find-DevListenersInRange -ProjectRoot $ProjectRoot -StartPort $ScanStartPort -EndPort $endPort -ExcludePids $ExcludePids)
    }
    catch {
        Write-Warn "扫描 $ScanStartPort-$endPort 范围时出错（不影响启动）：$($_.Exception.Message)"
        return @()
    }

    $owned = @($found | Where-Object { $_.Owned -and $_.NameAllowed })
    if ($owned.Count -eq 0) { return @() }

    Write-Host ''
    Write-Warn "检测到 $($owned.Count) 个未记录（不在 .dev-server.pid / .dev-server.port 里）的监听进程可能属于本仓库："
    foreach ($item in $owned) {
        Write-Warn "  - 端口 $($item.Port) / PID $($item.ProcessId)（$($item.ProcessName)）：$($item.Evidence)"
    }
    Write-Warn '  它们不是本次启动的实例，很可能是上一次运行留下的孤儿 dev server。'
    Write-Warn '  scripts\stop-dev.ps1 会把它们（以及本次启动的实例）一并清理。'
    Write-Host ''
    return $owned
}

function Confirm-PortOwnership {
    <#
    .SYNOPSIS
        写记录前的归属复查：确认记录端口上的监听者确实是我们刚启动的那个进程树。
    .DESCRIPTION
        只凭"Start-Process 返回了 PID + HTTP 探活成功"就写 .dev-server.pid/.dev-server.port 是不够的：
        HTTP 探活可能命中别人的服务（端口被抢），Start-Process 的 PID 也可能已退出而端口被新进程
        复用。记录一旦写错，后续 stop-dev.ps1 就会对着错误目标工作。这里要求二选一：
          * 端口监听者位于我们刚启动的 PID 的进程树内（npm.cmd -> node -> next）；或
          * 监听者能给出属于本仓库的归属证据（命令行/祖先指回仓库根目录）。
        两者都不成立时返回 Owned=$false，调用方必须放弃而不是把错误记录写下去。
    #>
    param(
        [Parameter(Mandatory = $true)]
        [int]$Port,
        [Parameter(Mandatory = $true)]
        [int]$ProcessId
    )

    $owners = @(Get-PortOwnerPids -Port $Port)
    $result = [pscustomobject]@{
        Port     = $Port
        Owners   = $owners
        Owned    = $false
        Reason   = ''
        Evidence = ''
    }

    if ($owners.Count -eq 0) {
        $result.Reason = "端口 $Port 上没有任何监听者（服务可能已退出，或监听了别的端口）"
        return $result
    }
    if ($owners -contains $ProcessId) {
        $result.Owned = $true
        $result.Evidence = "端口 $Port 的监听者就是 PID $ProcessId"
        return $result
    }

    $snapshot = Get-ProcessSnapshot
    if (Test-ProcessServesPort -Snapshot $snapshot -ProcessId $ProcessId -Port $Port) {
        $result.Owned = $true
        $result.Evidence = "端口 $Port 的监听者 PID $([string]::Join(', ', $owners)) 位于 PID $ProcessId 的进程树内"
        return $result
    }

    foreach ($owner in $owners) {
        $verdict = Get-ProcessOwnership -Snapshot $snapshot -ProcessId $owner -ProjectRoot $ProjectRoot -KnownPids @($ProcessId)
        if ($verdict.Owned) {
            $result.Owned = $true
            $result.Evidence = "端口 $Port 的监听者 PID $owner 属于本仓库：$($verdict.Evidence)"
            return $result
        }
    }

    $result.Reason = "端口 $Port 的监听者是 PID $([string]::Join(', ', $owners))，既不是刚启动的 PID $ProcessId，也无法证明属于本仓库"
    return $result
}


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
$exitCode = 0
$devLock = $null
try {
    Write-Host ''
    Write-Host 'AragonRouter 开发服务器启动器' -ForegroundColor Cyan
    Write-Info "项目根目录：$ProjectRoot"

    Write-Info '检查 Node.js 运行时...'
    $node = Assert-NodeRuntime
    Write-Ok "Node.js $($node.Version) 满足要求（>= $MinimumNodeVersion）。"

    # ---- 临界区开始 -------------------------------------------------------
    # 「依赖安装 + .env.local 生成 + 是否已在运行 + 选端口 + 启动 + 写记录」必须整体互斥：
    # 只要其中任何一步能被并发执行，就会出现两份实例或两份不同的 .env.local。
    Write-Info "获取启动互斥量（同一仓库串行启动；最多等待 $LockTimeoutSeconds 秒）..."
    $devLock = Enter-DevLock -ProjectRoot $ProjectRoot -TimeoutSeconds $LockTimeoutSeconds
    if (-not $devLock.Acquired) {
        throw ("等待启动互斥量超时（$LockTimeoutSeconds 秒，锁名 $($devLock.Name)）：另一个 start-dev.ps1 或 stop-dev.ps1 正在处理本仓库的开发服务器。" +
            '本次调用没有启动任何进程。请稍后重试；若确认没有别的脚本在运行，先执行 scripts\stop-dev.ps1 再重试。')
    }
    if ($devLock.WaitedMs -ge 500) {
        Write-Info "  等待 $($devLock.WaitedMs) ms 后拿到锁：另一个实例刚刚结束，下面会按它写下的记录判断是否需要启动。"
    }
    if ($devLock.Abandoned) {
        Write-Warn '  上一次持锁的脚本被强制结束（锁由系统收回）：.dev-server.pid / .dev-server.port 可能已过期，下面会重新核对。'
    }

    Write-Info '检查依赖...'
    Assert-Dependencies -Artifacts $artifacts -SkipInstallFlag:$SkipInstall

    Write-Info '检查 .env.local...'
    $envResult = Initialize-EnvLocal -Artifacts $artifacts
    Write-EnvBanner -EnvResult $envResult

    # 继承来的环境变量会让“配置文件里的值”失效，必须在启动 server 之前清掉。
    $normalizedNames = Reset-DevEnvironment
    if ($normalizedNames.Count -gt 0) {
        Write-Warn ("已忽略从父进程继承的变量（开发服务器一律以 .env.local 为准）：" + [string]::Join(', ', $normalizedNames))
    }
    $env:NEXT_TELEMETRY_DISABLED = '1'

    # 已有实例在运行时直接复用，保证脚本幂等。
    $running = Get-RunningDevServer -Artifacts $artifacts
    if ($null -ne $running) {
        Write-Ok "开发服务器已在运行，无需重复启动。"
        Write-Info "  URL      : $($running.Url)"
        Write-Info "  PID      : $($running.ProcessId)（$($running.ProcessName)）"
        Write-Info "  端口文件 : $($artifacts.PortFile)（$($running.Port)）"
        Write-Info "  日志     : $($artifacts.LogFile)"

        # 复用前先自检：实例是用旧环境启动的时候，口令登录会一直失败，
        # 而操作员只会看到“口令明明写在 .env.local 里”。这里直接把原因说出来。
        if ($envResult.AdminPassword.Length -gt 0) {
            $loginBody = @{ password = $envResult.AdminPassword } | ConvertTo-Json -Compress
            $loginProbe = Invoke-HttpRequest -Method POST -Url "$($running.Url)/api/admin/session" -Body $loginBody -TimeoutSec 15
            if ($loginProbe.Status -ne 200) {
                Write-Warn "警告：这个实例不接受当前 .env.local 里的 ADMIN_PASSWORD（HTTP $($loginProbe.Status)）。"
                Write-Warn '      通常是它用旧环境启动过（例如继承了 NODE_ENV=test，Next 会跳过 .env.local）。'
                Write-Warn '      处理：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stop-dev.ps1 后重新运行本脚本。'
            }
            else {
                Write-Ok '  自检     : 当前 .env.local 的管理口令可正常登录。'
            }
        }

        Write-Info '  停止     : powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stop-dev.ps1'
        Exit-DevLock -Lock $devLock | Out-Null
        $devLock = $null
        exit 0
    }
    Remove-StaleArtifacts -Artifacts $artifacts

    # 孤儿 dev server 提示：记录里没有、但本仓库的 dev 进程正在监听区间内的端口。
    # 不静默杀掉（那是别人可能在用的服务），但必须让操作员看见 —— 这正是旧实现"假成功"的根源。
    Write-OrphanWarning | Out-Null

    # 端口选择：不硬编码 3000。
    $targetPort = 0
    if ($Port -gt 0) {
        if (Test-PortInUse -Port $Port) {
            throw "端口 $Port 已被占用。请换一个 -Port，或省略 -Port 让脚本自动从 3000 起挑选空闲端口。"
        }
        if (-not (Test-PortBindable -Port $Port)) {
            throw "端口 $Port 无法绑定（可能被系统保留）。请换一个端口。"
        }
        $targetPort = $Port
        Write-Ok "使用指定端口：$targetPort"
    }
    else {
        $targetPort = Find-FreePort -StartPort 3000 -Attempts 50
        if ($targetPort -le 0) {
            throw '在 3000-3049 范围内没有找到空闲端口，请用 -Port 指定一个可用端口。'
        }
        Write-Ok "自动选择空闲端口：$targetPort（从 3000 起递增探测）"
    }

    $npmExe = Get-NpmExecutable
    $baseUrl = "http://127.0.0.1:$targetPort"
    $npmArguments = @('run', 'dev', '--', '-p', [string]$targetPort, '-H', '127.0.0.1')

    # 复查端口（在锁内、真正启动之前）：选端口与启动之间若有别的进程抢占，next 会自己挑一个
    # 别的端口启动，而我们随后记录的就是一个假的端口号。
    if (Test-PortInUse -Port $targetPort) {
        throw "端口 $targetPort 在启动前被其它进程占用（可能发生了端口竞争）。请重试；若持续出现，用 -Port 指定另一个端口。"
    }

    if ($Foreground) {
        New-Item -ItemType Directory -Path $artifacts.LogDir -Force | Out-Null
        foreach ($logPath in @($artifacts.LogFile, $artifacts.ErrLogFile)) {
            if (Test-Path -LiteralPath $logPath) {
                try { Remove-Item -LiteralPath $logPath -Force -ErrorAction Stop } catch { }
            }
        }

        # 关闭 Next.js 遥测，避免离线环境下无谓的网络等待与日志噪音。
        $env:NEXT_TELEMETRY_DISABLED = '1'

        Write-Info ''
        Write-Host "前台模式运行：npm run dev -- -p $targetPort -H 127.0.0.1" -ForegroundColor Cyan
        $foregroundStartInfo = @{
            FilePath               = $npmExe
            ArgumentList           = $npmArguments
            WorkingDirectory       = $ProjectRoot
            RedirectStandardOutput = $artifacts.LogFile
            RedirectStandardError  = $artifacts.ErrLogFile
            NoNewWindow            = $true
            PassThru               = $true
        }
        $foregroundProcess = Start-Process @foregroundStartInfo
        if ($null -eq $foregroundProcess) { throw '无法启动 npm run dev 进程。' }

        # C11：前台模式同样写 PID 与端口，dev 输出同样落到 .dev-logs/dev.log。
        # 这样 stop-dev.ps1 能按 PID 结束它（而不只是靠端口兜底），操作员也能在另一个窗口跟踪日志。
        Set-TextFile -Path $artifacts.PidFile -Value ([string]$foregroundProcess.Id)
        Set-TextFile -Path $artifacts.PortFile -Value ([string]$targetPort)
        Write-Info "已记录 PID=$($foregroundProcess.Id) 到 $($artifacts.PidFile)"
        Write-Info "已记录端口=$targetPort 到 $($artifacts.PortFile)"
        Write-Info "dev 输出：$($artifacts.LogFile)（stderr：$($artifacts.ErrLogFile)）"

        $logOffsets = @{}
        $logOffsets[$artifacts.LogFile] = 0
        $logOffsets[$artifacts.ErrLogFile] = 0
        $foregroundExit = 1
        try {
            $readinessUrl = "$baseUrl/api/admin/session"
            $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
            $ready = $false
            while ((Get-Date) -lt $deadline) {
                if (Test-ChildExited -Process $foregroundProcess) { break }
                if (Test-HttpReady -Url $readinessUrl -TimeoutSec 5) { $ready = $true; break }
                Start-Sleep -Milliseconds 500
            }
            Write-NewLogLines -Path $artifacts.LogFile -Offsets $logOffsets
            Write-NewLogLines -Path $artifacts.ErrLogFile -Offsets $logOffsets

            if (Test-ChildExited -Process $foregroundProcess) {
                Write-Warn "npm run dev 已退出（exit=$(Get-ChildExitCode -Process $foregroundProcess)）。"
            }
            elseif ($ready) {
                # 归属复查：记录已经写下去了，但只有确认端口上的监听者是刚启动的进程树，
                # 才能说"这是我们的服务"。否则记录会误导后续的 stop-dev.ps1，必须立刻清掉。
                $ownership = Confirm-PortOwnership -Port $targetPort -ProcessId $foregroundProcess.Id
                if (-not $ownership.Owned) {
                    Write-Warn "端口归属复查未通过：$($ownership.Reason)"
                    Write-Warn '  已清理本次写入的 .dev-server.pid / .dev-server.port，避免按错误目标停止服务。'
                    Remove-StaleArtifacts -Artifacts $artifacts
                }
                Write-Host ''
                Write-Ok '开发服务器已就绪（前台模式）。'
                Write-Info "  URL      : $baseUrl"
                Write-Info "  控制台   : $baseUrl/console （登录页 $baseUrl/login）"
                Write-Info "  PID      : $($foregroundProcess.Id)"
                Write-Info "  端口     : $targetPort （已写入 $($artifacts.PortFile)）"
                if ($ownership.Owned) { Write-Info "  归属确认 : $($ownership.Evidence)" }
                Write-Info "  日志     : $($artifacts.LogFile)"
                Write-Info '  停止     : 本窗口按 Ctrl+C，或在另一个窗口运行 scripts\stop-dev.ps1'
            }
            else {
                Write-Warn "等待超过 $TimeoutSeconds 秒仍未就绪，继续输出日志（Ctrl+C 停止）。"
            }

            # 前台模式的服务器会一直运行到 Ctrl+C：记录已写好，之后的启动/停机都靠记录 + 端口工作，
            # 因此这里必须释放互斥量，否则另一个窗口的 stop-dev.ps1 会被锁住直到本窗口结束。
            Exit-DevLock -Lock $devLock | Out-Null
            $devLock = $null

            while (-not (Test-ChildExited -Process $foregroundProcess)) {
                Write-NewLogLines -Path $artifacts.LogFile -Offsets $logOffsets
                Write-NewLogLines -Path $artifacts.ErrLogFile -Offsets $logOffsets
                Start-Sleep -Milliseconds 400
            }
            Write-NewLogLines -Path $artifacts.LogFile -Offsets $logOffsets
            Write-NewLogLines -Path $artifacts.ErrLogFile -Offsets $logOffsets
            $foregroundExit = Get-ChildExitCode -Process $foregroundProcess
        }
        finally {
            if (-not (Test-ChildExited -Process $foregroundProcess)) {
                # Ctrl+C 只会打到控制台前台进程组：npm/next 可能还活着，整棵树一起收掉。
                Stop-ProcessTree -ProcessId $foregroundProcess.Id | Out-Null
                Wait-ProcessGone -ProcessId $foregroundProcess.Id -TimeoutSeconds 10 | Out-Null
            }
            Remove-StaleArtifacts -Artifacts $artifacts
            Write-Info '前台模式结束，运行期产物（.dev-server.pid / .dev-server.port）已清理。'
        }
        exit $foregroundExit
    }

    New-Item -ItemType Directory -Path $artifacts.LogDir -Force | Out-Null
    foreach ($logPath in @($artifacts.LogFile, $artifacts.ErrLogFile)) {
        if (Test-Path -LiteralPath $logPath) {
            try { Remove-Item -LiteralPath $logPath -Force -ErrorAction Stop } catch { }
        }
    }

    # 关闭 Next.js 遥测，避免离线环境下无谓的网络等待与日志噪音。
    $env:NEXT_TELEMETRY_DISABLED = '1'

    Write-Info "后台启动：$npmExe run dev -- -p $targetPort -H 127.0.0.1"
    $startInfo = @{
        FilePath               = $npmExe
        ArgumentList           = $npmArguments
        WorkingDirectory       = $ProjectRoot
        RedirectStandardOutput = $artifacts.LogFile
        RedirectStandardError  = $artifacts.ErrLogFile
        NoNewWindow            = $true
        PassThru               = $true
    }
    $serverProcess = Start-Process @startInfo
    if ($null -eq $serverProcess) { throw '无法启动 npm run dev 进程。' }

    Set-TextFile -Path $artifacts.PidFile -Value ([string]$serverProcess.Id)
    Set-TextFile -Path $artifacts.PortFile -Value ([string]$targetPort)
    Write-Info "已记录 PID=$($serverProcess.Id) 到 $($artifacts.PidFile)"
    Write-Info "已记录端口=$targetPort 到 $($artifacts.PortFile)"
    Write-Info "等待服务就绪（最长 $TimeoutSeconds 秒）..."

    $readinessUrl = "$baseUrl/api/admin/session"
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $ready = $false
    while ((Get-Date) -lt $deadline) {
        if ($serverProcess.HasExited) { break }
        if (Test-HttpReady -Url $readinessUrl -TimeoutSec 5) { $ready = $true; break }
        Start-Sleep -Milliseconds 500
    }

    if (-not $ready) {
        $reason = ''
        if ($serverProcess.HasExited) {
            $reason = "npm run dev 进程已退出（exit=$($serverProcess.ExitCode)）。"
        }
        else {
            $reason = "等待超过 $TimeoutSeconds 秒仍未就绪。"
        }
        Write-Host ''
        Write-Warn "启动失败：$reason"
        Write-Warn "--- dev.log 末尾 ---"
        foreach ($line in (Get-LogTail -Path $artifacts.LogFile -Lines 30)) { Write-Host "  $line" }
        Write-Warn "--- dev.err.log 末尾 ---"
        foreach ($line in (Get-LogTail -Path $artifacts.ErrLogFile -Lines 30)) { Write-Host "  $line" }

        if (-not $serverProcess.HasExited) {
            Stop-ProcessTree -ProcessId $serverProcess.Id | Out-Null
            Wait-ProcessGone -ProcessId $serverProcess.Id -TimeoutSeconds 10 | Out-Null
        }
        Remove-StaleArtifacts -Artifacts $artifacts
        throw '开发服务器未能就绪，详见上面日志。'
    }

    # 写记录之后的归属复查：HTTP 就绪只说明"端口上有人在提供服务"，不说明那是我们的进程。
    # 端口被抢占时（并发启动的旧版本、另一个程序、next 自己换了端口），继续宣称成功就等于
    # 制造一台运维看不见的孤儿服务。这里一旦核对不上就收掉本次启动并删除记录。
    $ownership = Confirm-PortOwnership -Port $targetPort -ProcessId $serverProcess.Id
    if (-not $ownership.Owned) {
        Write-Host ''
        Write-Warn "启动校验失败：$($ownership.Reason)"
        if (-not $serverProcess.HasExited) {
            Stop-ProcessTree -ProcessId $serverProcess.Id | Out-Null
            Wait-ProcessGone -ProcessId $serverProcess.Id -TimeoutSeconds 10 | Out-Null
        }
        Remove-StaleArtifacts -Artifacts $artifacts
        throw "端口 $targetPort 的监听者不是本次启动的进程（PID $($serverProcess.Id)），已回滚本次启动并清理运行期产物。请重试；若端口总是被抢占，用 -Port 指定其它端口。"
    }

    # 到这里服务确实由我们启动、记录也已核实：释放互斥量，让 stop-dev.ps1 立即可用。
    Exit-DevLock -Lock $devLock | Out-Null
    $devLock = $null

    Write-Host ''
    Write-Ok '开发服务器已就绪。'
    Write-Info "  URL      : $baseUrl"
    Write-Info "  控制台   : $baseUrl/console （登录页 $baseUrl/login）"
    Write-Info "  PID      : $($serverProcess.Id)"
    Write-Info "  端口     : $targetPort （已写入 $($artifacts.PortFile)）"
    Write-Info "  归属确认 : $($ownership.Evidence)"
    Write-Info "  日志     : $($artifacts.LogFile)"
    Write-Info "  stderr   : $($artifacts.ErrLogFile)"
    Write-Info "  数据库   : $ProjectRoot\data"
    Write-Info ''
    Write-Info '  停止服务 : powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stop-dev.ps1'
    Write-Info '  端到端验证: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\test-api.ps1'
    Write-Host ''
    $exitCode = 0
}
catch {
    Write-Host ''
    Write-Host "启动失败：$($_.Exception.Message)" -ForegroundColor Red
    $exitCode = 1
}

# 退出前一定释放互斥量（这里不用 finally：PowerShell 在 try/finally 里 exit 会把退出码重置成 0）。
Exit-DevLock -Lock $devLock | Out-Null
$devLock = $null

exit $exitCode
