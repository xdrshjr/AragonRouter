#Requires -Version 5.1
<#
.SYNOPSIS
    AragonRouter 开发脚本公共函数库。

.DESCRIPTION
    scripts/start-dev.ps1、scripts/stop-dev.ps1、scripts/test-api.ps1 通过点源方式加载本文件。
    这里只放不带副作用的小工具：项目根目录解析、运行期产物路径、端口探测、HTTP 探测、
    .env.local 读写、原生命令调用与进程树终止。进程退出码和面向用户的提示留在各入口脚本中。

.NOTES
    兼容 Windows PowerShell 5.1 与 PowerShell 7+，不依赖任何第三方模块，也不会联网。
    所有函数都不写日志文件、不修改全局状态（唯一例外：Invoke-NativeCommand 临时调整
    $ErrorActionPreference，并在 finally 中还原）。
#>

function Resolve-ProjectRoot {
    <#
    .SYNOPSIS
        从给定目录向上查找包含 package.json 的目录，作为项目根目录。
    .PARAMETER StartPath
        起始目录（通常是入口脚本的 $PSScriptRoot）。
    .DESCRIPTION
        只向上查找有限层数（入口脚本位于 <root>\scripts 或 <root>\scripts\lib，因此 2 层足够）。
        这不是洁癖：无上限地往上爬会命中一个**无关**的上层 package.json（例如用户主目录里遗留的
        那个），随后脚本的所有运行期产物（.dev-server.pid / .dev-server.port / .dev-logs）都会
        落到那个目录里，stop-dev.ps1 甚至会去结束"那个仓库"的进程。宁可直接报错，也不要操作错目录。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$StartPath
    )

    $current = $StartPath
    for ($i = 0; $i -le 2; $i++) {
        if ([string]::IsNullOrWhiteSpace($current)) { break }
        if (Test-Path -LiteralPath (Join-Path $current 'package.json')) {
            return (Resolve-Path -LiteralPath $current).Path
        }
        $parent = Split-Path -Parent $current
        if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $current) { break }
        $current = $parent
    }
    throw "无法定位项目根目录：从 '$StartPath' 向上未找到 package.json。请在仓库内（scripts\ 的上一级）运行脚本。"
}

function Get-DevArtifacts {
    <#
    .SYNOPSIS
        返回脚本运行期产物（C11）的绝对路径集合。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProjectRoot
    )

    $logDir = Join-Path $ProjectRoot '.dev-logs'
    return [pscustomobject]@{
        Root            = $ProjectRoot
        PidFile         = Join-Path $ProjectRoot '.dev-server.pid'
        PortFile        = Join-Path $ProjectRoot '.dev-server.port'
        LogDir          = $logDir
        LogFile         = Join-Path $logDir 'dev.log'
        ErrLogFile      = Join-Path $logDir 'dev.err.log'
        StubLogFile     = Join-Path $logDir 'stub-upstream.log'
        StubErrLogFile  = Join-Path $logDir 'stub-upstream.err.log'
        EnvFile         = Join-Path $ProjectRoot '.env.local'
        EnvExampleFile  = Join-Path $ProjectRoot '.env.example'
        StartScript     = Join-Path (Join-Path $ProjectRoot 'scripts') 'start-dev.ps1'
        StopScript      = Join-Path (Join-Path $ProjectRoot 'scripts') 'stop-dev.ps1'
        TestScript      = Join-Path (Join-Path $ProjectRoot 'scripts') 'test-api.ps1'
        StubScript      = Join-Path (Join-Path $ProjectRoot 'tests\integration') 'stub-upstream.mjs'
        NodeModulesDir  = Join-Path $ProjectRoot 'node_modules'
        NextPackageFile = Join-Path (Join-Path (Join-Path $ProjectRoot 'node_modules') 'next') 'package.json'
    }
}

function Read-TextFileShared {
    <#
    .SYNOPSIS
        以 FileShare.ReadWrite 读取文本文件。
    .DESCRIPTION
        由脚本拉起的后台进程（dev server）会继承日志文件的句柄，此时普通的
        [System.IO.File]::ReadAllText / Get-Content 会因共享冲突失败（"正由另一进程使用"）。
        这里显式允许共享读写，保证在服务运行期间也能读取日志与运行期产物。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $stream = $null
    $reader = $null
    try {
        $stream = [System.IO.File]::Open(
            $Path,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::ReadWrite
        )
        $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
        return $reader.ReadToEnd()
    }
    catch {
        return $null
    }
    finally {
        if ($null -ne $reader) { try { $reader.Dispose() } catch { } }
        if ($null -ne $stream) { try { $stream.Dispose() } catch { } }
    }
}

function Read-FirstLine {
    <#
    .SYNOPSIS
        读取文件第一行非空内容（用于 .dev-server.pid / .dev-server.port）。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $text = Read-TextFileShared -Path $Path
    if ([string]::IsNullOrWhiteSpace($text)) { return $null }
    foreach ($line in ($text -split "`r?`n")) {
        $trimmed = $line.Trim()
        if ($trimmed.Length -gt 0) { return $trimmed }
    }
    return $null
}

function Read-DevPort {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        $Artifacts
    )

    $raw = Read-FirstLine -Path $Artifacts.PortFile
    if ([string]::IsNullOrWhiteSpace($raw)) { return 0 }
    $port = 0
    if ([int]::TryParse($raw, [ref]$port) -and $port -gt 0 -and $port -lt 65536) { return $port }
    return 0
}

function Read-DevPid {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        $Artifacts
    )

    $raw = Read-FirstLine -Path $Artifacts.PidFile
    if ([string]::IsNullOrWhiteSpace($raw)) { return 0 }
    $processId = 0
    if ([int]::TryParse($raw, [ref]$processId) -and $processId -gt 0) { return $processId }
    return 0
}

