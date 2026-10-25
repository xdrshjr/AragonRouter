# AragonRouter

Anthropic / OpenAI 双协议 API 中转网关 + 管理控制台。带 SQLite 落库、Key 生命周期管理、
上游凭证加密存储、请求日志与用量统计。单进程（Next.js 15 App Router + Node.js 内置
`node:sqlite`），无需外部数据库、无需 Docker。

- 客户侧（兼容两种 SDK）：`POST /api/v1/messages`（Anthropic）、
  `POST /api/v1/chat/completions`（OpenAI 兼容）、`GET /api/v1/models`
- 管理侧（控制台 + REST）：登录会话、Key 增查吊销、Provider 增删改查/连通性测试、
  日志分页、用量统计
- `stream: true` 时按 SSE 逐块透传，不整体缓冲

---

## 1. 架构

```
客户端 (Anthropic / OpenAI SDK)
   │  x-api-key: ar-...  或  Authorization: Bearer ar-...
   ▼
┌──────────────────────────── Next.js (Node.js runtime) ────────────────────────────┐
│  客户侧路由  /api/v1/messages · /api/v1/chat/completions · /api/v1/models         │
│      │                                                                            │
│      ├─ 鉴权      src/lib/apikeys.ts    只比较 sha256，库里不存明文               │
│      ├─ 转发      src/lib/proxy.ts      选 provider → 剥离入站凭证 → 注入上游凭证 │
│      │                                  → 流式/非流式透传 → 写 request_logs      │
│      └─ 上游路径  src/lib/upstream.ts   /v1/messages · /v1/chat/completions · /v1/models │
│                                                                                   │
│  管理侧路由  /api/admin/**  →  HMAC 签名 Cookie 会话（src/lib/auth.ts）           │
│  数据层      src/lib/db.ts  →  node:sqlite（内联幂等 DDL）                        │
│  凭证加密    src/lib/crypto.ts → AES-256-GCM，控制台只回 maskedKey                │
│  观测        src/lib/logs.ts / stats.ts → 日志分页 + 用量聚合                     │
└───────────────────────────────────────────────────────────────────────────────────┘
   │  上游凭证（x-api-key / Authorization: Bearer，来自 provider 行，AES 加密存储）
   ▼
上游（Anthropic 官方、OpenAI 官方或任何兼容网关）
```

设计要点：

- **双协议独立转发**：每个 provider 自带 `protocol`，网关按协议选路，不做协议转换；
  Anthropic 请求带 `anthropic-version`（缺省 `2023-06-01`），OpenAI 请求用 `Bearer`。
- **凭证不出网关**：入站的 `authorization` / `x-api-key` / `cookie` 一律剥离后才发往
  上游；上游错误体回传客户端前会做凭证脱敏，避免运维 Key 泄漏给低权限的 `ar-` 持有者。
- **流式不缓冲**：`stream: true` 走 `TransformStream` 逐块透传，仅旁路解析 SSE 以统计
  input/output tokens；连接断开时也会补写日志。
- **无 Mock 模式**：没有可用 provider 时，转发返回可读的结构化错误 JSON
  （`{"type":"error","error":{"type":...,"message":...}}`），不会假装成功。

---

## 2. 目录结构

