#Requires -Version 5.1
<#
.SYNOPSIS
    AragonRouter 端到端验证脚本（自带本地桩上游，完全离线，逐条 PASS/FAIL）。

.DESCRIPTION
    覆盖链路：
      401（无 key）→ 管理员登录 → 建 API Key → 建 Provider（指向桩上游）
      → /api/v1/messages 非流式 200 → SSE 流式 → /api/v1/chat/completions 200
      → /api/v1/models 200 → 坏 key 401（error.type=authentication_error）
      → 上游凭证注入/入站凭证剥离（C9）→ /api/admin/logs 有记录
      → /api/admin/stats totals.requests > 0 → 停机后端口释放
      → 重复停机幂等。

    执行顺序：
      1. 调用 scripts/start-dev.ps1 启动（或复用）开发服务器，端口一律从 .dev-server.port 读取；
      2. 启动 tests/integration/stub-upstream.mjs，读取它写在 stdout 的端口号；
      3. 逐步断言，每一步输出一行 PASS/FAIL，失败不影响后续独立步骤；
      4. 末尾停机并断言端口释放、再验一次停机幂等；指定 -KeepServer 时这几步整体跳过，改为
         断言“现场确实保留”（服务可访问、运行期产物仍在、口令仍可登录），finally 也不再兜底停机。
         桩上游无论何种模式都会结束。

.PARAMETER Port
    透传给 start-dev.ps1 的端口。省略时由 start-dev.ps1 自动从 3000 起挑选空闲端口。

.PARAMETER SkipInstall
    透传给 start-dev.ps1：依赖缺失时不自动 npm install。

.PARAMETER KeepServer
    验证完成后**保留开发服务器**（默认会停止），便于手动排查。
    指定后脚本完全跳过「停机 → 断言端口释放 → 重复停机幂等」这几步（它们会互相矛盾），
    改为断言现场确实保留：服务仍可访问、.dev-server.pid / .dev-server.port 仍在、管理员口令仍可登录；
    finally 兜底停机同样不会执行。结束后脚本会打印停止命令。

.PARAMETER StartTimeoutSeconds
    透传给 start-dev.ps1 的就绪等待上限，默认 120 秒。

.PARAMETER AbortAfterStep
    **仅供回归自检**，生产使用请保持默认 0。
    在第 N 条断言之后注入一条致命错误，用来验证「运行被中途打断」时 finally 仍然会停止服务、
    释放端口并清理运行期产物。tests/integration/scripts-races.test.ts 用它在真实服务器上覆盖
    这条路径（普通断言失败不会中断脚本，只有致命错误才会走到 finally）。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\test-api.ps1

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\test-api.ps1 -Port 3100 -KeepServer

.NOTES
    退出码：0 = 全部断言通过；1 = 至少一条断言失败、运行被中断，或收尾停机未能释放端口。
    收尾语义：无论断言成功、失败还是运行被致命错误打断，finally 都会调用 scripts/stop-dev.ps1，
    并**验证**端口确已关闭、.dev-server.pid / .dev-server.port 确已清理；验证不通过同样以退出码 1 结束。
    依赖：Node.js >= 22.5、PowerShell 5.1+、已安装的 node_modules（或允许自动安装）。
#>
[CmdletBinding()]
param(
    [ValidateRange(0, 65535)]
    [int]$Port = 0,

    [switch]$SkipInstall,

    [switch]$KeepServer,

    [ValidateRange(10, 900)]
    [int]$StartTimeoutSeconds = 120,

    [ValidateRange(0, 100)]
    [int]$AbortAfterStep = 0
)

$ErrorActionPreference = 'Stop'
try {
    $utf8 = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false
    [Console]::OutputEncoding = $utf8
} catch {
    # 忽略：编码设置失败不影响断言
}

. (Join-Path (Join-Path $PSScriptRoot 'lib') 'dev-common.ps1')

$ProjectRoot = Resolve-ProjectRoot -StartPath $PSScriptRoot
$artifacts = Get-DevArtifacts -ProjectRoot $ProjectRoot

# 桩上游凭证：只用于断言网关是否正确注入/剥离，值本身不是真实密钥。
$UpstreamAnthropicKey = 'stub-anthropic-upstream-credential'
$UpstreamOpenAiKey = 'stub-openai-upstream-credential'

$script:Passed = 0
$script:Failed = 0
$script:StepNumber = 0
$script:FailureDetails = New-Object System.Collections.Generic.List[string]
# 运行被中断时的致命错误信息（普通断言失败不会中断脚本）。
$script:FatalMessage = ''
# 收尾停机（finally）验证未通过：端口未释放或运行期产物未清理。
$script:FinallyStopFailed = $false

$state = @{
    Port              = 0
    BaseUrl           = ''
    StubPort          = 0
    StubProc          = $null
    WebSession        = $null
    AdminPassword     = ''
    ApiKey            = ''
    ApiKeyId          = ''
    AnthropicProvider = ''
    OpenAiProvider    = ''
    ServerStopped     = $false
    CleanupDone       = $false
    # 本次运行创建的 provider（结束时删除，避免污染下一次运行）
    CreatedProviders  = New-Object System.Collections.Generic.List[string]
    # 运行前已启用、被临时禁用的历史 provider（结束时恢复启用状态）
    DisabledProviders = New-Object System.Collections.Generic.List[string]
}

# ---------------------------------------------------------------------------
# 断言与执行框架
# ---------------------------------------------------------------------------
function Assert-True {
    param(
        [bool]$Condition,
        [Parameter(Mandatory = $true)]
        [string]$Message
    )
    if (-not $Condition) { throw $Message }
}

function Assert-Equal {
    param(
        $Expected,
        $Actual,
        [Parameter(Mandatory = $true)]
        [string]$What
    )
    if ($Expected -ne $Actual) {
        throw "$What 期望 [$Expected]，实际 [$Actual]"
    }
}

function Assert-Contains {
    param(
        [string]$Haystack,
        [string]$Needle,
        [Parameter(Mandatory = $true)]
        [string]$What
    )
    if ([string]::IsNullOrEmpty($Haystack) -or -not $Haystack.Contains($Needle)) {
        throw "$What 中未找到 [$Needle]"
    }
}

function Assert-NotContains {
    param(
        [string]$Haystack,
        [string]$Needle,
        [Parameter(Mandatory = $true)]
        [string]$What
    )
    if (-not [string]::IsNullOrEmpty($Haystack) -and $Haystack.Contains($Needle)) {
        throw "$What 中泄漏了 [$Needle]"
    }
}

function Assert-Match {
    param(
        [string]$Value,
        [string]$Pattern,
        [Parameter(Mandatory = $true)]
        [string]$What
    )
    if ([string]::IsNullOrEmpty($Value) -or -not ($Value -match $Pattern)) {
        throw "$What 不匹配 [$Pattern]，实际为 [$Value]"
    }
}

function ConvertFrom-JsonSafe {
    param(
        [string]$Text,
        [Parameter(Mandatory = $true)]
        [string]$What
    )
    if ([string]::IsNullOrWhiteSpace($Text)) { throw "$What 的响应体为空" }
    try {
        return ($Text | ConvertFrom-Json)
    }
    catch {
        $preview = $Text
        if ($preview.Length -gt 200) { $preview = $preview.Substring(0, 200) }
        throw "$What 的响应不是合法 JSON：$preview"
    }
}