function Test-TcpConnect {
    <#
    .SYNOPSIS
        尝试与 host:port 建立 TCP 连接。能连上说明该端口已被占用/服务已监听。
    #>
    [CmdletBinding()]
    param(
        [string]$TargetHost = '127.0.0.1',
        [Parameter(Mandatory = $true)]
        [int]$Port,
        [int]$TimeoutMs = 400
    )

    if ($Port -le 0 -or $Port -gt 65535) { return $false }
    $client = $null
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $async = $client.BeginConnect($TargetHost, $Port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) {
            return $false
        }
        $client.EndConnect($async)
        return $true
    }
    catch {
        return $false
    }
    finally {
        if ($null -ne $client) {
            try { $client.Close() } catch { }
        }
    }
}

function Get-PortOwnerPids {
    <#
    .SYNOPSIS
        返回监听指定 TCP 端口的进程 ID 列表（Get-NetTCPConnection 优先，netstat 兜底）。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [int]$Port
    )

    $owners = New-Object System.Collections.Generic.List[int]
    if ($Port -le 0) { return @() }

    $connections = $null
    try {
        $connections = Get-NetTCPConnection -LocalPort $Port -ErrorAction Stop
    }
    catch {
        $connections = $null
    }
    if ($null -ne $connections) {
        foreach ($connection in $connections) {
            $owner = 0
            try { $owner = [int]$connection.OwningProcess } catch { continue }
            if ($owner -gt 0 -and -not $owners.Contains($owner)) { $owners.Add($owner) }
        }
    }

    if ($owners.Count -eq 0) {
        # 兜底：解析 netstat（某些精简系统上没有 NetTCPIP 模块）
        $netstat = Join-Path $env:SystemRoot 'System32\netstat.exe'
        if (-not (Test-Path -LiteralPath $netstat)) { $netstat = 'netstat.exe' }
        $native = Invoke-NativeCommand -FilePath $netstat -Arguments @('-ano', '-p', 'TCP') -MergeStderr
        foreach ($line in $native.Output) {
            if ($line -match "^\s*TCP\s+\S+:$Port\s+\S+\s+LISTENING\s+(\d+)\s*$") {
                $owner = [int]$Matches[1]
                if ($owner -gt 0 -and -not $owners.Contains($owner)) { $owners.Add($owner) }
            }
        }
    }
    return $owners.ToArray()
}

function Test-PortInUse {
    <#
    .SYNOPSIS
        端口是否已被占用（TCP 可连接，或系统报告存在监听者）。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [int]$Port
    )

    if ($Port -le 0 -or $Port -gt 65535) { return $false }
    if (Test-TcpConnect -Port $Port -TimeoutMs 300) { return $true }
    $owners = Get-PortOwnerPids -Port $Port
    return ($owners.Count -gt 0)
}

function Test-PortBindable {
    <#
    .SYNOPSIS
        当前进程能否真正绑定 127.0.0.1:Port（排除系统保留端口等情况）。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [int]$Port
    )

    if ($Port -le 0 -or $Port -gt 65535) { return $false }
    $listener = $null
    try {
        $address = [System.Net.IPAddress]::Parse('127.0.0.1')
        $listener = New-Object System.Net.Sockets.TcpListener($address, $Port)
        $listener.Start()
        return $true
    }
    catch {
        return $false
    }
    finally {
        if ($null -ne $listener) {
            try { $listener.Stop() } catch { }
        }
    }
}

function Find-FreePort {
    <#
    .SYNOPSIS
        从 StartPort 起递增寻找一个空闲端口，找不到返回 0。
    .DESCRIPTION
        端口不硬编码：默认从 3000 开始试，最多扫描 Attempts 个；3000 被占用就顺延到 3001、3002……
    #>
    [CmdletBinding()]
    param(
        [int]$StartPort = 3000,
        [int]$Attempts = 50
    )

    if ($StartPort -le 0 -or $StartPort -gt 65535) { return 0 }
    $last = [Math]::Min(65535, $StartPort + $Attempts - 1)
    for ($candidate = $StartPort; $candidate -le $last; $candidate++) {
        if (Test-PortInUse -Port $candidate) { continue }
        if (-not (Test-PortBindable -Port $candidate)) { continue }
        return $candidate
    }
    return 0
}

function Wait-PortFree {
    <#
    .SYNOPSIS
        轮询等待端口释放，超时返回 $false。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [int]$Port,
        [int]$TimeoutSeconds = 15,
        [int]$IntervalMs = 250
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ($true) {
        if (-not (Test-PortInUse -Port $Port)) { return $true }
        if ((Get-Date) -ge $deadline) { return $false }
        Start-Sleep -Milliseconds $IntervalMs
    }
}

function Get-HeaderValue {
    <#
    .SYNOPSIS
        大小写不敏感地读取响应头（兼容 Invoke-WebRequest 的 Hashtable 与 WebHeaderCollection）。
    #>
    [CmdletBinding()]
    param(
        $Headers,
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    if ($null -eq $Headers) { return '' }
    try {
        # PowerShell 7：Invoke-WebRequest 返回 System.Net.Http.Headers.HttpResponseHeaders /
        # HttpContentHeaders。它们没有 Keys 索引器（下面的通用循环会遍历 $null 并直接落到
        # return ''），只能用 TryGetValues 读取；否则在 PS7 上 Set-Cookie / Content-Type
        # 断言会被读成空串。
        # 这里刻意用类型名比较而不写 [System.Net.Http.Headers.HttpHeaders] 类型字面量：
        # Windows PowerShell 5.1 默认没有加载 System.Net.Http 程序集，类型字面量会抛
        # "Unable to find type"，而这个函数在 5.1 上是每次请求都会走的路径。
        $headerTypeName = $Headers.GetType().FullName
        if ($headerTypeName -eq 'System.Net.Http.Headers.HttpResponseHeaders' -or
            $headerTypeName -eq 'System.Net.Http.Headers.HttpContentHeaders') {
            $values = $null
            if ($Headers.TryGetValues($Name, [ref]$values)) {
                return ([string]::Join(', ', @($values)))
            }
            return ''
        }
    }
    catch { }
    try {
        if ($Headers -is [System.Net.WebHeaderCollection]) {
            $value = $Headers[$Name]
            if ($null -ne $value) { return [string]$value }
        }
    }
    catch { }
    try {
        foreach ($key in $Headers.Keys) {
            if ([string]::Equals([string]$key, $Name, [System.StringComparison]::OrdinalIgnoreCase)) {
                return [string]$Headers[$key]
            }
        }
    }
    catch { }
    return ''
}

function Test-HttpReady {
    <#
    .SYNOPSIS
        HTTP 就绪探测：只要拿到任何 HTTP 响应（含 4xx）就视为服务已就绪。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Url,
        [int]$TimeoutSec = 3
    )

    $response = $null
    try {
        $response = Invoke-WebRequest -Uri $Url -Method GET -UseBasicParsing -TimeoutSec $TimeoutSec -ErrorAction Stop
        return $true
    }
    catch {
        $errorResponse = $null
        if ($_.Exception.PSObject.Properties['Response']) { $errorResponse = $_.Exception.Response }
        if ($null -eq $errorResponse) { return $false }
        try { $errorResponse.Close() } catch { }
        return $true
    }
    finally {
        if ($null -ne $response) {
            try { $response.Dispose() } catch { }
        }
    }
}