```
.
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── v1/messages/route.ts            Anthropic 协议转发
│   │   │   ├── v1/chat/completions/route.ts    OpenAI 兼容转发
│   │   │   ├── v1/models/route.ts              聚合模型列表
│   │   │   └── admin/                          会话 / keys / providers / logs / stats
│   │   ├── login/                              登录页（console-ui 提供）
│   │   ├── console/                            控制台页面（概览/Key/Provider/日志/设置）
│   │   ├── layout.tsx · globals.css            全局布局与样式
│   │   └── page.tsx                            `/` 重定向到 `/console`（见 next.config.ts）
│   ├── components/                             控制台组件
│   └── lib/                                    db / env / crypto / auth / apikeys /
│                                               providers / upstream / proxy / logs / stats
├── tests/
│   ├── unit/                                   Vitest 单元测试
│   └── integration/
│       ├── vitest.config.ts                    集成测试专用配置（串行执行、别名 @、node 环境）
│       ├── stub-upstream.mjs                   本地桩上游（离线端到端验证用）
│       ├── stub-upstream.test.ts               桩上游自身的行为测试
│       ├── stub-harness.ts                     桩上游进程的共享测试驱动（同一 stdout 端口契约）
│       ├── gateway-stub.integration.test.ts    真实路由 → 桩上游的跨模块集成测试（C2/C5–C9）
│       ├── scripts-contract.test.ts            脚本产物与契约的静态校验
│       ├── scripts-races.test.ts               并发启动 / 孤儿进程扫描的回归测试（沙箱 + 假 dev server）
│       ├── scripts-resilience.test.ts          损坏的运行期记录 + README/路由契约边界测试
│       ├── scripts-runtime.test.ts             启停脚本运行时行为、test-api.ps1 失败语义
│       └── port-listener.ps1                   测试用的端口占用辅助进程（验证端口兜底不误杀外部进程）
├── scripts/
│   ├── lib/dev-common.ps1                      启停脚本公共函数库
│   ├── start-dev.ps1                           一键启动
│   ├── stop-dev.ps1                            一键停止
│   └── test-api.ps1                            端到端验证（自带桩上游）
├── data/                                       SQLite 数据库目录（运行时生成，已 gitignore）
├── .env.example                                环境变量模板
└── package.json
```

运行期产物（均已被 `.gitignore` 覆盖）：

| 文件 | 说明 |
| --- | --- |
| `.dev-server.pid` | dev server 的 PID（后台模式与 `-Foreground` 都会写；`stop-dev.ps1` 据此结束进程树） |
| `.dev-server.port` | 实际监听端口，脚本只从这里读端口，不硬编码 3000 |
| `.dev-logs/dev.log` | dev server 标准输出 |
| `.dev-logs/dev.err.log` | dev server 标准错误（Node 实验特性警告等） |
| `.dev-logs/stub-upstream*.log` | 桩上游输出 |
| `data/aragon.db` | SQLite 数据库（含 WAL 边文件） |

并发互斥用的是 Windows 内核命名对象（`System.Threading.Mutex`），不是锁文件，因此不会产生
额外的、需要 `.gitignore` 覆盖的运行期文件；锁随持有它的 PowerShell 进程退出自动释放，
即使进程被 `taskkill /F` 强杀，下一次调用也会立即接管（并提示记录可能已过期）。

---

## 3. 环境要求

- **Node.js >= 22.5**（必需）：数据层使用内置 `node:sqlite`。版本过低时
  `scripts/start-dev.ps1` 会直接报错并给出升级指引。
- **PowerShell 5.1+**（Windows 自带）或 PowerShell 7+：运行启停脚本。
- 首次安装依赖需要网络；端到端验证完全离线（自带桩上游）。

```cmd
node --version
npm install
```

---

## 4. 环境变量

模板见 `.env.example`；**首次运行 `scripts/start-dev.ps1` 会自动生成 `.env.local`**
（真实随机值）并打印管理口令。`.env.local` 永不提交。

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `ADMIN_PASSWORD` | 是 | 控制台登录口令。脚本要求 **≥ 12 个字符**，不得含 `"` `#` `'` `=` 或首尾空白；首个脚本运行会随机生成 24 位并打印 |
| `SESSION_SECRET` | 是 | 会话 Cookie 的 HMAC-SHA256 密钥，至少 32 个字符 |
| `ENCRYPTION_KEY` | 是 | 上游凭证的 AES-256-GCM 密钥，恰好 64 位十六进制（32 字节） |
| `DATABASE_PATH` | 否 | SQLite 路径，默认 `./data/aragon.db`（相对仓库根目录，`data/` 自动创建） |
| `MAX_REQUEST_BODY_BYTES` | 否 | 入站请求体上限，默认 32 MiB，超出返回 413 |
| `MAX_BUFFERED_RESPONSE_BYTES` | 否 | 非流式上游响应缓冲上限，默认 64 MiB，超出改为透传 |
| `RELAY_TIMEOUT_MS` | 否 | 单次转发超时，默认 600000（10 分钟） |
| `COOKIE_SECURE` | 否 | 设为 `1`/`true` 时 Cookie 带 `Secure`（反代 HTTPS 场景） |

手动生成密钥：