function Invoke-Step {
    <#
    .SYNOPSIS
        执行一个断言步骤：抛异常即 FAIL，否则 PASS。失败不中断后续步骤。
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [scriptblock]$Action
    )

    $script:StepNumber = $script:StepNumber + 1
    $label = '[{0:d2}] {1}' -f $script:StepNumber, $Name
    Write-Host ("RUN   " + $label) -ForegroundColor DarkGray
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        & $Action
        $stopwatch.Stop()
        $script:Passed = $script:Passed + 1
        Write-Host ("PASS  " + $label + "  (" + [int]$stopwatch.Elapsed.TotalMilliseconds + " ms)") -ForegroundColor Green
    }
    catch {
        $stopwatch.Stop()
        $script:Failed = $script:Failed + 1
        $reason = $_.Exception.Message
        $script:FailureDetails.Add(('{0} -> {1}' -f $label, $reason))
        Write-Host ("FAIL  " + $label + "  (" + [int]$stopwatch.Elapsed.TotalMilliseconds + " ms)") -ForegroundColor Red
        Write-Host ("      原因: " + $reason) -ForegroundColor Red
    }

    # 回归自检钩子（-AbortAfterStep N）：在真实服务器上验证「运行被中途打断」时
    # finally 仍然会停止服务并释放端口。这里故意抛到调用方（不 catch），
    # 因为普通断言失败是"继续跑后面的步骤"，而致命错误是"立刻走 finally"。
    if ($AbortAfterStep -gt 0 -and $script:StepNumber -ge $AbortAfterStep) {
        throw ("回归自检注入的致命错误（-AbortAfterStep $AbortAfterStep）：在第 $($script:StepNumber) 条断言之后中止本次运行，" +
            '用于验证 finally 仍会停止服务、释放端口并清理运行期产物。')
    }
}

function Invoke-GatewayRequest {
    <#
    .SYNOPSIS
        对开发服务器发起一次请求（返回 {Status, Content, Headers}，非 2xx 不抛异常）。
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$Method,
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [hashtable]$Headers,
        [string]$Body,
        [switch]$UseSession,
        [int]$TimeoutSec = 60
    )

    Assert-True ($state.BaseUrl.Length -gt 0) '依赖的前置步骤失败：开发服务器地址尚未就绪'
    $parameters = @{
        Method     = $Method
        Url        = ($state.BaseUrl + $Path)
        TimeoutSec = $TimeoutSec
    }
    if ($null -ne $Headers -and $Headers.Count -gt 0) { $parameters['Headers'] = $Headers }
    if ($PSBoundParameters.ContainsKey('Body')) { $parameters['Body'] = $Body }
    if ($UseSession) {
        Assert-True ($null -ne $state.WebSession) '依赖的前置步骤失败：管理员会话尚未建立'
        $parameters['WebSession'] = $state.WebSession
    }
    return Invoke-HttpRequest @parameters
}

function Quote-Argument {
    <#
    .SYNOPSIS
        为 Start-Process 的 -ArgumentList 加引号（路径可能含空格）。
    #>
    param([string]$Value)
    if ($null -eq $Value) { return '""' }
    if ($Value -match '[\s"]') { return '"' + $Value.Replace('"', '\"') + '"' }
    return $Value
}

function Invoke-TestDataCleanup {
    <#
    .SYNOPSIS
        删除本次创建的 provider / API Key，并恢复被临时禁用的历史 provider。
    .DESCRIPTION
        必须在开发服务器还活着的时候调用。返回问题条数（0 表示干净）。
        每一条都是独立的 try/catch：清理失败绝不能掩盖真正的断言结果。
    #>
    param()

    $problems = 0
    if ($null -eq $state.WebSession -or $state.BaseUrl.Length -eq 0) { return $problems }

    foreach ($providerId in $state.CreatedProviders) {
        $response = $null
        try {
            $response = Invoke-HttpRequest -Method DELETE -Url ($state.BaseUrl + "/api/admin/providers/$providerId") -WebSession $state.WebSession -TimeoutSec 20
        }
        catch {
            $response = $null
        }
        if ($null -eq $response -or $response.Status -ne 200) {
            $problems = $problems + 1
            $status = if ($null -eq $response) { '连接失败' } else { "HTTP $($response.Status)" }
            Write-Host "      | 清理测试 provider $providerId 失败（$status）" -ForegroundColor Yellow
        }
    }

    if ($state.ApiKeyId.Length -gt 0) {
        $response = $null
        try {
            $response = Invoke-HttpRequest -Method DELETE -Url ($state.BaseUrl + "/api/admin/keys/$($state.ApiKeyId)") -WebSession $state.WebSession -TimeoutSec 20
        }
        catch {
            $response = $null
        }
        if ($null -eq $response -or $response.Status -ne 200) {
            $problems = $problems + 1
            $status = if ($null -eq $response) { '连接失败' } else { "HTTP $($response.Status)" }
            Write-Host "      | 清理测试 API Key 失败（$status）" -ForegroundColor Yellow
        }
    }

    foreach ($providerId in $state.DisabledProviders) {
        $response = $null
        try {
            $response = Invoke-HttpRequest -Method PATCH -Url ($state.BaseUrl + "/api/admin/providers/$providerId") -Body '{"enabled":true}' -WebSession $state.WebSession -TimeoutSec 20
        }
        catch {
            $response = $null
        }
        if ($null -eq $response -or $response.Status -ne 200) {
            $problems = $problems + 1
            $status = if ($null -eq $response) { '连接失败' } else { "HTTP $($response.Status)" }
            Write-Host "      | 恢复历史 provider $providerId 失败（$status）" -ForegroundColor Yellow
        }
    }

    return $problems
}

function Hide-GeneratedPassword {
    <#
    .SYNOPSIS
        把子脚本输出里的管理口令明文替换成占位串，用于写回日志文件。
    .DESCRIPTION
        start-dev.ps1 首次运行（或修补 .env.local）时会把新生成的 ADMIN_PASSWORD 打印一次。
        本脚本把它的 stdout 重定向到 .dev-logs\child-start-dev.out.log，那一行会原样落到磁盘上，
        等于给这份一次性口令又存了一份明文副本（.dev-logs 虽被 gitignore，仍是本机可读文件）。
        这里只遮住口令值，保留“已重新生成”等诊断尾巴，排查信息不丢；控制台回显仍然完整，因为
        “口令只打印一次”正是 start-dev.ps1 的约定。
    #>
    param([string]$Text)

    if ([string]::IsNullOrEmpty($Text)) { return $Text }
    $result = New-Object System.Collections.Generic.List[string]
    foreach ($line in ($Text -split "`r?`n")) {
        if ($line -notmatch '管理口令 ADMIN_PASSWORD') { $result.Add($line); continue }
        $labelIndex = $line.IndexOf('ADMIN_PASSWORD', [System.StringComparison]::Ordinal)
        if ($labelIndex -lt 0) { $result.Add($line); continue }
        $label = $line.Substring(0, $labelIndex + 'ADMIN_PASSWORD'.Length)
        $suffix = ''
        $suffixIndex = $line.IndexOf('（', $labelIndex)
        if ($suffixIndex -gt 0) { $suffix = $line.Substring($suffixIndex) }
        $result.Add($label + ' : ***（已脱敏，见 .env.local）' + $suffix)
    }
    return ($result -join "`n")
}