function Invoke-HttpRequest {
    <#
    .SYNOPSIS
        发送一次 HTTP 请求，返回 { Status, Content, Headers, Raw }，非 2xx 也不抛异常。
    .DESCRIPTION
        Invoke-WebRequest 在 5.1 与 7+ 上都会对 4xx/5xx 抛异常，这里统一转换成返回对象，
        以便测试脚本对状态码做断言。传入 -WebSession 时 Cookie 会被保存到该会话中。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Method,
        [Parameter(Mandatory = $true)]
        [string]$Url,
        [hashtable]$Headers,
        [string]$Body,
        $WebSession,
        [int]$TimeoutSec = 30
    )

    $parameters = @{
        Uri             = $Url
        Method          = $Method.ToUpperInvariant()
        UseBasicParsing = $true
        TimeoutSec      = $TimeoutSec
        ErrorAction     = 'Stop'
    }
    if ($null -ne $Headers -and $Headers.Count -gt 0) { $parameters['Headers'] = $Headers }
    if ($PSBoundParameters.ContainsKey('Body') -and $null -ne $Body) {
        $parameters['Body'] = $Body
        $parameters['ContentType'] = 'application/json; charset=utf-8'
    }
    if ($null -ne $WebSession) { $parameters['WebSession'] = $WebSession }

    try {
        $response = Invoke-WebRequest @parameters
        $status = 200
        try { $status = [int]$response.StatusCode } catch { $status = 200 }
        $content = ''
        try { $content = [string]$response.Content } catch { $content = '' }
        return [pscustomobject]@{
            Status     = $status
            Content    = $content
            Headers    = $response.Headers
            Raw        = $response
            WebSession = $WebSession
        }
    }
    catch {
        $errorResponse = $null
        if ($_.Exception.PSObject.Properties['Response']) { $errorResponse = $_.Exception.Response }
        if ($null -eq $errorResponse) { throw }
        $status = 0
        try { $status = [int]$errorResponse.StatusCode } catch { $status = 0 }
        $content = ''
        try {
            $stream = $errorResponse.GetResponseStream()
            if ($null -ne $stream) {
                $reader = New-Object System.IO.StreamReader($stream)
                $content = $reader.ReadToEnd()
                $reader.Dispose()
                $stream.Dispose()
            }
        }
        catch {
            $content = ''
        }
        $headers = $null
        try { $headers = $errorResponse.Headers } catch { $headers = $null }
        try { $errorResponse.Close() } catch { }
        return [pscustomobject]@{
            Status     = $status
            Content    = $content
            Headers    = $headers
            Raw        = $null
            WebSession = $WebSession
        }
    }
}

function Invoke-NativeCommand {
    <#
    .SYNOPSIS
        执行原生命令并返回 { ExitCode, Output }。
    .DESCRIPTION
        Windows PowerShell 5.1 在 $ErrorActionPreference = 'Stop' 且合并 stderr 时，
        原生命令往 stderr 写内容会被当成 NativeCommandError 抛出（node 的实验特性警告就会触发）。
        这里临时切换为 Continue 并在此后还原，避免脚本因为一条警告而中断。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [string[]]$Arguments = @(),
        [switch]$MergeStderr
    )

    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $output = @()
    $exitCode = 0
    try {
        if ($MergeStderr) {
            $output = & $FilePath @Arguments 2>&1
        }
        else {
            $output = & $FilePath @Arguments
        }
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previous
    }
    $lines = @()
    foreach ($item in @($output)) { $lines += [string]$item }
    return [pscustomobject]@{ ExitCode = $exitCode; Output = $lines }
}

function Get-NodeExecutable {
    <#
    .SYNOPSIS
        返回 node 可执行文件路径；找不到时报错并给出安装指引。
    #>
    [CmdletBinding()]
    param()

    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($null -eq $command) { $command = Get-Command node -ErrorAction SilentlyContinue }
    if ($null -eq $command) {
        throw '未找到 node 命令。请安装 Node.js 22.5 或更高版本（https://nodejs.org/zh-cn/download），安装后重开终端。'
    }
    $path = $command.Path
    if ([string]::IsNullOrWhiteSpace($path)) { $path = $command.Source }
    if ([string]::IsNullOrWhiteSpace($path)) { $path = $command.Definition }
    if ([string]::IsNullOrWhiteSpace($path)) { throw '无法解析 node 可执行文件路径，请检查 PATH。' }
    return $path
}

function Get-NpmExecutable {
    <#
    .SYNOPSIS
        返回 npm 命令行路径。Windows 上 npm 是 npm.cmd 批处理，必须用 .cmd 启动。
    #>
    [CmdletBinding()]
    param()

    $command = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($null -eq $command) { $command = Get-Command npm -ErrorAction SilentlyContinue }
    if ($null -eq $command) {
        throw '未找到 npm 命令。请安装 Node.js（自带 npm）后重开终端：https://nodejs.org/zh-cn/download'
    }
    $path = $command.Path
    if ([string]::IsNullOrWhiteSpace($path)) { $path = $command.Source }
    if ([string]::IsNullOrWhiteSpace($path)) { $path = $command.Definition }
    if ([string]::IsNullOrWhiteSpace($path)) { throw '无法解析 npm 可执行文件路径，请检查 PATH。' }
    return $path
}