```cmd
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> 重置口令：删除 `.env.local` 后重新运行 `scripts\start-dev.ps1`，会重新生成并打印新口令。
>
> 口令校验按**强度与结构**判断，不是只比对一份占位符名单：`.env.local` 里已有的口令如果
> 少于 12 个字符、含 `"` `#` `'` `=`、含首尾空白或控制字符、或者仍是模板占位值，脚本会
> **重新生成并在横幅里写明原因**（`原口令不可用，原因：…`）。写入后还会把文件读回来核对，
> 确保 dotenv 看到的就是脚本生成的值 —— 否则登录会以 `400 password is required` /
> `401 invalid password` 这种看不出根因的方式失败。

---

## 5. 一键启停

### 启动

```cmd
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-dev.ps1
```

脚本行为：

1. 硬校验 Node.js >= 22.5，并探活 `node:sqlite`（不满足直接报错并给升级指引）；
2. **获取本仓库的开发脚本互斥量**（`System.Threading.Mutex`，名字由仓库根目录路径的 SHA-256
   派生），把「依赖安装 → `.env.local` 初始化 → 是否已在运行 → 选端口 → 启动 → 写记录 → 就绪确认」
   整段变成临界区，见下面的「并发安全」；
3. 首次运行生成 `.env.local`，修补缺失/不安全的字段，并打印管理口令；
4. 依赖缺失（`node_modules\next` 不存在）时自动 `npm install`；
5. 未指定 `-Port` 时**从 3000 起递增挑空闲端口**（3001、3002…），不硬编码；
6. 后台启动 `npm run dev -- -p <port> -H 127.0.0.1`，写 `.dev-server.pid`、
   `.dev-server.port`，输出重定向到 `.dev-logs/dev.log`；
7. 轮询 `GET /api/admin/session` 直到拿到 HTTP 响应（默认最长 120 秒），再**复查端口归属**
   （记录端口上的监听者必须位于刚启动的进程树内，或能给出属于本仓库的证据），
   然后打印 URL / PID / 端口 / 日志路径；已在运行时直接复用，不重复启动。

参数：

| 参数 | 说明 |
| --- | --- |
| `-Port <n>` | 指定端口；被占用则报错退出（省略即自动挑选） |
| `-SkipInstall` | 依赖缺失时不自动 `npm install`，直接报错（CI / 离线） |
| `-Foreground` | 前台运行，Ctrl+C 停止。**仍然写** `.dev-server.pid` / `.dev-server.port`，dev 输出照旧落 `.dev-logs/dev.log`（并实时回显到控制台），因此另一个窗口也能用 `stop-dev.ps1` 按 PID 停掉它。就绪后**立即释放互斥量**，不阻塞另一个窗口的停止操作 |
| `-TimeoutSeconds <n>` | 就绪等待上限，默认 120 |
| `-LockTimeoutSeconds <n>` | 等待启动互斥量的上限，默认 300；超时**报错退出（退出码 1）**，绝不启动第二个实例 |

启动后打开 <http://127.0.0.1:3001/console>（端口以实际打印为准），用 `.env.local` 中的
`ADMIN_PASSWORD` 登录。

#### 并发安全（同一仓库只允许一台 dev server）

旧版本只用 `.dev-server.pid` / `.dev-server.port` 判断「是否已在运行」，而这两个文件要等服务
就绪后才写，也没有任何互斥。于是**两次并发调用**（或 120 秒就绪窗口里重复点击）会各自拉起一个
`next dev`：后完成的那次覆盖记录，先前那个变成无人管理的孤儿进程 —— 它仍在监听端口、仍占用
`.next` 目录，而 `stop-dev.ps1` 只按记录去杀，于是打印「开发服务器已停止」并退出 0，运维无法从
退出码或输出里发现还有服务在跑。

现在的行为：