function Read-ChildLogText {
    <#
    .SYNOPSIS
        以正确的编码读取子脚本日志（共享读，允许子进程仍持有句柄）。
    .DESCRIPTION
        子脚本（start-dev.ps1 / stop-dev.ps1）自己会把 [Console]::OutputEncoding 设成 UTF-8，
        但设置失败时（没有控制台句柄等）就会按系统默认代码页写出。固定按 UTF-8 解码时那种
        文件会变成乱码，脱敏匹配（按标签文字）随之失效，口令就又留在磁盘上了。
        因此先用严格 UTF-8 解码，失败再退回系统默认代码页。
    #>
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $stream = $null
    try {
        $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        $buffer = New-Object byte[] ([int]$stream.Length)
        if ($buffer.Length -eq 0) { return $null }
        $read = 0
        while ($read -lt $buffer.Length) {
            $chunk = $stream.Read($buffer, $read, $buffer.Length - $read)
            if ($chunk -le 0) { break }
            $read = $read + $chunk
        }
    }
    finally {
        if ($null -ne $stream) { try { $stream.Dispose() } catch { } }
    }

    try { return ([System.Text.UTF8Encoding]::new($false, $true)).GetString($buffer, 0, $read) }
    catch { return ([System.Text.Encoding]::Default).GetString($buffer, 0, $read) }
}

function Invoke-PowerShellScript {
    <#
    .SYNOPSIS
        以独立进程运行仓库内脚本，返回 {ExitCode, Output}。
    .DESCRIPTION
        三个坑一次绕开：
          1. 输出不能用管道捕获 —— 被调用的脚本（start-dev.ps1）会再拉起一个长期运行的
             后台 dev server，孙进程继承管道写端后父进程读不到 EOF，会一直挂住；
          2. 输出也不能直接用 .NET 读文件 —— 孙进程继承了日志文件句柄，普通 ReadAllLines
             会撞上共享冲突，因此这里交给 cmd.exe 做重定向并统一用共享读读取；
          3. Windows PowerShell 5.1 下 Start-Process -PassThru + WaitForExit(ms) 取不到
             ExitCode，而 -Wait 在 PowerShell 7 又会等待整棵进程树（dev server 不停就永不返回），
             所以改用 [System.Diagnostics.Process] + cmd.exe 包装，只等 cmd 本身。
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$ScriptPath,
        [string[]]$ScriptArguments = @(),
        [int]$TimeoutMs = 600000
    )

    $logDir = $artifacts.LogDir
    if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
    $baseName = [System.IO.Path]::GetFileNameWithoutExtension($ScriptPath)
    $stdoutFile = Join-Path $logDir ("child-" + $baseName + ".out.log")
    $stderrFile = Join-Path $logDir ("child-" + $baseName + ".err.log")

    $innerCommand = '"' + (Get-PowerShellHostPath) + '" -NoProfile -ExecutionPolicy Bypass -File "' + $ScriptPath + '"'
    foreach ($argument in $ScriptArguments) { $innerCommand += ' ' + (Quote-Argument $argument) }
    $innerCommand += ' > "' + $stdoutFile + '" 2> "' + $stderrFile + '"'

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $env:ComSpec
    if ([string]::IsNullOrWhiteSpace($startInfo.FileName)) { $startInfo.FileName = 'cmd.exe' }
    $startInfo.Arguments = '/c "' + $innerCommand + '"'
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.WorkingDirectory = $ProjectRoot

    $process = [System.Diagnostics.Process]::Start($startInfo)
    if ($null -eq $process) { throw "无法启动子进程：$ScriptPath" }

    if (-not $process.WaitForExit($TimeoutMs)) {
        try { Stop-ProcessTree -ProcessId $process.Id | Out-Null } catch { }
        throw "子进程执行超时（$TimeoutMs ms）：$ScriptPath"
    }
    $exitCode = $process.ExitCode
    try { $process.Dispose() } catch { }

    $output = @()
    foreach ($logPath in @($stdoutFile, $stderrFile)) {
        $raw = Read-ChildLogText -Path $logPath
        if ([string]::IsNullOrEmpty($raw)) { continue }

        # 磁盘上的副本要脱敏：否则一次性口令会以明文长期留在 .dev-logs 里。
        $masked = Hide-GeneratedPassword -Text $raw
        if ($masked -ne $raw) {
            try {
                $utf8NoBom = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false
                [System.IO.File]::WriteAllText($logPath, $masked, $utf8NoBom)
            }
            catch {
                Write-Host "      | 警告：无法脱敏 $logPath（$($_.Exception.Message)）" -ForegroundColor Yellow
            }
        }

        # 控制台回显保持原样：一次性口令本来就该在控制台出现一次。
        $output += @($raw -split "`r?`n")
    }

    $clean = @()
    foreach ($line in $output) {
        if ($null -eq $line) { continue }
        $text = [string]$line
        if ($text.Length -eq 0) { continue }
        $clean += $text
    }
    return [pscustomobject]@{ ExitCode = $exitCode; Output = $clean }
}

function Write-NativeOutput {
    param($Native)
    foreach ($line in $Native.Output) { Write-Host ('      | ' + $line) }
}

# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ' AragonRouter 端到端验证（离线，自带本地桩上游）' -ForegroundColor Cyan
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host "项目根目录：$ProjectRoot"