function New-CryptoRandomBytes {
    <#
    .SYNOPSIS
        生成密码学安全的随机字节数组。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [int]$Count
    )

    $bytes = New-Object byte[] $Count
    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
    return , $bytes
}

function New-RandomBase64Url {
    [CmdletBinding()]
    param([int]$ByteCount = 48)

    $bytes = New-CryptoRandomBytes -Count $ByteCount
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function New-RandomHex {
    [CmdletBinding()]
    param([int]$ByteCount = 32)

    $bytes = New-CryptoRandomBytes -Count $ByteCount
    return ([System.BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}

function Read-EnvFile {
    <#
    .SYNOPSIS
        把 dotenv 风格文件解析为有序字典（忽略注释/空行，去掉包裹引号）。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $map = [ordered]@{}
    if (-not (Test-Path -LiteralPath $Path)) { return $map }
    foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
        $trimmed = $line.Trim()
        if ($trimmed.Length -eq 0) { continue }
        if ($trimmed.StartsWith('#')) { continue }
        if ($trimmed.StartsWith('export ')) { $trimmed = $trimmed.Substring(7).Trim() }
        $separator = $trimmed.IndexOf('=')
        if ($separator -le 0) { continue }
        $key = $trimmed.Substring(0, $separator).Trim()
        if ($key.Length -eq 0) { continue }
        $value = $trimmed.Substring($separator + 1).Trim()
        if ($value.Length -ge 2) {
            $first = $value.Substring(0, 1)
            $last = $value.Substring($value.Length - 1, 1)
            if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
                $value = $value.Substring(1, $value.Length - 2)
            }
        }
        $map[$key] = $value
    }
    return $map
}

function Set-EnvValues {
    <#
    .SYNOPSIS
        就地更新 .env.local 中的若干键，保留文件里其它键与注释。
    .DESCRIPTION
        已有键只改值、不移动位置；缺失的键追加到文件末尾。文件不存在时创建并写入头部注释。
        使用无 BOM 的 UTF-8 写出，避免 dotenv 解析把 BOM 当成键名的一部分。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        $Values,
        [string]$HeaderComment = 'AragonRouter 本地环境变量（由 scripts/start-dev.ps1 自动生成）'
    )

    $lines = New-Object System.Collections.Generic.List[string]
    if (Test-Path -LiteralPath $Path) {
        foreach ($line in [System.IO.File]::ReadAllLines($Path)) { $lines.Add($line) }
    }
    else {
        $lines.Add("# $HeaderComment")
        $lines.Add('# 该文件包含真实密钥，已被 .gitignore 覆盖，切勿提交。')
        $lines.Add('# 需要重置时删除本文件后重新运行 scripts/start-dev.ps1。')
        $lines.Add('')
    }

    $remaining = [ordered]@{}
    foreach ($key in $Values.Keys) { $remaining[$key] = $Values[$key] }

    for ($index = 0; $index -lt $lines.Count; $index++) {
        $line = $lines[$index]
        if ($null -eq $line) { continue }
        $trimmed = $line.Trim()
        if ($trimmed.Length -eq 0) { continue }
        if ($trimmed.StartsWith('#')) { continue }
        $separator = $trimmed.IndexOf('=')
        if ($separator -le 0) { continue }
        $key = $trimmed.Substring(0, $separator).Trim()
        if ($remaining.Contains($key)) {
            $lines[$index] = "$key=$($remaining[$key])"
            $remaining.Remove($key)
        }
    }

    if ($remaining.Count -gt 0) {
        if ($lines.Count -gt 0) {
            $lastLine = ''
            if ($null -ne $lines[$lines.Count - 1]) { $lastLine = $lines[$lines.Count - 1].Trim() }
            if ($lastLine.Length -ne 0) { $lines.Add('') }
        }
        foreach ($key in $remaining.Keys) { $lines.Add("$key=$($remaining[$key])") }
    }

    $parent = Split-Path -Parent $Path
    if (-not [string]::IsNullOrWhiteSpace($parent) -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    $encoding = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false
    [System.IO.File]::WriteAllLines($Path, $lines.ToArray(), $encoding)
}

function Set-TextFile {
    <#
    .SYNOPSIS
        以 ASCII 安全的方式写单值文本文件（PID / 端口），保证读到的是纯数字。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    $parent = Split-Path -Parent $Path
    if (-not [string]::IsNullOrWhiteSpace($parent) -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    $encoding = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false
    [System.IO.File]::WriteAllText($Path, ($Value.Trim() + "`n"), $encoding)
}

function Stop-ProcessTree {
    <#
    .SYNOPSIS
        用 taskkill /PID <id> /T /F 结束整棵进程树（npm.cmd -> node -> next）。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [int]$ProcessId
    )

    if ($ProcessId -le 4) { return $false }
    $taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
    if (-not (Test-Path -LiteralPath $taskkill)) { $taskkill = 'taskkill.exe' }
    $native = Invoke-NativeCommand -FilePath $taskkill -Arguments @('/PID', [string]$ProcessId, '/T', '/F') -MergeStderr
    # taskkill: 0 表示成功，128 表示进程本身已不存在；两者都不视为错误。
    return ($native.ExitCode -eq 0 -or $native.ExitCode -eq 128)
}

function Wait-ProcessGone {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [int]$ProcessId,
        [int]$TimeoutSeconds = 10,
        [int]$IntervalMs = 200
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ($true) {
        $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
        if ($null -eq $process) { return $true }
        if ((Get-Date) -ge $deadline) { return $false }
        Start-Sleep -Milliseconds $IntervalMs
    }
}

function Get-LogTail {
    <#
    .SYNOPSIS
        读取日志文件末尾若干行，用于失败时给出可操作的诊断信息。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [int]$Lines = 40
    )

    $text = Read-TextFileShared -Path $Path
    if ([string]::IsNullOrEmpty($text)) { return @() }
    $all = @($text -split "`r?`n")
    $result = @()
    $start = [Math]::Max(0, $all.Count - $Lines)
    for ($index = $start; $index -lt $all.Count; $index++) { $result += [string]$all[$index] }
    return $result
}