- `start-dev.ps1` 与 `stop-dev.ps1` **共用一把命名互斥量**（`Global\` 前缀，创建失败退回
  `Local\`），同一仓库路径的任意数量终端窗口串行执行；
- 后到的启动调用会在锁上等待，拿到锁后读到先到者写下的记录，直接复用并打印
  「开发服务器已在运行」（以及等待耗时）；等锁超时则明确报错退出，**不会**启动第二个实例；
- 写记录前后各复查一次端口归属：只有确认记录端口上的监听者确实是刚启动的进程树，才认为启动
  成功，否则结束本次进程、删除记录并以退出码 1 结束（避免把记录写在别人的服务上）；
- 启动脚本还会扫描 3000–3049 区间，若发现**未记录**但属于本仓库的监听进程（典型是上次崩溃
  留下的孤儿），会明确打印端口 / PID 与归属证据，并提示 `stop-dev.ps1` 会一并清理。

> **环境变量以 `.env.local` 为唯一来源**：脚本启动 dev server 之前会清掉从父进程继承的
> `NODE_ENV` 以及 `ADMIN_PASSWORD` / `SESSION_SECRET` / `ENCRYPTION_KEY` / `DATABASE_PATH`，
> 并打印「已忽略从父进程继承的变量」。原因是从测试运行器或 CI 继承的 `NODE_ENV=test` 会让
> Next.js **跳过 `.env.local`**，管理口令因此变成未定义，所有登录都返回 401。
> 复用已运行的实例之前，脚本还会用当前口令做一次登录自检，口令对不上会直接提示重启。

### 停止

```cmd
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stop-dev.ps1
```

- 先获取同一把启动互斥量（最多等 120 秒），避免与正在进行的启动互相穿插；
- 读 `.dev-server.pid`，执行 `taskkill /PID <pid> /T /F` 结束整棵进程树
  （`npm.cmd` → `node` → `next dev`），并轮询确认进程消失；
- 读 `.dev-server.port` 兜底：端口仍被监听时找出占用进程，**先确认它属于本仓库**再结束，
  并等待端口释放。判定依据（任一命中即视为本仓库的进程，命中证据会打印出来）：
  1. 该进程自身的命令行包含本仓库根目录（`node <仓库>/node_modules/next/...` 就是这样）；
  2. 它的任一祖先进程命令行包含本仓库根目录，或它就是已知 dev PID 的后代；
  3. 它就是 `.dev-server.port` 上服务的进程（`npm.cmd` 的命令行只有 nodejs 安装目录，
     看不到仓库路径，但它正是端口服务的祖先）。
- **未记录监听者兜底扫描**：按端口区间（默认 3000 起 50 个，`-ScanStartPort` / `-ScanSpan` 可调）
  反查监听者，凡是**能证明属于本仓库**的 dev 进程一并结束（孤儿 dev server 就是这么被清掉的）。
  不属于本仓库的监听者只报告、绝不动手，也不计入失败（另一个项目的 `next start` 同样是 `node.exe`）；
- 拿不到归属证据时**不杀**，只报告冲突并以退出码 1 结束；`.dev-server.pid` 里的 PID 如果已被
  系统回收复用（进程名不是 node/cmd/npm，或命令行指不回本仓库），同样跳过击杀。所以本脚本
  不会误杀另一个项目同端口的 `next start`；
- 清理 `.dev-server.pid`、`.dev-server.port`；`-PurgeLogs` 时连 `.dev-logs/` 一起删除；
- **收尾复查**：`taskkill` 结束一棵进程树后，内核回收监听套接字有延迟，而紧接着的区间扫描还会
  清掉未记录的孤儿 dev 进程 —— 这两件事都可能让「杀完之后立刻」的那次端口轮询失败。所以最终的
  退出码以复查时的真实监听者为准：端口上没有监听者、或监听者**能证明不属于本仓库**（例如另一个
  项目的 `next start` 刚好占了这个端口）都算已释放；仍有属于本仓库的 dev 监听者、或归属无法判定
  才以退出码 1 结束。这样既不会误报成功，也不会因为别人的进程而永远返回非 0；
- **幂等**：没有实例在跑时打印说明并退出码 0，重复执行安全。

参数：`-Port <n>`（额外兜底端口）、`-PurgeLogs`、`-Quiet`、`-ScanStartPort <n>`、
`-ScanSpan <n>`、`-NoPortScan`（跳过区间扫描）、`-LockTimeoutSeconds <n>`。

### 端到端验证

```cmd
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\test-api.ps1
```

自带本地桩上游（`tests/integration/stub-upstream.mjs`，Node 内置 `http`，监听随机端口），
**完全离线**跑通整条链路，逐条打印 `PASS`/`FAIL`：

```
401（无 key）→ 管理员登录 → 建 API Key → 建 Provider（指向桩上游）
→ /v1/messages 非流式 200 → SSE 流式 → /v1/chat/completions 200 → /v1/models 200
→ 坏 key 401（error.type=authentication_error）→ C9 凭证注入/剥离 → 日志有记录
→ stats totals.requests > 0 → 清理测试数据 → 停机端口释放 → 重复停机幂等
```

- 结束时**必定**调用 `stop-dev.ps1` 并**验证**收尾结果：端口确已关闭、`.dev-server.pid` /
  `.dev-server.port` 确已清理，然后再跑一次验证停机幂等；验证不通过同样以退出码 1 结束，
  并打印「收尾停机验证失败」与手动处理命令；
- 失败语义覆盖三种路径，任何一种都以退出码 1 结束：
  1. 首条断言就失败（例如端口被别的程序占用，`start-dev.ps1` 拒绝启动）；
  2. 中途断言失败（例如桩上游中途退出，后续转发全部失败），脚本仍会跑完停机步骤；
  3. 运行被致命错误打断（`-AbortAfterStep <n>` 自检钩子注入，见下），由 finally 兜底停机；
- 指定 `-KeepServer` 时停机这几步**整体跳过**（而不是只跳过兜底停机），改为断言现场确实保留：
  服务仍可访问、`.dev-server.pid` / `.dev-server.port` 仍在、管理员口令仍可登录；脚本结束会打印停止命令；
- 任一断言失败退出码为 1；
- 会临时禁用历史 provider 以保证转发命中本次桩上游，结束后恢复并删除本次测试数据（`-KeepServer` 下也如此）；
- 子脚本（`start-dev.ps1` / `stop-dev.ps1`）的完整输出会落到 `.dev-logs/child-*.log`，便于事后排查；
  其中的 `ADMIN_PASSWORD` 行在写入磁盘前已被脱敏为 `***（已脱敏，见 .env.local）` —— 一次性口令
  仍然只在控制台出现一次，不会在 `.dev-logs` 里留下第二份明文副本（C11 产物目录仍可 gitignore 覆盖）。

参数：`-Port <n>`（透传）、`-SkipInstall`、`-KeepServer`、`-StartTimeoutSeconds <n>`、
`-AbortAfterStep <n>`。

> `-AbortAfterStep <n>` 是**回归自检钩子**（生产使用保持默认 0）：在第 `n` 条断言之后抛出一条
> 致命错误，用来证明「运行被中途打断」时 finally 仍会停止服务、释放端口并清理运行期产物。
> `tests/integration/scripts-runtime.test.ts` 用它驱动真实服务器做回归；桩上游也提供了
> `STUB_EXIT_AFTER_REQUESTS=<n>` 环境变量（记录到第 n 个上游请求后退出），用于复现「桩上游中途
> 挂掉」的故障演练。两者默认都不启用。

### 单元测试与集成测试

```cmd
npm test          # vitest run（tests/unit/**）
npm run typecheck # tsc --noEmit
```

集成测试（桩上游、真实 Next 路由转发、以及本工作包的 PowerShell 脚本行为）有自己的
Vitest 配置，不修改仓库根配置：

```cmd
npx vitest run --config tests/integration/vitest.config.ts
```

> 集成测试文件**串行**执行（`fileParallelism: false`）：`tests/integration/scripts-*.test.ts`
> 驱动的是同一个真实仓库根目录 —— 一台 dev server、同一把命名互斥量、共享的
> `.dev-server.pid` / `.dev-server.port`，以及 `stop-dev.ps1` 的 3000–3049 区间扫描。
> 并行跑两个这类文件时，一个文件的停机/扫描会杀掉或清掉另一个文件正在用的服务与记录。
> 串行多花几分钟，但结果是确定的。

---

## 6. API 与 curl 示例

响应包裹约定：成功 `{"data": ...}`；失败 `{"error":{"message":"..."}}`；
列表 `{"data":[...], "nextCursor": string|null}`。客户侧错误体为 Anthropic 形状
`{"type":"error","error":{"type":"...","message":"..."}}`。

### 6.1 管理侧：登录（拿到会话 Cookie）

```cmd
curl -i -c cookies.txt -X POST http://127.0.0.1:3001/api/admin/session ^
  -H "content-type: application/json" ^
  -d "{\"password\":\"<ADMIN_PASSWORD>\"}"