try {
    # ---- 1) 启动开发服务器 ------------------------------------------------
    Invoke-Step '启动开发服务器（scripts/start-dev.ps1）' {
        Assert-True (Test-Path -LiteralPath $artifacts.StartScript) "未找到 $($artifacts.StartScript)"
        $scriptArguments = @('-TimeoutSeconds', [string]$StartTimeoutSeconds)
        if ($Port -gt 0) { $scriptArguments = @('-Port', [string]$Port) + $scriptArguments }
        if ($SkipInstall) { $scriptArguments += '-SkipInstall' }

        $native = Invoke-PowerShellScript -ScriptPath $artifacts.StartScript -ScriptArguments $scriptArguments
        Write-NativeOutput -Native $native
        Assert-Equal 0 $native.ExitCode 'start-dev.ps1 退出码'

        $state.Port = Read-DevPort -Artifacts $artifacts
        Assert-True ($state.Port -gt 0) '未能从 .dev-server.port 读到实际端口'
        $state.BaseUrl = "http://127.0.0.1:$($state.Port)"
        Assert-True (Test-HttpReady -Url "$($state.BaseUrl)/api/admin/session" -TimeoutSec 5) '服务未响应 GET /api/admin/session'
        Write-Host ("      | 服务地址: " + $state.BaseUrl)
    }

    # ---- 2) 仓库自检：凭据文件与 .gitignore -------------------------------
    Invoke-Step '仓库自检：.env.local 凭据完整且运行期产物已被 .gitignore 覆盖' {
        Assert-True (Test-Path -LiteralPath $artifacts.EnvFile) '未生成 .env.local'
        $envMap = Read-EnvFile -Path $artifacts.EnvFile
        Assert-True ($envMap.Contains('ADMIN_PASSWORD')) '.env.local 缺少 ADMIN_PASSWORD'
        # 按强度判断（而不是“存在即可”）：8~11 字符的口令在网关上登录会不稳定，
        # 而操作员看到 .env.local 存在就以为没问题。这里直接给出该怎么做。
        Assert-True ((($envMap['ADMIN_PASSWORD']) -as [string]).Length -ge 12) `
            ("ADMIN_PASSWORD 只有 " + ((($envMap['ADMIN_PASSWORD']) -as [string]).Length) + " 个字符，不满足网关要求（>= 12）。" + `
                '处理：删除 .env.local 后重新运行 scripts\start-dev.ps1，让它生成并打印新口令。')
        Assert-True ($envMap.Contains('SESSION_SECRET')) '.env.local 缺少 SESSION_SECRET'
        Assert-True ((($envMap['SESSION_SECRET']) -as [string]).Length -ge 32) 'SESSION_SECRET 少于 32 个字符'
        Assert-Match ([string]$envMap['ENCRYPTION_KEY']) '^[0-9a-fA-F]{64}$' 'ENCRYPTION_KEY 必须是 64 位十六进制'
        Assert-True ($envMap.Contains('DATABASE_PATH')) '.env.local 缺少 DATABASE_PATH'
        $state.AdminPassword = [string]$envMap['ADMIN_PASSWORD']

        $gitignorePath = Join-Path $ProjectRoot '.gitignore'
        Assert-True (Test-Path -LiteralPath $gitignorePath) '未找到 .gitignore'
        $gitignore = [System.IO.File]::ReadAllText($gitignorePath)
        foreach ($pattern in @('.dev-server.pid', '.dev-server.port', '.dev-logs/', 'data/', '.env.local')) {
            Assert-Contains $gitignore $pattern ".gitignore 未覆盖 $pattern"
        }
    }

    # ---- 3) 启动桩上游 ----------------------------------------------------
    Invoke-Step '启动本地桩上游（tests/integration/stub-upstream.mjs）' {
        Assert-True (Test-Path -LiteralPath $artifacts.StubScript) "未找到 $($artifacts.StubScript)"
        $nodeExe = Get-NodeExecutable
        New-Item -ItemType Directory -Path $artifacts.LogDir -Force | Out-Null
        foreach ($logPath in @($artifacts.StubLogFile, $artifacts.StubErrLogFile)) {
            if (Test-Path -LiteralPath $logPath) {
                try { Remove-Item -LiteralPath $logPath -Force -ErrorAction Stop } catch { }
            }
        }
        $state.StubProc = Start-Process -FilePath $nodeExe `
            -ArgumentList @($artifacts.StubScript) `
            -WorkingDirectory $ProjectRoot `
            -RedirectStandardOutput $artifacts.StubLogFile `
            -RedirectStandardError $artifacts.StubErrLogFile `
            -NoNewWindow -PassThru

        $deadline = (Get-Date).AddSeconds(20)
        $stubPort = 0
        while ((Get-Date) -lt $deadline) {
            if ($state.StubProc.HasExited) { break }
            $raw = Read-FirstLine -Path $artifacts.StubLogFile
            if (-not [string]::IsNullOrWhiteSpace($raw)) {
                $parsed = 0
                if ([int]::TryParse($raw, [ref]$parsed) -and $parsed -gt 0) { $stubPort = $parsed; break }
            }
            Start-Sleep -Milliseconds 200
        }
        Assert-True ($stubPort -gt 0) ("桩上游未在 20 秒内报告端口；stderr: " + ([string]::Join(' / ', (Get-LogTail -Path $artifacts.StubErrLogFile -Lines 10))))
        $state.StubPort = $stubPort
        Write-Host ("      | 桩上游端口: " + $stubPort)
    }

    # ---- 4) 无凭证 401 ----------------------------------------------------
    Invoke-Step '无 API Key 请求 /api/v1/messages 返回 401 且 error.type=authentication_error' {
        $payload = @{
            model      = 'stub-anthropic-model'
            max_tokens = 32
            messages   = @(@{ role = 'user'; content = 'ping' })
        } | ConvertTo-Json -Compress -Depth 8

        $response = Invoke-GatewayRequest -Method POST -Path '/api/v1/messages' -Body $payload
        Assert-Equal 401 $response.Status 'HTTP 状态码'
        $json = ConvertFrom-JsonSafe -Text $response.Content -What '401 响应'
        Assert-Equal 'error' $json.type 'error.type 外层 type'
        Assert-Equal 'authentication_error' $json.error.type 'error.error.type'
        Assert-True (-not [string]::IsNullOrWhiteSpace([string]$json.error.message)) 'error.error.message 不能为空'
    }

    # ---- 5) 管理员登录 ----------------------------------------------------
    Invoke-Step '管理员登录（POST /api/admin/session）设置 aragon_session Cookie' {
        $state.WebSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession
        $body = @{ password = $state.AdminPassword } | ConvertTo-Json -Compress
        $response = Invoke-GatewayRequest -Method POST -Path '/api/admin/session' -Body $body -UseSession
        if ($response.Status -ne 200) {
            # 口令问题必须给出可操作的结论，而不是让后面 19 步连锁失败还看不出根因。
            $preview = [string]$response.Content
            if ($preview.Length -gt 200) { $preview = $preview.Substring(0, 200) }
            $guidance = ''
            if ($response.Status -eq 400 -or $response.Status -eq 401) {
                $guidance = ("口令不被网关接受（.env.local 的 ADMIN_PASSWORD 长度 " + $state.AdminPassword.Length + "）。" + `
                    '处理：删除 .env.local 后重新运行 scripts\start-dev.ps1 生成并打印新口令，然后重跑本脚本。')
            }
            elseif ($response.Status -eq 429) {
                $guidance = '登录被限流（连续失败过多）：等待一分钟再重跑本脚本。'
            }
            throw "HTTP $($response.Status)：$preview $guidance"
        }
        $json = ConvertFrom-JsonSafe -Text $response.Content -What '登录响应'
        Assert-Equal $true $json.data.ok 'data.ok'

        $setCookie = Get-HeaderValue -Headers $response.Headers -Name 'Set-Cookie'
        Assert-Contains $setCookie 'aragon_session=' 'Set-Cookie'
        Assert-Contains $setCookie 'HttpOnly' 'Set-Cookie'
        Assert-Contains $setCookie 'SameSite=Lax' 'Set-Cookie'
    }

    # ---- 6) 管理接口未授权 401 -------------------------------------------
    Invoke-Step '未带会话访问 /api/admin/keys 返回 401 unauthorized' {
        $response = Invoke-GatewayRequest -Method GET -Path '/api/admin/keys'
        Assert-Equal 401 $response.Status 'HTTP 状态码'
        $json = ConvertFrom-JsonSafe -Text $response.Content -What '未授权响应'
        Assert-Equal 'unauthorized' $json.error.message 'error.message'
    }

    # ---- 7) 创建 API Key -------------------------------------------------
    Invoke-Step '创建 API Key（POST /api/admin/keys）返回一次性明文 ar-...' {
        $body = @{ name = 'e2e-integration-key' } | ConvertTo-Json -Compress
        $response = Invoke-GatewayRequest -Method POST -Path '/api/admin/keys' -Body $body -UseSession
        Assert-Equal 200 $response.Status 'HTTP 状态码'
        $json = ConvertFrom-JsonSafe -Text $response.Content -What '创建 Key 响应'
        $key = [string]$json.data.key
        Assert-Match $key '^ar-[0-9a-f]{32}$' 'data.key'
        Assert-True (-not [string]::IsNullOrWhiteSpace([string]$json.data.id)) 'data.id 不能为空'
        Assert-True (-not [string]::IsNullOrWhiteSpace([string]$json.data.keyPrefix)) 'data.keyPrefix 不能为空'
        $state.ApiKey = $key
        $state.ApiKeyId = [string]$json.data.id
        Write-Host ("      | keyPrefix: " + $json.data.keyPrefix)
    }

    # ---- 8) 隔离历史 Provider --------------------------------------------
    Invoke-Step '隔离历史 Provider（临时禁用已启用项，保证转发命中本次的桩上游）' {
        $response = Invoke-GatewayRequest -Method GET -Path '/api/admin/providers' -UseSession
        Assert-Equal 200 $response.Status 'HTTP 状态码'
        $json = ConvertFrom-JsonSafe -Text $response.Content -What 'provider 列表'
        $enabled = @(@($json.data) | Where-Object { $_.enabled -eq $true })
        foreach ($provider in $enabled) {
            $providerId = [string]$provider.id
            $patch = @{ enabled = $false } | ConvertTo-Json -Compress
            $patched = Invoke-GatewayRequest -Method PATCH -Path "/api/admin/providers/$providerId" -Body $patch -UseSession
            Assert-Equal 200 $patched.Status "禁用历史 provider $providerId 的状态码"
            if (-not $state.DisabledProviders.Contains($providerId)) { $state.DisabledProviders.Add($providerId) }
        }
        # 网关按 created_at 升序挑选同协议 provider，历史行必须让位给本次的桩上游。
        Write-Host ("      | 临时禁用历史 provider: " + $state.DisabledProviders.Count + " 个")
    }

    # ---- 9) 创建 Provider（指向桩上游） ----------------------------------
    Invoke-Step '创建 Provider（anthropic + openai，均指向桩上游）' {
        Assert-True ($state.StubPort -gt 0) '依赖的前置步骤失败：桩上游不可用'
        $stubBaseUrl = "http://127.0.0.1:$($state.StubPort)"

        $anthropicBody = @{
            name     = 'stub-anthropic'
            protocol = 'anthropic'
            baseUrl  = $stubBaseUrl
            apiKey   = $UpstreamAnthropicKey
        } | ConvertTo-Json -Compress
        $response = Invoke-GatewayRequest -Method POST -Path '/api/admin/providers' -Body $anthropicBody -UseSession
        Assert-Equal 200 $response.Status 'anthropic provider 创建状态码'
        $json = ConvertFrom-JsonSafe -Text $response.Content -What 'anthropic provider 响应'
        Assert-Equal 'anthropic' $json.data.protocol 'data.protocol'
        Assert-Equal $stubBaseUrl $json.data.baseUrl 'data.baseUrl'
        Assert-Equal $true $json.data.enabled 'data.enabled'
        Assert-NotContains ([string]$json.data.maskedKey) $UpstreamAnthropicKey 'data.maskedKey'
        $state.AnthropicProvider = [string]$json.data.id
        $state.CreatedProviders.Add($state.AnthropicProvider)

        $openAiBody = @{
            name     = 'stub-openai'
            protocol = 'openai'
            baseUrl  = $stubBaseUrl
            apiKey   = $UpstreamOpenAiKey
        } | ConvertTo-Json -Compress
        $response = Invoke-GatewayRequest -Method POST -Path '/api/admin/providers' -Body $openAiBody -UseSession
        Assert-Equal 200 $response.Status 'openai provider 创建状态码'
        $json = ConvertFrom-JsonSafe -Text $response.Content -What 'openai provider 响应'
        Assert-Equal 'openai' $json.data.protocol 'data.protocol'
        Assert-Equal $true $json.data.enabled 'data.enabled'
        $state.OpenAiProvider = [string]$json.data.id
        $state.CreatedProviders.Add($state.OpenAiProvider)
        Write-Host ("      | anthropic=$($state.AnthropicProvider) openai=$($state.OpenAiProvider)")
    }

    # ---- 10) Provider 连通性测试 ------------------------------------------
    Invoke-Step 'Provider 连通性测试（POST /api/admin/providers/{id}/test）返回 data.ok=true' {
        Assert-True ($state.AnthropicProvider.Length -gt 0) '依赖的前置步骤失败：provider 未创建'
        $path = "/api/admin/providers/$($state.AnthropicProvider)/test"
        $response = Invoke-GatewayRequest -Method POST -Path $path -Body '{}' -UseSession
        Assert-Equal 200 $response.Status 'HTTP 状态码'
        $json = ConvertFrom-JsonSafe -Text $response.Content -What '连通性测试响应'
        Assert-Equal $true $json.data.ok 'data.ok'
        Assert-True (-not [string]::IsNullOrWhiteSpace([string]$json.data.message)) 'data.message 不能为空'
        Assert-NotContains $response.Content $UpstreamAnthropicKey '连通性测试响应'
        Write-Host ("      | message: " + $json.data.message)
    }

    # ---- 11) 非流式转发 ---------------------------------------------------
    Invoke-Step '非流式转发（POST /api/v1/messages）返回 200 与 usage' {
        Assert-True ($state.ApiKey.Length -gt 0) '依赖的前置步骤失败：API Key 未创建'
        $payload = @{
            model      = 'stub-anthropic-model'
            max_tokens = 64
            messages   = @(@{ role = 'user'; content = 'hello from the e2e test' })
        } | ConvertTo-Json -Compress -Depth 8

        $headers = @{ 'x-api-key' = $state.ApiKey; 'anthropic-version' = '2023-06-01' }
        $response = Invoke-GatewayRequest -Method POST -Path '/api/v1/messages' -Headers $headers -Body $payload
        Assert-Equal 200 $response.Status 'HTTP 状态码'
        $json = ConvertFrom-JsonSafe -Text $response.Content -What 'messages 响应'
        Assert-Equal 'message' $json.type '响应 type'
        Assert-True ([int]$json.usage.output_tokens -gt 0) 'usage.output_tokens 应大于 0'
        Assert-True ([string]$json.content[0].text.Length -gt 0) 'content[0].text 不能为空'
        Assert-NotContains $response.Content $UpstreamAnthropicKey '转发响应'
    }

    # ---- 12) SSE 流式转发 ------------------------------------------------
    Invoke-Step 'SSE 流式转发（stream:true）返回 text/event-stream 且逐条事件完整' {
        Assert-True ($state.ApiKey.Length -gt 0) '依赖的前置步骤失败：API Key 未创建'
        $payload = @{
            model      = 'stub-anthropic-model'
            max_tokens = 64
            stream     = $true
            messages   = @(@{ role = 'user'; content = 'stream please' })
        } | ConvertTo-Json -Compress -Depth 8

        $headers = @{ 'x-api-key' = $state.ApiKey; 'accept' = 'text/event-stream' }
        $response = Invoke-GatewayRequest -Method POST -Path '/api/v1/messages' -Headers $headers -Body $payload -TimeoutSec 90
        Assert-Equal 200 $response.Status 'HTTP 状态码'
        $contentType = Get-HeaderValue -Headers $response.Headers -Name 'Content-Type'
        Assert-Contains $contentType 'text/event-stream' 'Content-Type'
        Assert-Contains $response.Content 'event: message_start' 'SSE 内容'
        Assert-Contains $response.Content 'event: content_block_delta' 'SSE 内容'
        Assert-Contains $response.Content 'event: message_stop' 'SSE 内容'
        Assert-Contains $response.Content 'data: {' 'SSE 内容'
    }

    # ---- 13) OpenAI 兼容转发 ---------------------------------------------
    Invoke-Step 'OpenAI 兼容转发（POST /api/v1/chat/completions，Authorization: Bearer）返回 200' {
        Assert-True ($state.ApiKey.Length -gt 0) '依赖的前置步骤失败：API Key 未创建'
        $payload = @{
            model    = 'stub-openai-model'
            messages = @(@{ role = 'user'; content = 'hello openai' })
        } | ConvertTo-Json -Compress -Depth 8

        $headers = @{ 'authorization' = "Bearer $($state.ApiKey)" }
        $response = Invoke-GatewayRequest -Method POST -Path '/api/v1/chat/completions' -Headers $headers -Body $payload
        Assert-Equal 200 $response.Status 'HTTP 状态码'
        $json = ConvertFrom-JsonSafe -Text $response.Content -What 'chat/completions 响应'
        Assert-Equal 'chat.completion' $json.object 'object'
        Assert-True ([string]$json.choices[0].message.content.Length -gt 0) 'choices[0].message.content 不能为空'
        Assert-True ([int]$json.usage.completion_tokens -gt 0) 'usage.completion_tokens 应大于 0'
    }

    # ---- 14) 模型列表 ----------------------------------------------------
    Invoke-Step '模型列表（GET /api/v1/models）返回 OpenAI 形状 list 且包含上游模型' {
        Assert-True ($state.ApiKey.Length -gt 0) '依赖的前置步骤失败：API Key 未创建'
        $headers = @{ 'x-api-key' = $state.ApiKey }
        $response = Invoke-GatewayRequest -Method GET -Path '/api/v1/models' -Headers $headers
        Assert-Equal 200 $response.Status 'HTTP 状态码'
        $json = ConvertFrom-JsonSafe -Text $response.Content -What 'models 响应'
        Assert-Equal 'list' $json.object 'object'
        Assert-True (@($json.data).Count -gt 0) 'data 不能为空'
        $modelIds = @($json.data | ForEach-Object { [string]$_.id })
        Assert-True ($modelIds -contains 'stub-anthropic-model') 'data 中缺少 stub-anthropic-model'
        Write-Host ("      | models: " + ([string]::Join(', ', $modelIds)))
    }

    # ---- 15) C9：上游凭证注入 + 入站凭证剥离 -----------------------------
    Invoke-Step 'C9 校验：上游只收到 Provider 凭证，客户端 ar- Key 从未泄漏' {
        Assert-True ($state.StubPort -gt 0) '依赖的前置步骤失败：桩上游不可用'
        $response = Invoke-HttpRequest -Method GET -Url "http://127.0.0.1:$($state.StubPort)/__stub/state" -TimeoutSec 20
        Assert-Equal 200 $response.Status '桩上游 /__stub/state 状态码'
        $json = ConvertFrom-JsonSafe -Text $response.Content -What '桩上游状态'
        $records = @($json.requests)
        Assert-True ($records.Count -gt 0) '桩上游没有收到任何请求'

        $leaks = @($records | Where-Object { $_.credentialLeak -eq $true })
        Assert-Equal 0 $leaks.Count '泄漏客户端 Key 的上游请求数'

        $anthropic = @($records | Where-Object { $_.path -eq '/v1/messages' })
        Assert-True ($anthropic.Count -gt 0) '桩上游没有收到 /v1/messages'
        $injectedAnthropic = @($anthropic | Where-Object { $_.apiKeyValue -eq $UpstreamAnthropicKey })
        Assert-True ($injectedAnthropic.Count -eq $anthropic.Count) 'anthropic 请求没有全部使用 Provider 凭证（x-api-key 注入失败）'
        $withVersion = @($anthropic | Where-Object { $_.anthropicVersion -eq '2023-06-01' })
        Assert-True ($withVersion.Count -gt 0) '上游请求缺少 anthropic-version: 2023-06-01 默认值'

        $openAi = @($records | Where-Object { $_.path -eq '/v1/chat/completions' })
        Assert-True ($openAi.Count -gt 0) '桩上游没有收到 /v1/chat/completions'
        $injectedOpenAi = @($openAi | Where-Object { $_.authorizationValue -eq "Bearer $UpstreamOpenAiKey" })
        Assert-True ($injectedOpenAi.Count -eq $openAi.Count) 'openai 请求没有全部使用 Provider 凭证（Authorization 注入失败）'
        Write-Host ("      | 上游共收到 " + $records.Count + " 次请求，凭证泄漏 0 次")
    }

    # ---- 16) 坏 Key 401 --------------------------------------------------
    Invoke-Step '无效 API Key 返回 401 且 error.type=authentication_error，且不触达上游' {
        Assert-True ($state.StubPort -gt 0) '依赖的前置步骤失败：桩上游不可用'
        $before = Invoke-HttpRequest -Method GET -Url "http://127.0.0.1:$($state.StubPort)/__stub/state" -TimeoutSec 20
        $beforeCount = [int]((ConvertFrom-JsonSafe -Text $before.Content -What '桩上游状态').count)

        $badKey = 'ar-' + ('0' * 32)
        $payload = @{
            model      = 'stub-anthropic-model'
            max_tokens = 8
            messages   = @(@{ role = 'user'; content = 'should be rejected' })
        } | ConvertTo-Json -Compress -Depth 8
        $headers = @{ 'x-api-key' = $badKey }
        $response = Invoke-GatewayRequest -Method POST -Path '/api/v1/messages' -Headers $headers -Body $payload
        Assert-Equal 401 $response.Status 'HTTP 状态码'
        $json = ConvertFrom-JsonSafe -Text $response.Content -What '坏 key 响应'
        Assert-Equal 'error' $json.type '外层 type'
        Assert-Equal 'authentication_error' $json.error.type 'error.error.type'

        $after = Invoke-HttpRequest -Method GET -Url "http://127.0.0.1:$($state.StubPort)/__stub/state" -TimeoutSec 20
        $afterCount = [int]((ConvertFrom-JsonSafe -Text $after.Content -What '桩上游状态').count)
        Assert-Equal $beforeCount $afterCount '鉴权失败不应向上游发起请求'
    }

    # ---- 17) 请求日志 ----------------------------------------------------
    Invoke-Step '请求日志（GET /api/admin/logs）记录了转发并保持脱敏' {
        $response = Invoke-GatewayRequest -Method GET -Path '/api/admin/logs?limit=50' -UseSession
        Assert-Equal 200 $response.Status 'HTTP 状态码'
        $json = ConvertFrom-JsonSafe -Text $response.Content -What '日志响应'
        $entries = @($json.data)
        Assert-True ($entries.Count -gt 0) 'data 不能为空'
        Assert-True ($json.PSObject.Properties.Name -contains 'nextCursor') '响应缺少 nextCursor 字段'

        $messages = @($entries | Where-Object { $_.path -eq '/v1/messages' -and [int]$_.status -eq 200 })
        Assert-True ($messages.Count -gt 0) '日志中没有 /v1/messages 的成功记录'
        $streamed = @($entries | Where-Object { $_.stream -eq $true })
        Assert-True ($streamed.Count -gt 0) '日志中没有 stream:true 的记录'
        $withTokens = @($entries | Where-Object { $_.outputTokens -ne $null -and [int]$_.outputTokens -gt 0 })
        Assert-True ($withTokens.Count -gt 0) '日志中没有解析出 outputTokens 的记录'
        $withKey = @($entries | Where-Object { $_.apiKeyId -eq $state.ApiKeyId })
        Assert-True ($withKey.Count -gt 0) '日志没有关联到本次创建的 API Key'
        Assert-NotContains $response.Content $UpstreamAnthropicKey '日志响应'
        Assert-NotContains $response.Content $state.ApiKey '日志响应'
        Write-Host ("      | 共 " + $entries.Count + " 条日志，nextCursor=" + [string]$json.nextCursor)
    }

    # ---- 18) 用量统计 ----------------------------------------------------
    Invoke-Step '用量统计（GET /api/admin/stats?range=24h）totals.requests > 0 且与日志条数一致' {
        $response = Invoke-GatewayRequest -Method GET -Path '/api/admin/stats?range=24h' -UseSession
        Assert-Equal 200 $response.Status 'HTTP 状态码'
        $json = ConvertFrom-JsonSafe -Text $response.Content -What '统计响应'
        Assert-Equal '24h' $json.data.range 'data.range'
        $totalRequests = [int]$json.data.totals.requests
        Assert-True ($totalRequests -gt 0) 'totals.requests 应大于 0'
        Assert-True (@($json.data.series).Count -gt 0) 'series 不能为空'
        Assert-True (@($json.data.byModel).Count -gt 0) 'byModel 不能为空'

        $logs = Invoke-GatewayRequest -Method GET -Path '/api/admin/logs?limit=200' -UseSession
        Assert-Equal 200 $logs.Status '日志接口状态码'
        $logJson = ConvertFrom-JsonSafe -Text $logs.Content -What '日志响应'
        $allLogs = @($logJson.data)
        # totals.requests 统计的是 range=24h **窗口内**的行数，而 /api/admin/logs 返回的是全部时间里
        # 最新的一页。data/aragon.db 会被多次运行复用：一旦库里留下超过 24h 的历史行，直接拿"本页
        # 条数"与窗口总量比大小，就会得出与网关行为无关的 FAIL（例如库里 300 行、其中只有 150 行落在
        # 24h 内时：窗口内 150 条 vs 本页 200 条）。这里先把本页按 24h 窗口过滤，再作比较。
        $windowStart = (Get-Date).ToUniversalTime().AddHours(-24)
        $recentLogs = @($allLogs | Where-Object {
                $isRecent = $false
                try { $isRecent = (([datetime]$_.createdAt).ToUniversalTime() -ge $windowStart) } catch { $isRecent = $false }
                $isRecent
            })
        $logCount = $recentLogs.Count
        if ($allLogs.Count -lt 200) {
            # 全部行都在这一页里：C7 要求 totals.requests 等于 24h 窗口内的 request_logs 行数。
            Assert-Equal $totalRequests $logCount 'totals.requests 与日志条数（24h 窗口内）'
        }
        else {
            Assert-True ($totalRequests -ge $logCount) 'totals.requests 不应少于本页 24h 窗口内的日志条数'
        }
        Write-Host ("      | totals.requests=" + $totalRequests + " (24h 内日志=" + $logCount + " / 本页 " + $allLogs.Count + " 条)")
    }

    # ---- 19) 清理测试数据 ------------------------------------------------
    Invoke-Step '清理测试数据（删除本次创建的 provider / API Key，恢复历史 provider）' {
        $problems = Invoke-TestDataCleanup
        $state.CleanupDone = $true
        Assert-Equal 0 $problems '清理问题数'
        Write-Host ("      | 已删除 provider " + $state.CreatedProviders.Count + " 个、API Key 1 个，恢复历史 provider " + $state.DisabledProviders.Count + " 个")
    }

    # ---- 20/21) 停机链路；-KeepServer 时改为断言现场被保留 -----------------
    if ($KeepServer) {
        # -KeepServer 的语义是“保留开发服务器便于手动排查”，所以停机、端口释放断言与幂等停机
        # 必须整体跳过：一边停掉一边断言保留是互相矛盾的（旧实现只跳过 finally 的兜底停机，
        # 于是参数名与实际行为不符）。
        Invoke-Step '保留现场（-KeepServer）：服务仍可访问、运行期产物未清理、口令仍可登录' {
            Assert-True ($state.Port -gt 0) '依赖的前置步骤失败：未记录端口'
            Assert-True (Test-HttpReady -Url "$($state.BaseUrl)/api/admin/session" -TimeoutSec 10) "服务不再响应 $($state.BaseUrl)/api/admin/session"
            Assert-True (Test-Path -LiteralPath $artifacts.PidFile) '.dev-server.pid 被意外清理（无法按 PID 停止）'
            Assert-True (Test-Path -LiteralPath $artifacts.PortFile) '.dev-server.port 被意外清理'
            Assert-Equal ([string]$state.Port) (Read-FirstLine -Path $artifacts.PortFile) '.dev-server.port 记录值'

            # 现场可排查的前提是还能登录；用一个全新的会话验证口令仍然有效。
            $probeSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession
            $probeBody = @{ password = $state.AdminPassword } | ConvertTo-Json -Compress
            $probeLogin = Invoke-HttpRequest -Method POST -Url ($state.BaseUrl + '/api/admin/session') -Body $probeBody -WebSession $probeSession -TimeoutSec 20
            Assert-Equal 200 $probeLogin.Status '保留现场后的管理员登录状态码'

            Write-Host ("      | 服务保留在 " + $state.BaseUrl + "（管理员口令仍有效，可继续手工排查）")
            Write-Host '      | 停止命令: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stop-dev.ps1'
        }
    }
    else {
        # ---- 20) 停机并断言端口释放 -------------------------------------
        Invoke-Step '停机（scripts/stop-dev.ps1）后端口释放且运行期产物被清理' {
            Assert-True ($state.Port -gt 0) '依赖的前置步骤失败：未记录端口'
            $native = Invoke-PowerShellScript -ScriptPath $artifacts.StopScript
            Write-NativeOutput -Native $native
            Assert-Equal 0 $native.ExitCode 'stop-dev.ps1 退出码'
            $state.ServerStopped = $true

            Assert-True (-not (Test-TcpConnect -Port $state.Port -TimeoutMs 800)) "端口 $($state.Port) 仍可连接，未真正释放"
            Assert-True (-not (Test-PortInUse -Port $state.Port)) "端口 $($state.Port) 仍被监听"
            Assert-True (-not (Test-Path -LiteralPath $artifacts.PidFile)) '.dev-server.pid 未被清理'
            Assert-True (-not (Test-Path -LiteralPath $artifacts.PortFile)) '.dev-server.port 未被清理'
        }

        # ---- 21) 幂等停机 -----------------------------------------------
        Invoke-Step '重复执行 stop-dev.ps1 幂等（退出码 0）' {
            $native = Invoke-PowerShellScript -ScriptPath $artifacts.StopScript
            Write-NativeOutput -Native $native
            Assert-Equal 0 $native.ExitCode '第二次 stop-dev.ps1 退出码'
        }
    }
}
catch {
    # 致命错误（不是普通断言失败）：例如 -AbortAfterStep 自检注入、或某个步骤之外的地方抛异常。
    # 这里只记录，真正的收尾交给 finally —— 下面的断言与汇总都会把它算作失败。
    $script:FatalMessage = $_.Exception.Message
    Write-Host ''
    Write-Host ("FATAL 运行被中断：" + $script:FatalMessage) -ForegroundColor Red
    Write-Host '      收尾停机仍会在 finally 中执行（停止服务 → 断言端口释放 → 清理运行期产物）。' -ForegroundColor Yellow
}
finally {
    # 兜底清理顺序：仅在服务器还活着（例如上面的清理步骤没跑到）时执行，
    # 然后再停桩上游，最后停开发服务器（stop-dev.ps1 幂等）。
    if (-not $state.CleanupDone) {
        try {
            $leftovers = Invoke-TestDataCleanup
            if ($leftovers -gt 0) {
                Write-Host "兜底清理未完全成功（$leftovers 项），可稍后手动在控制台删除残留的 provider / key。" -ForegroundColor Yellow
            }
        }
        catch {
            Write-Host "兜底清理失败：$($_.Exception.Message)" -ForegroundColor Yellow
        }
    }

    if ($null -ne $state.StubProc) {
        try {
            if (-not $state.StubProc.HasExited) {
                Stop-ProcessTree -ProcessId $state.StubProc.Id | Out-Null
                Wait-ProcessGone -ProcessId $state.StubProc.Id -TimeoutSeconds 10 | Out-Null
            }
        }
        catch {
            Write-Host "清理桩上游时出现问题：$($_.Exception.Message)" -ForegroundColor Yellow
        }
    }

    # 收尾时要断言的端口：优先用步骤里记下的，其次回读 .dev-server.port
    # （启动步骤"只成功了一半"时，$state.Port 可能还是 0，但记录文件已经写下去了）。
    $cleanupPort = $state.Port
    if ($cleanupPort -le 0) { $cleanupPort = Read-DevPort -Artifacts $artifacts }

    if ($KeepServer) {
        if ($state.Port -gt 0) {
            Write-Host ''
            Write-Host "已指定 -KeepServer：开发服务器保持运行 $($state.BaseUrl)" -ForegroundColor Yellow
            Write-Host '  停止命令: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stop-dev.ps1'
        }
    }
    else {
        $stopExit = 1
        try {
            $cleanup = Invoke-PowerShellScript -ScriptPath $artifacts.StopScript -ScriptArguments @('-Quiet')
            $stopExit = $cleanup.ExitCode
            if ($cleanup.ExitCode -ne 0) {
                Write-Host '兜底停止服务时出现问题：' -ForegroundColor Yellow
                Write-NativeOutput -Native $cleanup
            }
            $state.ServerStopped = $true
        }
        catch {
            $stopExit = 1
            Write-Host "兜底停止服务失败：$($_.Exception.Message)" -ForegroundColor Yellow
        }

        # “结束时必调 stop-dev.ps1”如果只确认"调用过"，失败的运行仍然会以 0 退出，
        # 运维看到的是一台还占着端口的孤儿服务。这里逐项核对：退出码、端口、运行期产物。
        $violations = New-Object System.Collections.Generic.List[string]
        if ($stopExit -ne 0) { $violations.Add("stop-dev.ps1 退出码 $stopExit") }
        if ($cleanupPort -gt 0) {
            if (-not (Wait-PortFree -Port $cleanupPort -TimeoutSeconds 15)) {
                $stillListening = Test-PortInUse -Port $cleanupPort
                if ($stillListening) { $violations.Add("端口 $cleanupPort 在收尾停机后仍在监听") }
            }
        }
        foreach ($path in @($artifacts.PidFile, $artifacts.PortFile)) {
            if (Test-Path -LiteralPath $path) { $violations.Add("运行期产物 $path 未被清理") }
        }

        if ($violations.Count -gt 0) {
            $script:FinallyStopFailed = $true
            Write-Host ''
            Write-Host '收尾停机验证失败（服务可能仍在运行，请手动处理）：' -ForegroundColor Red
            foreach ($violation in $violations) { Write-Host ("  - " + $violation) -ForegroundColor Red }
            Write-Host '  手动处理: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stop-dev.ps1' -ForegroundColor Red
        }
        elseif ($script:Failed -gt 0 -or $script:FatalMessage.Length -gt 0) {
            # 有失败时也明确写出"服务已经停干净了"，避免操作员误以为还需要再收拾现场。
            Write-Host ''
            Write-Host ("收尾停机完成：端口 " + $cleanupPort + " 已释放，运行期产物已清理。") -ForegroundColor Yellow
        }
    }
}