function ConvertTo-PathKey {
    <#
    .SYNOPSIS
        把路径规范化为可做大小写/分隔符无关比较的键。
    .DESCRIPTION
        比较“某进程的命令行是否指回本仓库”时必须忽略 `F:\` 与 `F:/`、大小写差异和结尾分隔符，
        否则同一个目录会得出“不属于本仓库”的错误结论，进而误杀或漏杀进程。
    #>
    [CmdletBinding()]
    param(
        [string]$Path
    )

    if ([string]::IsNullOrWhiteSpace($Path)) { return '' }
    $normalized = $Path.Trim()
    if ($normalized.Length -ge 2 -and $normalized.StartsWith('"') -and $normalized.EndsWith('"')) {
        $normalized = $normalized.Substring(1, $normalized.Length - 2)
    }
    $normalized = $normalized.Replace('/', '\')
    while ($normalized.Length -gt 3 -and $normalized.EndsWith('\')) {
        $normalized = $normalized.Substring(0, $normalized.Length - 1)
    }
    return $normalized.ToLowerInvariant()
}

function Test-PathKeyInsideText {
    <#
    .SYNOPSIS
        判断一段文本（通常是进程命令行）里是否出现了指定目录，并且匹配处在目录边界上。
    .DESCRIPTION
        只做 `IndexOf` 会把 `...\aragon-router-old` 也当成 `...\aragon-router`，因此匹配位置之后
        必须紧跟路径分隔符、引号、空白、引号结束或字符串末尾。
    #>
    [CmdletBinding()]
    param(
        [string]$Text,
        [string]$PathKey
    )

    if ([string]::IsNullOrEmpty($Text) -or [string]::IsNullOrWhiteSpace($PathKey)) { return $false }
    $haystack = $Text.Replace('/', '\').ToLowerInvariant()
    $index = $haystack.IndexOf($PathKey)
    while ($index -ge 0) {
        $after = $index + $PathKey.Length
        if ($after -ge $haystack.Length) { return $true }
        $next = $haystack.Substring($after, 1)
        if ($next -eq '\' -or $next -eq '"' -or $next -eq "'" -or $next -eq ' ' -or $next -eq ';' -or $next -eq ',' -or $next -eq '=') {
            return $true
        }
        $index = $haystack.IndexOf($PathKey, $index + 1)
    }
    return $false
}

function Get-ProcessSnapshot {
    <#
    .SYNOPSIS
        取一份进程快照（PID / 父 PID / 进程名 / 命令行 / 可执行文件路径）。
    .DESCRIPTION
        用于判断“占用端口的进程到底是不是本仓库的 dev server”。命令行只能从 CIM/WMI 拿到，
        拿不到时返回 $null —— 调用方必须据此走保守分支，而不是猜。
    #>
    [CmdletBinding()]
    param(
        [int]$Attempts = 2
    )

    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        $rows = $null
        try {
            $rows = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
        }
        catch {
            $rows = $null
        }
        if ($null -eq $rows -or $rows.Count -eq 0) {
            try {
                $rows = @(Get-WmiObject -Class Win32_Process -ErrorAction Stop)
            }
            catch {
                $rows = $null
            }
        }
        if ($null -ne $rows -and $rows.Count -gt 0) {
            $entries = New-Object System.Collections.Generic.List[object]
            foreach ($row in $rows) {
                $commandLine = ''
                try { $commandLine = [string]$row.CommandLine } catch { $commandLine = '' }
                $executablePath = ''
                try { $executablePath = [string]$row.ExecutablePath } catch { $executablePath = '' }
                $parentId = 0
                try { $parentId = [int]$row.ParentProcessId } catch { $parentId = 0 }
                $processId = 0
                try { $processId = [int]$row.ProcessId } catch { $processId = 0 }
                if ($processId -le 0) { continue }
                $entries.Add([pscustomobject]@{
                        ProcessId       = $processId
                        ParentProcessId = $parentId
                        Name            = [string]$row.Name
                        CommandLine     = $commandLine
                        ExecutablePath  = $executablePath
                    })
            }
            if ($entries.Count -gt 0) { return $entries.ToArray() }
        }
        if ($attempt -lt $Attempts) { Start-Sleep -Milliseconds 300 }
    }
    return $null
}

function Get-ProcessSnapshotEntry {
    [CmdletBinding()]
    param(
        $Snapshot,
        [Parameter(Mandatory = $true)]
        [int]$ProcessId
    )

    if ($null -eq $Snapshot) { return $null }
    foreach ($entry in $Snapshot) {
        if ($entry.ProcessId -eq $ProcessId) { return $entry }
    }
    return $null
}

function Get-ProcessOwnership {
    <#
    .SYNOPSIS
        判断某个 PID 是否可以被认为是“本仓库的 dev 进程”，并给出证据。
    .DESCRIPTION
        安全闸门：端口兜底击杀绝不能只看进程名。另一项目的 `next start -p <同一端口>` 同样是
        node.exe，只按名字放行就会误杀。这里要求命令行（自身或任一祖先进程）指回 ProjectRoot，
        或者该进程位于 .dev-server.pid 记录的已知 PID 的子树里。

        返回：
            SnapshotAvailable  进程快照是否可用（$false 时 Owned 一律为 $false，调用方必须保守处理）
            Owned              是否可以安全结束
            Reason             不可结束的原因（给操作员看）
            Evidence           可以结束时命中的证据（写进日志，便于事后审计）
            Chain              PID 链（自身 -> 根），用于诊断
    #>
    [CmdletBinding()]
    param(
        $Snapshot,
        [Parameter(Mandatory = $true)]
        [int]$ProcessId,
        [Parameter(Mandatory = $true)]
        [string]$ProjectRoot,
        [int[]]$KnownPids = @(),
        [int]$MaxDepth = 8
    )

    $result = [pscustomobject]@{
        ProcessId         = $ProcessId
        SnapshotAvailable = ($null -ne $Snapshot)
        Owned             = $false
        Reason            = ''
        Evidence          = ''
        Chain             = @()
    }

    if ($null -eq $Snapshot) {
        $result.Reason = '无法读取进程命令行（CIM/WMI 不可用），不能确认该进程属于本仓库'
        return $result
    }

    $entry = Get-ProcessSnapshotEntry -Snapshot $Snapshot -ProcessId $ProcessId
    if ($null -eq $entry) {
        $result.Reason = "进程清单里找不到 PID $ProcessId（可能刚退出）"
        return $result
    }

    $pathKey = ConvertTo-PathKey -Path $ProjectRoot
    $chain = New-Object System.Collections.Generic.List[int]
    $current = $entry
    $depth = 0
    while ($null -ne $current -and $depth -le $MaxDepth) {
        if (-not $chain.Contains($current.ProcessId)) { $chain.Add($current.ProcessId) }
        $result.Chain = $chain.ToArray()

        if ($depth -gt 0 -and ($KnownPids -contains $current.ProcessId)) {
            $result.Owned = $true
            $result.Evidence = "PID $ProcessId 是已知 dev 进程 PID $($current.ProcessId) 的后代"
            return $result
        }
        if (Test-PathKeyInsideText -Text $current.CommandLine -PathKey $pathKey) {
            $result.Owned = $true
            if ($current.ProcessId -eq $ProcessId) {
                $result.Evidence = "PID $ProcessId 的命令行包含本仓库路径"
            }
            else {
                $result.Evidence = "PID $ProcessId 的祖先进程 PID $($current.ProcessId) 的命令行包含本仓库路径"
            }
            return $result
        }
        if (Test-PathKeyInsideText -Text $current.ExecutablePath -PathKey $pathKey) {
            $result.Owned = $true
            $result.Evidence = "PID $ProcessId 的可执行文件位于本仓库内"
            return $result
        }

        if ($current.ParentProcessId -le 4 -or $current.ParentProcessId -eq $current.ProcessId) { break }
        $current = Get-ProcessSnapshotEntry -Snapshot $Snapshot -ProcessId $current.ParentProcessId
        $depth = $depth + 1
    }

    $result.Reason = "PID $ProcessId（$($entry.Name)）的命令行与祖先进程都没有指回 $ProjectRoot"
    return $result
}

function Test-ProcessServesPort {
    <#
    .SYNOPSIS
        判断某个 PID 是否就是（或属于）监听该端口的进程树的一部分。
    .DESCRIPTION
        npm 启动的 `npm.cmd`（cmd.exe）命令行里只有 nodejs 安装目录，没有仓库路径，
        单看命令行会误判成“别人的进程”。但它是记录端口上 node 服务的祖先，这个事实同样能
        证明归属，因此从端口占用者沿父 PID 链向上找一次。
    #>
    [CmdletBinding()]
    param(
        $Snapshot,
        [Parameter(Mandatory = $true)]
        [int]$ProcessId,
        [Parameter(Mandatory = $true)]
        [int]$Port,
        [int]$MaxDepth = 8
    )

    if ($null -eq $Snapshot -or $Port -le 0 -or $ProcessId -le 0) { return $false }
    $owners = @(Get-PortOwnerPids -Port $Port)
    if ($owners.Count -eq 0) { return $false }

    foreach ($owner in $owners) {
        $current = Get-ProcessSnapshotEntry -Snapshot $Snapshot -ProcessId $owner
        $visited = New-Object System.Collections.Generic.List[int]
        $depth = 0
        while ($null -ne $current -and $depth -le $MaxDepth) {
            if ($current.ProcessId -eq $ProcessId) { return $true }
            if ($visited.Contains($current.ProcessId)) { break }
            $visited.Add($current.ProcessId)
            if ($current.ParentProcessId -le 0 -or $current.ParentProcessId -eq $current.ProcessId) { break }
            $current = Get-ProcessSnapshotEntry -Snapshot $Snapshot -ProcessId $current.ParentProcessId
            $depth = $depth + 1
        }
    }
    return $false
}

function Write-NewLogLines {
    <#
    .SYNOPSIS
        把日志文件里自上次调用以来新增的行打印到控制台（前台模式跟随日志用）。
    .DESCRIPTION
        .dev-logs/dev.log 由 npm.cmd 子进程持有句柄，必须用共享读打开；同时记录已输出长度，
        避免重复打印。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [hashtable]$Offsets,
        [string]$Prefix = '  ',
        [string]$StreamName = ''
    )

    $text = Read-TextFileShared -Path $Path
    if ([string]::IsNullOrEmpty($text)) { return }
    $offset = 0
    if ($null -ne $Offsets -and $Offsets.ContainsKey($Path)) { $offset = [int]$Offsets[$Path] }
    if ($text.Length -lt $offset) { $offset = 0 }
    if ($text.Length -eq $offset) { return }
    $chunk = $text.Substring($offset)
    foreach ($line in ($chunk -split "`r?`n")) {
        if ($null -eq $line) { continue }
        if ($line.Trim().Length -eq 0) { continue }
        if ([string]::IsNullOrEmpty($StreamName)) { Write-Host ($Prefix + $line) }
        else { Write-Host ($Prefix + $StreamName + $line) }
    }
    if ($null -ne $Offsets) { $Offsets[$Path] = $text.Length }
}

# ---------------------------------------------------------------------------
# 并发互斥：start-dev.ps1 / stop-dev.ps1 共用一把命名互斥量
# ---------------------------------------------------------------------------
#
# 为什么必须有锁：启动脚本原先只用 .dev-server.pid / .dev-server.port 判断“是否已在运行”，
# 而这两个文件要等服务就绪后才写。两次并发调用（或就绪窗口内重复点击）会各自拉起一个
# next dev，后完成的那次覆盖记录，先前那个变成无人管理的孤儿进程：仍监听端口、仍占用
# .next 目录，而 stop-dev.ps1 只按记录去杀，会打印“开发服务器已停止”并退出 0 —— 静默把
# 一台还在跑的服务“报成已停止”。这里用命名内核互斥量把“判断 + 启动 + 写记录”变成临界区，
# 并把同一把锁交给 stop-dev.ps1，避免停机与启动互相穿插。

function Get-DevLockName {
    <#
    .SYNOPSIS
        生成与项目根目录一一对应的互斥量名（同一仓库的不同工作副本互不影响）。
    .DESCRIPTION
        名字必须是确定性的：两个独立进程要算出同一个字符串才能互斥。用路径规范化后的
        SHA-256 前若干位，既不泄露路径，也不会因为大小写/分隔符差异而错开。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProjectRoot
    )

    $key = ConvertTo-PathKey -Path $ProjectRoot
    if ([string]::IsNullOrEmpty($key)) { $key = 'aragon-router' }

    $hash = ''
    try {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try {
            $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($key))
        }
        finally {
            $sha.Dispose()
        }
        $hash = ([System.BitConverter]::ToString($bytes)).Replace('-', '').Substring(0, 24).ToLowerInvariant()
    }
    catch {
        # 极端受限宿主上拿不到加密服务提供程序：退回确定性的字符散列（仍然按路径区分）。
        # 不能用 string.GetHashCode()：.NET Core 起它按进程随机化，两个进程会算出不同的名字。
        $sum = [long]5381
        foreach ($character in $key.ToCharArray()) {
            $sum = (($sum * 33) + [int]$character) % 1000000007
        }
        $hash = 'f' + $sum.ToString()
    }
    return ('AragonRouter-dev-lock-' + $hash)
}

function Enter-DevLock {
    <#
    .SYNOPSIS
        尝试获取本仓库的开发脚本互斥量（启动/停机临界区）。
    .DESCRIPTION
        优先用 Global\ 前缀（跨登录会话、跨终端窗口互斥），创建失败再退回 Local\（同一会话内
        互斥）——某些环境不允许创建全局内核对象，此时至少保证同一用户的两个窗口不会并发启动。

        返回值：
            Acquired  是否真的拿到了锁；调用方在 $false 时必须放弃，绝不能继续启动第二个实例
            Mutex     需要传给 Exit-DevLock 的内核对象
            Name      实际使用的互斥量名（写进诊断信息，便于确认两边用的是同一把锁）
            Abandoned 上一个持有者被强杀（例如 taskkill /F），锁由系统收回：记录可能已过期
            WaitedMs  等待耗时
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProjectRoot,
        [ValidateRange(0, 3600)]
        [int]$TimeoutSeconds = 300
    )

    $baseName = Get-DevLockName -ProjectRoot $ProjectRoot
    $mutex = $null
    $name = ''
    $createError = ''

    if ([string]::IsNullOrWhiteSpace($baseName)) {
        throw '无法生成开发脚本互斥量名（项目根目录为空）。'
    }

    foreach ($prefix in @('Global', 'Local')) {
        $candidate = $prefix + '\' + $baseName
        try {
            $created = New-Object -TypeName System.Threading.Mutex -ArgumentList @($false, $candidate)
            if ($null -ne $created) {
                $mutex = $created
                $name = $candidate
                break
            }
        }
        catch {
            $createError = $_.Exception.Message
            $mutex = $null
        }
    }

    if ($null -eq $mutex) {
        # 拿不到锁就绝不能“假装拿到了”：那样又回到并发启动两个实例的老问题。
        throw "无法创建启动互斥量，无法保证单实例启动：$createError"
    }

    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $acquired = $false
    $abandoned = $false
    $waitError = ''
    try {
        $acquired = $mutex.WaitOne([TimeSpan]::FromSeconds($TimeoutSeconds), $false)
    }
    catch [System.Threading.AbandonedMutexException] {
        # 上一个持有者被强杀（taskkill /F、崩溃）：内核把锁交给我们，但它的记录可能只写了一半。
        $acquired = $true
        $abandoned = $true
    }
    catch {
        $acquired = $false
        $waitError = $_.Exception.Message
    }
    $stopwatch.Stop()

    if (-not $acquired) {
        try { $mutex.Dispose() } catch { }
        return [pscustomobject]@{
            Acquired       = $false
            Mutex          = $null
            Name           = $name
            Abandoned      = $false
            WaitedMs       = [int]$stopwatch.Elapsed.TotalMilliseconds
            TimeoutSeconds = $TimeoutSeconds
            Error          = $waitError
        }
    }

    return [pscustomobject]@{
        Acquired       = $true
        Mutex          = $mutex
        Name           = $name
        Abandoned      = $abandoned
        WaitedMs       = [int]$stopwatch.Elapsed.TotalMilliseconds
        TimeoutSeconds = $TimeoutSeconds
        Error          = ''
    }
}

function Exit-DevLock {
    <#
    .SYNOPSIS
        释放并销毁 Enter-DevLock 返回的互斥量（对 $null / 未持有都安全）。
    #>
    [CmdletBinding()]
    param(
        $Lock
    )

    if ($null -eq $Lock) { return $false }
    $mutex = $null
    try { $mutex = $Lock.Mutex } catch { $mutex = $null }
    if ($null -eq $mutex) { return $false }

    $released = $false
    try {
        $mutex.ReleaseMutex()
        $released = $true
    }
    catch {
        # 未持有（或已被系统回收）时 ReleaseMutex 会抛异常：忽略，下面照样 Dispose。
        $released = $false
    }
    try { $mutex.Dispose() } catch { }
    return $released
}

# ---------------------------------------------------------------------------
# 端口区间的监听者扫描（孤儿 dev server 兜底）
# ---------------------------------------------------------------------------

function Get-ListeningSocketMap {
    <#
    .SYNOPSIS
        一次性取出本机所有 TCP 监听端口及其占用 PID，返回 端口 -> PID 列表 的映射。
    .DESCRIPTION
        扫描一个端口区间时逐端口调用 Get-NetTCPConnection 会慢上一个数量级，这里只取一次全集。
        Get-NetTCPConnection 不可用时退回解析一次 netstat -ano。
    #>
    [CmdletBinding()]
    param()

    $map = @{}
    $connections = $null
    try { $connections = @(Get-NetTCPConnection -State Listen -ErrorAction Stop) } catch { $connections = $null }

    if ($null -ne $connections -and $connections.Count -gt 0) {
        foreach ($connection in $connections) {
            $localPort = 0
            try { $localPort = [int]$connection.LocalPort } catch { continue }
            $owner = 0
            try { $owner = [int]$connection.OwningProcess } catch { continue }
            if ($localPort -le 0 -or $owner -le 0) { continue }
            if (-not $map.ContainsKey($localPort)) { $map[$localPort] = New-Object System.Collections.Generic.List[int] }
            if (-not $map[$localPort].Contains($owner)) { $map[$localPort].Add($owner) }
        }
        if ($map.Count -gt 0) { return $map }
    }

    $netstat = Join-Path $env:SystemRoot 'System32\netstat.exe'
    if (-not (Test-Path -LiteralPath $netstat)) { $netstat = 'netstat.exe' }
    $native = Invoke-NativeCommand -FilePath $netstat -Arguments @('-ano', '-p', 'TCP') -MergeStderr
    foreach ($line in $native.Output) {
        if ($line -notmatch '^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$') { continue }
        $localPort = 0
        $owner = 0
        if (-not [int]::TryParse($Matches[1], [ref]$localPort)) { continue }
        if (-not [int]::TryParse($Matches[2], [ref]$owner)) { continue }
        if ($localPort -le 0 -or $owner -le 0) { continue }
        if (-not $map.ContainsKey($localPort)) { $map[$localPort] = New-Object System.Collections.Generic.List[int] }
        if (-not $map[$localPort].Contains($owner)) { $map[$localPort].Add($owner) }
    }
    return $map
}

function Find-DevListenersInRange {
    <#
    .SYNOPSIS
        扫描端口区间，返回区间内所有监听者及其“是否属于本仓库”的判定。
    .DESCRIPTION
        用途是兜底孤儿 dev server：正常退出路径靠 .dev-server.pid / .dev-server.port，但进程树被
        打断（Ctrl+C、崩溃、并发启动的旧版本）时记录可能与实际不符。这里按端口区间反查监听者，
        再由 Get-ProcessOwnership 给出归属证据 —— 只有证据充分时调用方才允许结束进程，
        绝不因为“进程叫 node.exe”就动手（另一个项目的 next start 也是 node.exe）。

        返回对象数组，每项：
            Port              监听端口
            ProcessId         监听进程 PID
            ProcessName       进程名（取不到时为空串）
            NameAllowed       进程名是否在调用方给的允许列表里（必要不充分条件）
            SnapshotAvailable 进程命令行快照是否可读（$false 时 Owned 一律为 $false）
            Owned             是否可以认为属于本仓库
            Evidence          命中归属时的证据（写进日志/审计）
            Reason            不能确认归属的原因
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProjectRoot,
        [ValidateRange(1, 65535)]
        [int]$StartPort = 3000,
        [ValidateRange(1, 65535)]
        [int]$EndPort = 3049,
        [int[]]$KnownPids = @(),
        [int[]]$ExcludePids = @(),
        [string[]]$AllowedProcessNames = @('node', 'cmd', 'npm', 'npm.cmd')
    )

    $results = New-Object System.Collections.Generic.List[object]
    if ($StartPort -le 0) { return @() }
    if ($EndPort -lt $StartPort) { $EndPort = $StartPort }

    $map = Get-ListeningSocketMap
    $candidates = New-Object System.Collections.Generic.List[object]
    foreach ($port in @($map.Keys)) {
        $portNumber = [int]$port
        if ($portNumber -lt $StartPort -or $portNumber -gt $EndPort) { continue }
        foreach ($owner in $map[$port]) {
            if ($owner -le 4) { continue }
            if ($ExcludePids -contains $owner) { continue }
            $candidates.Add([pscustomobject]@{ Port = $portNumber; ProcessId = [int]$owner })
        }
    }
    if ($candidates.Count -eq 0) { return @() }

    # 只有在确实存在候选者时才去查进程命令行：幂等停机不该付这个代价。
    $snapshot = Get-ProcessSnapshot
    foreach ($candidate in $candidates) {
        $process = Get-Process -Id $candidate.ProcessId -ErrorAction SilentlyContinue
        $processName = ''
        if ($null -ne $process) {
            try { $processName = [string]$process.ProcessName } catch { $processName = '' }
        }
        $verdict = Get-ProcessOwnership -Snapshot $snapshot -ProcessId $candidate.ProcessId -ProjectRoot $ProjectRoot -KnownPids $KnownPids
        $results.Add([pscustomobject]@{
                Port              = $candidate.Port
                ProcessId         = $candidate.ProcessId
                ProcessName       = $processName
                NameAllowed       = ($AllowedProcessNames -contains $processName)
                SnapshotAvailable = [bool]$verdict.SnapshotAvailable
                Owned             = [bool]$verdict.Owned
                Evidence          = [string]$verdict.Evidence
                Reason            = [string]$verdict.Reason
            })
    }
    return $results.ToArray()
}

function Get-PowerShellHostPath {
    <#
    .SYNOPSIS
        返回当前 PowerShell 宿主的可执行文件路径（用于以子进程方式运行其它脚本）。
    #>
    [CmdletBinding()]
    param()

    try {
        $self = Get-Process -Id $PID -ErrorAction Stop
        if ($null -ne $self -and -not [string]::IsNullOrWhiteSpace($self.Path)) { return $self.Path }
    }
    catch {
        # 某些受限宿主不允许读取进程路径，退回 PATH 中的 powershell.exe
    }
    $command = Get-Command powershell.exe -ErrorAction SilentlyContinue
    if ($null -ne $command -and -not [string]::IsNullOrWhiteSpace($command.Path)) { return $command.Path }
    return 'powershell.exe'
}