```

`200 {"data":{"ok":true}}` + `Set-Cookie: aragon_session=<exp>.<hmacHex>; Path=/; HttpOnly; SameSite=Lax`。
错误 `401 {"error":{"message":"invalid password"}}`；未带会话访问其它 `/api/admin/**` 时为
`401 {"error":{"message":"unauthorized"}}`。

```cmd
rem 会话探活
curl -b cookies.txt http://127.0.0.1:3001/api/admin/session
rem 退出登录（清 Cookie）
curl -b cookies.txt -X DELETE http://127.0.0.1:3001/api/admin/session
```

### 6.2 创建 API Key（明文只返回一次）

```cmd
curl -b cookies.txt -X POST http://127.0.0.1:3001/api/admin/keys ^
  -H "content-type: application/json" -d "{\"name\":\"my-app\"}"
```

```json
{"data":{"id":"...","name":"my-app","keyPrefix":"ar-1a2b3c4","createdAt":"2026-01-01T00:00:00.000Z",
         "lastUsedAt":null,"revokedAt":null,"key":"ar-0123456789abcdef0123456789abcdef"}}
```

```cmd
rem 列表（不含明文）
curl -b cookies.txt http://127.0.0.1:3001/api/admin/keys
rem 软吊销
curl -b cookies.txt -X DELETE http://127.0.0.1:3001/api/admin/keys/<id>
```

### 6.3 配置 Provider（上游凭证 AES 加密入库，只回 maskedKey）

```cmd
curl -b cookies.txt -X POST http://127.0.0.1:3001/api/admin/providers ^
  -H "content-type: application/json" ^
  -d "{\"name\":\"anthropic-official\",\"protocol\":\"anthropic\",\"baseUrl\":\"https://api.anthropic.com\",\"apiKey\":\"sk-ant-...\"}"

curl -b cookies.txt -X POST http://127.0.0.1:3001/api/admin/providers ^
  -H "content-type: application/json" ^
  -d "{\"name\":\"openai-official\",\"protocol\":\"openai\",\"baseUrl\":\"https://api.openai.com\",\"apiKey\":\"sk-...\"}"

rem 列表
curl -b cookies.txt http://127.0.0.1:3001/api/admin/providers
rem 停用（不传 apiKey 则保留原凭证）
curl -b cookies.txt -X PATCH http://127.0.0.1:3001/api/admin/providers/<id> ^
  -H "content-type: application/json" -d "{\"enabled\":false}"
rem 连通性测试（5s 超时探测 /v1/models）
curl -b cookies.txt -X POST http://127.0.0.1:3001/api/admin/providers/<id>/test
curl -b cookies.txt -X DELETE http://127.0.0.1:3001/api/admin/providers/<id>
```

### 6.4 Anthropic 协议调用

```cmd
curl -s http://127.0.0.1:3001/api/v1/messages ^
  -H "x-api-key: ar-0123456789abcdef0123456789abcdef" ^
  -H "anthropic-version: 2023-06-01" ^
  -H "content-type: application/json" ^
  -d "{\"model\":\"claude-3-5-sonnet-latest\",\"max_tokens\":64,\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}]}"
```

流式（SSE 逐块透传）：

```cmd
curl -N http://127.0.0.1:3001/api/v1/messages ^
  -H "x-api-key: ar-0123456789abcdef0123456789abcdef" ^
  -H "content-type: application/json" ^
  -d "{\"model\":\"claude-3-5-sonnet-latest\",\"max_tokens\":64,\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}]}"
```

### 6.5 OpenAI 兼容调用

```cmd
curl -s http://127.0.0.1:3001/api/v1/chat/completions ^
  -H "authorization: Bearer ar-0123456789abcdef0123456789abcdef" ^
  -H "content-type: application/json" ^
  -d "{\"model\":\"gpt-4o-mini\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"

curl -s http://127.0.0.1:3001/api/v1/models ^
  -H "x-api-key: ar-0123456789abcdef0123456789abcdef"
```

### 6.6 观测接口

```cmd
rem 日志分页
curl -b cookies.txt "http://127.0.0.1:3001/api/admin/logs?limit=50"
rem 带游标 / 状态 / 模型过滤
curl -b cookies.txt "http://127.0.0.1:3001/api/admin/logs?limit=50&cursor=<created_at>|<id>&status=200&model=gpt-4o-mini"
rem 用量统计（range=24h / 7d / 30d）
curl -b cookies.txt "http://127.0.0.1:3001/api/admin/stats?range=24h"
```

`stats.data.totals.requests` 等于该区间内 `request_logs` 的行数；`series` 为等宽时间桶，
可直接内联 SVG 绘图。

### 6.7 鉴权失败示例

```json
HTTP/1.1 401 Unauthorized
{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}
```

客户端的 Key 只会以 `ar-` + 32 位十六进制存在，库里只保存其 SHA-256。

---

## 7. 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| `Node.js 版本过低：当前 18.x，要求 >= 22.5` | 升级 Node（官网安装包 / `winget upgrade --id OpenJS.NodeJS.LTS` / `nvm use 22.5.0`），重开终端 |
| `无法加载内置模块 node:sqlite` | Node 版本过旧或该构建仍门控该模块：升级到 22.13+/23+，或 `set NODE_OPTIONS=--experimental-sqlite` 后重启 |
| `端口 <n> 已被占用` | 省略 `-Port` 让脚本自动挑空闲端口，或换一个端口；也可先 `stop-dev.ps1` 清掉旧实例 |
| 启动卡在「等待服务就绪」然后失败 | 看 `.dev-logs/dev.log` 与 `.dev-logs/dev.err.log` 末尾；常见原因是 `.env.local` 缺字段或依赖装了一半，删掉 `node_modules` 重装 |
| `依赖缺失…已指定 -SkipInstall` | 手动执行 `npm install`，然后重新启动 |
| 端口释放不掉 | `scripts\stop-dev.ps1 -PurgeLogs` 再试；仍占用时用 `netstat -ano \| findstr :<port>` 找到 PID 后 `taskkill /PID <pid> /T /F` |
| `端口 <n> 被不属于本仓库的进程占用（PID=…）` | 端口是别的项目在用（例如另一仓库的 `next start -p <同一端口>`）。脚本**故意不杀**它，只报告冲突并退出 1：确认那个项目的归属后自行处理，或删掉过期的 `.dev-server.port` 让本仓库重新选端口 |
| `PID 文件里的 PID <n> 现在是 xxx，不是本仓库的 dev 进程` | `.dev-server.pid` 过期且 PID 已被系统回收复用；脚本只清产物不杀进程。直接重新运行 `scripts\start-dev.ps1` 即可 |
| `等待启动互斥量超时（… 锁名 Global\AragonRouter-dev-lock-…）` | 同一仓库还有另一个 `start-dev.ps1` / `stop-dev.ps1` 正在处理开发服务器（锁在 300 秒内没等到）。等它结束后重试；确认没有别的脚本在跑时可加大 `-LockTimeoutSeconds`，或先运行 `scripts\stop-dev.ps1` |
| `检测到 N 个未记录（不在 .dev-server.pid / .dev-server.port 里）的监听进程可能属于本仓库` | 上一次运行留下了孤儿 dev server（旧版本的并发启动、或进程树被打断后记录被删）。运行 `scripts\stop-dev.ps1`：它会扫描端口区间、确认归属后把这些进程一并结束，并打印每个 PID 的证据 |
| 停止后仍提示「扫描到端口 <n> 的监听者 PID … 跳过」 | 那个端口属于**别的**项目（没有归属证据：命令行不含本仓库路径），脚本故意不杀。要彻底安静可改用 `-ScanSpan 1` / `-NoPortScan`，或把该项目的服务挪到别的端口 |
| `DEV server 已停止` 但 `Get-NetTCPConnection` 还显示本仓库端口在监听 | 只可能发生在旧版本脚本上。新版 `stop-dev.ps1` 会扫描 3000–3049、结束未记录的归属 dev 进程，若仍有本仓库的监听者则以退出码 1 结束并打印 PID；先看退出码与「未记录的 dev 进程」日志，再 `netstat -ano \| findstr :<port>` 定位 |
| `test-api.ps1` 中途大量 `FAIL` 但端口仍然被释放 | 这是设计行为：断言失败不中断脚本，停机步骤照常执行，收尾还会打印「收尾停机完成：端口 … 已释放」；退出码仍是 1，按失败明细逐条处理 |
| `test-api.ps1` 打印 `FATAL 运行被中断` | 运行被致命错误打断（例如开了 `-AbortAfterStep` 自检钩子，或某个非断言环节抛异常）。finally 已执行停机并验证端口释放；退出码 1 |
| `收尾停机验证失败（服务可能仍在运行…）` | finally 调用了 `stop-dev.ps1` 但端口/运行期产物没清干净。按提示手动运行 `scripts\stop-dev.ps1`（必要时 `-PurgeLogs`），再用 `netstat -ano` 定位残留进程 |
| 停机打印 `停止过程中出现问题：- 端口 <n> 仍在监听，未能释放` | 该端口上仍有**本仓库**的 dev 进程在监听，或归属无法判定（读不到命令行）。脚本已尝试 `taskkill /PID /T /F` 与区间扫描；按提示用 `netstat -ano \| findstr :<port>` 取 PID 后手动结束。脚本不会对没有归属证据的进程动手 |
| 停机打印 `复查：端口 <n> 的监听者不属于本仓库，已跳过` | 收尾复查发现端口被别人的程序占用（另一个项目的 `next start` 等）。这是报告而非失败，退出码仍为 0；要彻底安静请把该程序挪到别的端口 |
| 登录返回 `400 password is required` / `401 invalid password` | 口令与 `.env.local` 里存的不一致，或该口令不满足强度要求（< 12 字符 / 含 `#` `"` 等）。删掉 `.env.local` 后重新运行 `scripts\start-dev.ps1`，用横幅里打印的新口令登录；连续失败会触发限流，等一分钟再试 |
| 口令正确却一直 `401`，且脚本提示「这个实例不接受当前 .env.local 里的 ADMIN_PASSWORD」 | 跑着的 dev server 是用旧环境启动的：从测试运行器 / CI 继承的 `NODE_ENV=test` 会让 Next.js **跳过 `.env.local`**（`@next/env` 在 test 环境不加载该文件），管理口令因此为空或为旧值。`scripts\start-dev.ps1` 现在会清掉继承的 `NODE_ENV` 与 `ADMIN_PASSWORD`/`SESSION_SECRET`/`ENCRYPTION_KEY`/`DATABASE_PATH` 并打印「已忽略从父进程继承的变量」，按提示 `stop-dev.ps1` 后重启即可 |
| 登录后接口仍 `401 unauthorized` | Cookie 未带上：确认用 `-b cookies.txt` 或浏览器已登录；`COOKIE_SECURE=1` 时纯 HTTP 访问不会生效 |
| `SESSION_SECRET is not set` / `must be at least 32 characters` | 在 `.env.local` 中补齐 32+ 字符密钥，重启服务 |
| `ENCRYPTION_KEY must be exactly 64 hex characters` | 换成 64 位十六进制；注意全零样例等于没有加密 |
| 转发 `503 no enabled <protocol> provider is configured` | 去 `/console/providers` 新建并启用对应协议的 provider |
| 转发 `500 provider "x" cannot be used: …` | 更换过 `ENCRYPTION_KEY`，旧密文无法解密：在控制台重新保存该 provider 的上游 Key |
| 转发 `502 upstream request failed: …` | 上游不可达 / BaseURL 写错 / 需要代理；先用 provider 的「测试连通性」定位 |
| 转发 `504 upstream request timed out` | 上游过慢或被网络拦截；可调大 `RELAY_TIMEOUT_MS` |
| 请求 `413 request body is too large` | 请求体超过 `MAX_REQUEST_BODY_BYTES`（默认 32 MiB），按需调大 |
| 日志/统计看不到数据 | 只统计真实转发请求；`stats` 按区间过滤，刚建立的 Key 用 `?range=24h` 查看 |
| 想清空全部数据 | 停服后删除 `data/` 目录，再启动（DDL 自动重建） |
| PowerShell 报「无法加载文件…未数字签名」 | 用 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\xxx.ps1` 运行 |

---

## 8. 安全说明

- 上游凭证以 AES-256-GCM 加密存 SQLite，接口只返回 `maskedKey`（如 `sk-a…a1b2`）；
- 入站凭证（`authorization`、`x-api-key`、`cookie`）在下发上游前被剥离，上游错误体
  回传前按已知密钥脱敏，避免运维凭证泄漏给低权限客户端；
- 会话为无状态 HMAC 签名 Cookie（`HttpOnly`、`SameSite=Lax`，7 天有效），口令比较使用
  常量时间比较，并对失败登录做限流；
- 请求体与缓冲响应都有硬上限，防止单个低权限 Key 或恶意上游耗尽内存；
- `.env.local`、`data/`、`.dev-logs/` 与运行期 PID/端口文件均在 `.gitignore` 中。