# ---------------------------------------------------------------------------
# 汇总
# ---------------------------------------------------------------------------
$total = $script:Passed + $script:Failed
Write-Host ''
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ("RESULT: {0}/{1} PASS, {2} FAIL" -f $script:Passed, $total, $script:Failed) -ForegroundColor Cyan
Write-Host '============================================================' -ForegroundColor Cyan

if ($script:Failed -gt 0 -or $script:FatalMessage.Length -gt 0 -or $script:FinallyStopFailed) {
    Write-Host '失败明细：' -ForegroundColor Red
    if ($script:FatalMessage.Length -gt 0) {
        Write-Host ("  - FATAL 运行被中断：" + $script:FatalMessage) -ForegroundColor Red
    }
    foreach ($detail in $script:FailureDetails) { Write-Host ("  - " + $detail) -ForegroundColor Red }
    if ($script:FinallyStopFailed) {
        Write-Host '  - 收尾停机未能释放服务端口或清理运行期产物，请手动运行 scripts\stop-dev.ps1 检查。' -ForegroundColor Red
    }
    exit 1
}

if ($KeepServer) {
    Write-Host ("全部断言通过（-KeepServer）：开发服务器保留在 " + $state.BaseUrl + "，可继续手工排查（日志见 .dev-logs/dev.log）。") -ForegroundColor Green
    Write-Host '停止命令: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stop-dev.ps1' -ForegroundColor Yellow
}
else {
    Write-Host '全部断言通过：转发、流式、鉴权、日志、统计、启停链路均正常。' -ForegroundColor Green
}
exit 0
