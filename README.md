<p align="center">
  <img src="public/brand-mark.png" width="96" height="96" alt="AragonRouter 应用图标" />
</p>

<h1 align="center">AragonRouter</h1>

<p align="center">
  <strong>把 Anthropic 与 OpenAI 两种协议的请求，收敛到同一个自托管网关</strong><br />
  单进程（Next.js 15 + Node.js 内置 SQLite）就把会话、Key 生命周期、上游凭证加密与用量观测
  一起带上 —— 不用外部数据库、不用 Docker、不用上线第三方中转。
</p>

<p align="center">
  <sub><b>适合</b>：想给一堆客户端一个统一出口、上游 Key 自己攥着、又要看用量的人 ·
  <b>不适合</b>：需要多租户、多实例共享同一份数据、或跨协议互转（见
  <a href="#11-已知限制">已知限制</a>）</sub>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Next.js-15-3ecf8e?style=flat-square" alt="Next.js 15" />
  <img src="https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square" alt="TypeScript strict" />
  <img src="https://img.shields.io/badge/Node.js-22.5%2B-339933?style=flat-square" alt="Node.js 22.5 以上" />
  <img src="https://img.shields.io/badge/SQLite-node%3Asqlite-2f6f9f?style=flat-square" alt="node:sqlite" />
  <img src="https://img.shields.io/badge/Tailwind-3.4-38bdf8?style=flat-square" alt="Tailwind 3.4" />
  <img src="https://img.shields.io/badge/%E9%83%A8%E7%BD%B2-%E5%8D%95%E8%BF%9B%E7%A8%8B%E5%8D%95%E6%96%87%E4%BB%B6-3ecf8e?style=flat-square" alt="部署：单进程单文件" />
</p>

<p align="center">
  <sub>离线纯文本徽标（徽标图裂时以此为准）：<code>Next.js 15</code> · <code>TypeScript strict</code> ·
  <code>Node.js &gt;= 22.5</code> · <code>node:sqlite</code> · <code>Tailwind 3.4</code> ·
  <code>部署：单进程单文件</code></sub>
</p>

<p align="center">
  <a href="#截图"><b>先看截图</b></a> ·
  <a href="#快速开始">三条命令跑起来</a> ·
  <a href="#功能特性">功能特性</a> ·
  <a href="#6-api-与-curl-示例">API 示例</a> ·
  <a href="#7-用户系统">用户系统</a> ·
  <a href="#8-故障排查">故障排查</a>
</p>

**能力速览**（逐条说明见「功能特性」表）：

- 客户侧（兼容两种 SDK）：`POST /api/v1/messages`（Anthropic）、
  `POST /api/v1/chat/completions`（OpenAI 兼容）、`GET /api/v1/models`
- 管理侧（控制台 + REST）：登录会话、Key 增查吊销、Provider 增删改查/连通性测试、
  日志分页、用量统计
- 用户系统：游客可浏览控制台外壳，注册/登录强制图形验证码，管理员在
  `/console/users` 管理账号（角色、状态、重置口令、删除）并开关注册
- `stream: true` 时按 SSE 逐块透传，不整体缓冲

> 第一次接触本项目？直接跳到「快速开始」三条命令；只想知道能做什么，看「功能特性」表格。

---

## 截图

两张图都取自本仓库自己跑起来的控制台：数据由 `scripts\test-api.ps1` 的本地桩上游产生
（`127.0.0.1` 上的随机端口、暗色主题）。点击图片可查看原始分辨率（3055×1622 / 3061×1625）。

<p align="center">
  <a href="public/screenshot-01.png"><img src="public/screenshot-01.png" width="100%"
    alt="AragonRouter 控制台概览页：请求数 / 错误率 / 平均延迟 / Token 用量卡片、用量折线与最近转发记录" /></a>
</p>

<p align="center">
  <sub><b>概览</b> <code>/console</code> —— 请求数、错误率、平均延迟、Token 用量四张卡片，
  按 <code>24h</code> / <code>7d</code> / <code>30d</code> 切换的用量折线，下方是最近 6 条转发记录
  （时间 / 模型 / 延迟 / Token / Key 前缀）与 <b>View all logs</b> 入口</sub>
</p>

<p align="center">
  <a href="public/screenshot-02.png"><img src="public/screenshot-02.png" width="100%"
    alt="AragonRouter 控制台 Provider 页：上游列表、协议、BaseURL、脱敏 Key、启用开关、健康状态与 Test / Edit / Delete" /></a>
</p>

<p align="center">
  <sub><b>Provider</b> <code>/console/providers</code> —— 每个上游的协议、BaseURL、脱敏后的 Key
  （<code>192d….aqjT</code> 这种形态，明文在入库前已加密）、启用开关、健康状态，以及逐行的
  <b>Test</b> / <b>Edit</b> / <b>Delete</b>；顶部一行说明「同一协议有多个上游时，最早启用的那个承接流量」</sub>
</p>

> 截图维护：控制台 UI 有改动时，用同一套桩上游数据重截概览页与 Provider 页，覆盖
> `public/screenshot-01.png` / `public/screenshot-02.png`，保持暗色主题与相近分辨率即可。

---

## 目录

| 章节 | 内容 |
| --- | --- |
| [截图](#截图) | 控制台概览页与 Provider 页 |
| [快速开始](#快速开始) | 三条命令：启动 → 打开控制台 → 关闭 |
| [功能特性](#功能特性) | 能力清单与实现状态 |
| [1. 架构](#1-架构) | 一次转发在网关里经过哪几层 |
| [2. 目录结构](#2-目录结构) | 每个目录放什么、运行期产物落在哪 |
| [3. 环境要求](#3-环境要求) | Node.js >= 22.5、PowerShell |
| [4. 环境变量](#4-环境变量) | 必填与可选变量、口令强度要求 |
| [5. 一键启停](#5-一键启停) | 启动 / 停止 / 端到端验证 / 单元与集成测试 |
| [6. API 与 curl 示例](#6-api-与-curl-示例) | 管理侧与客户侧可直接粘贴的调用 |
| [7. 用户系统](#7-用户系统) | 角色模型、`/api/auth/**` 与 `/api/admin/users/**`、验证码与注册开关 |
| [8. 故障排查](#8-故障排查) | 报错原文 → 原因与处理 |
| [9. 安全说明](#9-安全说明) | 凭证、会话与请求上限 |
| [10. 品牌资源与图标流水线](#10-品牌资源与图标流水线) | 图标母版怎么打分、三档产物怎么生成 |
| [11. 已知限制](#11-已知限制) | 明确不做、自动化覆盖不到的部分 |

---

## 快速开始

前提：Node.js >= 22.5、Windows 自带的 PowerShell 5.1+（见「环境要求」）。下面三条命令在
`cmd.exe` 里直接粘贴即可，脚本参数全部是 `scripts\*.ps1` 实际支持的那几个。

第一条 —— 一键启动（装依赖 → 生成 `.env.local` → 挑空闲端口 → 后台启动 → 等就绪 → 打印
URL / PID / 端口 / 日志路径 / 管理员口令）：

```cmd
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-dev.ps1
```

第二条 —— 打开控制台。端口从 `.dev-server.port` 读取，脚本从 3000 起递增挑空闲端口，
**一切以脚本实际打印的端口为准**，不要写死 3000：

```cmd
powershell -NoProfile -Command "start ('http://127.0.0.1:' + (Get-Content .dev-server.port -Raw).Trim() + '/console')"
```

（也可以直接把启动横幅里打印的 URL 粘进浏览器；用 `.env.local` 里的 `ADMIN_PASSWORD` 登录。）

第三条 —— 一键关闭（按 PID 结束整棵进程树 → 端口兜底 + 区间扫描 → 清理运行期记录）：

```cmd
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stop-dev.ps1
```

**首次运行会自动生成 `.env.local` 并打印管理员口令**，具体是：

1. `.env.local` 由脚本用真实随机值生成（`ADMIN_PASSWORD` / `SESSION_SECRET` /
   `ENCRYPTION_KEY` / `DATABASE_PATH`）；已存在的文件只在字段缺失、仍是模板占位值、
   或不满足强度要求时才修补，并写明修补原因；
2. 脚本生成（或重新生成）口令时，控制台横幅会打印本次生效的管理员口令
   （18 字节 base64url = 24 位随机串）——它**只在这一处出现**；沿用 `.env.local` 里
   已有口令时横幅只提示「沿用 .env.local 中已有值」，不再重复打印。`.env.local` 是唯一
   持久副本（`data/`、`.dev-logs/` 都在 `.gitignore` 里，写进 `.dev-logs/child-*.log`
   的口令行已脱敏）。请立即存到密码管理器；
3. `node_modules\next` 不存在时自动执行 `npm install`；Node 版本或 `node:sqlite`
   探活不通过会直接报错并给升级指引，不会带着坏环境启动。

> 口令忘了或对不上：删掉 `.env.local`，重新运行 `scripts\start-dev.ps1`，会重新生成并打印新口令。
> 只想验证链路是否通：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts\test-api.ps1`
> （自带离线桩上游，见「一键启停 → 端到端验证」）。

---

## 功能特性

| 能力 | 状态 | 说明与入口 |
| --- | --- | --- |
| 双协议转发 | 已实现 | Anthropic `POST /api/v1/messages` 与 OpenAI 兼容 `POST /api/v1/chat/completions` 各自独立转发，`GET /api/v1/models` 聚合可用模型；按 provider 行上的 `protocol` 选路，**不做协议互转** |
| SSE 流式 | 已实现 | 请求带 `stream: true` 时用 `TransformStream` 逐块透传，不整体缓冲；旁路解析 SSE 只为统计 input/output tokens，连接断开也会补写日志 |
| Key 生命周期 | 已实现 | 创建时明文只返回一次（`ar-` + 32 位十六进制），列表不含明文，软吊销保留行（`revokedAt`），并记录 `lastUsedAt`、`keyPrefix`；库里只存 SHA-256（`src/lib/apikeys.ts`） |
| 凭证 AES-256-GCM 加密 | 已实现 | 上游 Key 加密存 SQLite，接口只回 `maskedKey`（如 `sk-a…a1b2`）；换过 `ENCRYPTION_KEY` 后旧密文无法解密，需在控制台重存（`src/lib/crypto.ts`） |
| 请求日志 | 已实现 | 每次转发落 `request_logs`（状态码、耗时、tokens、模型），`GET /api/admin/logs` 支持 `limit` / 游标 / `status` / `model` 过滤，控制台「日志」页同一份数据 |
| 用量统计 | 已实现 | `GET /api/admin/stats?range=24h\|7d\|30d` 聚合请求数与 tokens，`series` 为等宽时间桶可直接画图；控制台「概览」页内联 SVG 折线 |
| 一键启停脚本 | 已实现 | `scripts\start-dev.ps1`（自动挑端口、依赖缺失自动装、命名互斥量防并发、就绪后复查端口归属）与 `scripts\stop-dev.ps1`（按 PID 结束进程树、只杀**能证明属于本仓库**的进程），幂等可重复执行 |
| 离线端到端测试 | 已实现 | `scripts\test-api.ps1` 自带本地桩上游（`tests/integration/stub-upstream.mjs`），无网络也能跑通「401 → 登录 → 建 Key → 建 Provider → 非流式 → SSE → OpenAI → models → 坏 key → 凭证注入/剥离 → 日志 → 统计 → 停机」并逐条打印 `PASS`/`FAIL` |
| 管理控制台 | 已实现 | 暗色优先 UI（`/console`）：概览、Key、Provider（含「Test」连通性按钮）、日志、用户（仅管理员）、设置；账号会话为数据库行 + HttpOnly Cookie，登录失败限流。长相见[截图](#截图) |
| 用户系统 | 已实现 | 游客可浏览控制台外壳；登录/注册走同一个弹窗并强制图形验证码；注册出来的 `member` 可登录但调不动 `/api/admin/**`；管理员在 `/console/users` 搜索/过滤/分页、创建账号、改角色与状态、重置口令、删除账号，最后一个管理员与自我锁定由服务端拒绝并在界面内联显示。详见[用户系统](#7-用户系统) |

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
│   │   │   ├── auth/                           session / captcha / login / register / logout / password
│   │   │   └── admin/                          会话 / keys / providers / logs / stats / users / settings
│   │   ├── login/                              登录页（弹窗表单的直链兜底，服务端校验 next）
│   │   ├── console/                            控制台页面（概览/Key/Provider/日志/用户/设置）
│   │   ├── icon.png · apple-icon.png           图标路由（App Router 文件约定，构建产物见 brand-mark）
│   │   ├── layout.tsx · globals.css            全局布局与样式
│   │   └── page.tsx                            `/` 重定向到 `/console`（见 next.config.ts）
│   ├── components/                             控制台组件
│   │   ├── auth/                               登录弹窗、注册表单、AuthProvider、图形验证码
│   │   ├── console/                            面板、api.ts（唯一 HTTP 客户端）、导航与格式化
│   │   │   └── users/                          用户管理的表格、列表状态机与三个对话框
│   │   ├── ui/                                 自建设计系统（按钮/表格/弹窗/Toast…）
│   │   └── brand/BrandMark.tsx                 品牌标识（消费 public/brand-mark.png）
│   └── lib/                                    db / env / crypto / auth / sessions / users / settings /
│                                               captcha / password / apikeys / providers / upstream /
│                                               proxy / logs / stats
├── public/
│   ├── brand-mark.png                          512×512 品牌母版（页面内使用）
│   ├── screenshot-01.png                       README 截图：概览页（/console）
│   └── screenshot-02.png                       README 截图：Provider 页（/console/providers）
├── design/                                     图标美术资产与可复现流水线
│   ├── ai/                                     AI 生成的候选母版（qwen-image-3.0-pro，1328×1328）
│   ├── ai-logo.py                              生成候选（提示词按 motif 拆分，负面词统一）
│   ├── score-logos.py                          客观打分：覆盖率/完整度/对称/居中/留白/色板
│   ├── contact-sheet.py                        拼对比图（原始 / 双色 / 16px / 32px）
│   ├── build-brand-assets.py                   投影到 C10 双色 → 派生出三档图标
│   └── inspect-logo.py                         像素自检（出血 / 主色板 / 包围盒 / 居中）
├── tests/
│   ├── unit/                                   Vitest 单元测试（根 vitest.config.ts 唯一 include）
│   ├── ui/                                     控制台 UI 测试（独立配置，需 --config 显式运行）
│   │   ├── vitest.config.ts                    含 .tsx、esbuild jsx=automatic、node 环境
│   │   ├── support/admin-harness.ts             把 fetch 接到真实路由处理器并维护 cookie jar
│   │   ├── users-panel.test.tsx                 /console/users：入口 / 守卫 / 表格 / 过滤 / 创建校验
│   │   └── *.test.ts · *.test.tsx              查询构建 / 格式化 / SVG 几何 / 渲染与 a11y
│   ├── users-admin-ui/                          用户管理测试（与 tests/ui 同一份配置，同样需 --config）
│   │   ├── users-list-state.test.tsx            keyset 列表状态机（替换 vs 追加失败）
│   │   ├── settings-switch.test.tsx             注册开关的读写与只读态
│   │   ├── users-shell-access.test.tsx          真实 AuthGuard：游客/成员/管理员三态
│   │   ├── users-boundary.test.ts               面板 ↔ 真实 /api/admin/users 处理器
│   │   ├── users-pagination-races.test.ts       并发写入下的游标分页与幂等重试
│   │   └── readme-contract.test.ts              README 用户系统章节的契约断言
│   └── integration/
│       ├── vitest.config.ts                    集成测试专用配置（串行执行、别名 @、node 环境）
│       ├── stub-upstream.mjs                   本地桩上游（离线端到端验证用）
│       ├── stub-upstream.test.ts               桩上游自身的行为测试
│       ├── stub-harness.ts                     桩上游进程的共享测试驱动（同一 stdout 端口契约）
│       ├── gateway-stub.integration.test.ts    真实路由 → 桩上游的跨模块集成测试（C2/C5–C9）
│       ├── scripts-contract.test.ts            脚本产物与契约的静态校验
│       ├── scripts-races.test.ts               并发启动 / 孤儿进程扫描的回归测试（沙箱 + 假 dev server）
│       ├── scripts-readiness.test.ts           就绪预算 / 运行期记录完整性回归（桩 dev server 跑真实 start-dev.ps1）
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

控制台 UI 测试（`tests/ui/**` 与 `tests/users-admin-ui/**`，含 `.tsx`）同样不在根配置的
include 里，要显式指定它自己的配置：

```cmd
npx vitest run --config tests/ui/vitest.config.ts
```

> 记住这条边界：`npm test` 只跑 `tests/unit/**`（根 `vitest.config.ts` 的 include 仅此一条），
> `tests/ui/**`、`tests/users-admin-ui/**` 与 `tests/integration/**` 都必须带 `--config` 才会运行，
> 详见「已知限制」。

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

## 7. 用户系统

控制台不再是「一个口令换一个 Cookie」的单人后台：账号存在 `users` 表里，登录与注册走同一个
弹窗并强制图形验证码；游客照样能进控制台外壳看结构，只有面板数据需要账号。

### 7.1 角色模型

| 角色 | 怎么来的 | 能做什么 | 不能做什么 |
| --- | --- | --- | --- |
| 游客（无会话） | 默认状态，没有登录 | 打开 `/console/**` 的外壳（侧边栏、顶栏、页脚），看到「登录后查看」遮罩；点任意受保护操作会弹出登录弹窗 | 读不到任何面板数据；所有 `/api/admin/**` 一律 `401` |
| `member` | 自助注册（`POST /api/auth/register`）或被管理员创建 | 登录、看控制台外壳、改自己的口令（`POST /api/auth/password`） | 调不动 `/api/admin/**`（`403`）；侧边栏看不到 Users 入口，直接访问 `/console/users` 显示「需要管理员权限」提示 |
| `admin` | 首次启动用 `ADMIN_PASSWORD` 建出的 `admin` 账号，或被另一个管理员提权 | 全部管理动作、用户管理、注册开关 | 不能停用/降级/删除自己；不能让实例失去最后一个可用管理员（服务端一律 `400`） |

字段规则（服务端是唯一权威，前端只是提前拦一遍）：

- `username`：3–32 字符，字母/数字/`.`/`-`/`_`，必须以字母或数字开头，**创建后不可修改**，
  大小写不敏感地唯一。
- `displayName`：可空，清理控制字符后最长 64。
- 口令：8–200 字符，必须含至少一个字母与一个数字，且不得包含用户名片段。
- 只有 `status=active` 的账号能登录；把账号停用会立刻吊销它的所有会话。

### 7.2 端点表

**`/api/auth/**`（游客可调，`src/app/api/auth/`）**

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/auth/captcha` | 发一张新验证码：`{data:{challengeId, imageDataUrl, expiresAt}}`，`imageDataUrl` 是 `data:image/svg+xml` 前缀的图片 |
| `GET` | `/api/auth/session` | 读身份：`{data:{user, registration:{enabled}}}`；**游客也是 200**（`user:null`），不是 401 |
| `POST` | `/api/auth/login` | `{username,password,challengeId,captchaAnswer}` → `200 {data:{user}}` + `Set-Cookie: aragon_session`；错误 `400`/`401`/`429` |
| `POST` | `/api/auth/register` | `{username,password,displayName?,challengeId,captchaAnswer}` → `201 {data:{user}}`；注册被关闭时 `403` |
| `POST` | `/api/auth/logout` | `200 {data:{ok:true}}` 并清 Cookie |
| `POST` | `/api/auth/password` | `{currentPassword,newPassword}` → `200 {data:{ok:true}}` |

**`/api/admin/users/**` 与注册开关（仅 `admin`）**

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/admin/users` | `?limit&cursor&search&role&status` → `{data:UserPublic[], nextCursor}`；keyset 游标是 `<created_at>|<id>`，`limit` 上限 100，`search` 同时匹配用户名与显示名 |
| `POST` | `/api/admin/users` | `{username,password,role?,displayName?}` → `201 {data:UserPublic}` |
| `GET` | `/api/admin/users/[id]` | 账号详情 + 在线会话：`{data:UserDetailPublic}` |
| `PATCH` | `/api/admin/users/[id]` | `{displayName?,role?,status?}` → `{data:UserPublic}`；`displayName:null` 表示清空 |
| `DELETE` | `/api/admin/users/[id]` | `{data:{ok:true}}`，该账号会话一并删除 |
| `POST` | `/api/admin/users/[id]/password` | `{password}` → `{data:{ok:true}}`，同时吊销该账号其它设备会话 |
| `DELETE` | `/api/admin/users/[id]/sessions/[sessionId]` | 吊销某个设备会话 |
| `GET` | `/api/admin/settings` | `{data:{registration:{enabled}}}` |
| `PATCH` | `/api/admin/settings` | `{registration:{enabled}}` → 同形状；写入后 `/api/auth/register` 立刻按新状态执行 |

失败统一 `{error:{message}}`：游客 `401 unauthorized`、`member` `403 forbidden`、规则冲突 `400`
（例如 `at least one active admin must remain`）、未知 id `404 user not found`。
控制台把这些服务端文案翻成可读句子再内联显示，绝不静默吞掉。

### 7.3 验证码策略

- **登录与注册都强制**图形验证码：请求里没有 `challengeId` / `captchaAnswer` 一律 `400`。
- 验证码是自绘 SVG（`src/lib/captcha.ts`，5 个字形，不引第三方库、不依赖字体）；服务端只存
  `sha256(id:answer)` 与过期时间/尝试次数，**有效期 5 分钟**、**最多尝试 5 次**、**成功即消费**
  ——重试必须重新取一张。
- 前端把 `imageDataUrl` 直接绑到 `<img src>`，点图即换一张；提交失败会自动刷新验证码，
  并把「验证码不对」和「用户名口令不对」分开提示。
- 验证码通过之前不做任何口令比对，因此爆破者拿不到「口令对不对」的信号；登录失败仍按客户端
  指纹限流（30 次窗口）。

### 7.4 `/api/admin/session`：给自动化留的例外

`POST /api/admin/session`（`{password}` → Cookie）是上一轮就存在的管理入口，**不带验证码**。
这是刻意保留的例外：`scripts/test-api.ps1`、CI 与 curl 脚本需要一个可编排的登录路径，而自动化
没法「看图填字」。它仍然要过 `ADMIN_PASSWORD` 校验、失败限流，并且只签发 `admin` 会话（用
`member` 口令打这个门会拿到 `403`）。

浏览器里的产品路径是 `/api/auth/login` + 登录弹窗；`/api/admin/session` 不参与浏览器流程，
只作为自动化入口存在。两者签发的是同一种 Cookie（`aragon_session`），因此拿到 Cookie 之后的
所有 `/api/admin/**` 调用完全一样。

### 7.5 注册开关

- 默认**开启**：`settings` 表缺行即视为开启，装好就能注册。
- 管理员在 `/console/settings` 拨动「Allow self-registration」，前端走
  `PATCH /api/admin/settings`，随后**重新 `GET` 一次确认**并弹 Toast，再刷新会话上下文，让
  登录弹窗的「Create account」页签立刻同步。
- 关闭后：`/api/auth/register` 返回 `403`，弹窗隐藏注册页签；管理员仍可在 `/console/users`
  创建账号。
- **非管理员没有「只读的设置页」可看**：`AuthGuard` 的 `ConsoleBody` 对所有非管理员把主区换成
  「需要管理员权限」遮罩（`Administrator access required`），因此 `member` 直接打开
  `/console/settings` 看到的是这块遮罩，而不是一个拨不动的开关；侧边栏里也没有管理员专属入口。
  `SettingsPanel` 内部仍保留一段只读降级（`read-only: open/closed` 徽标、不发任何管理员请求的
  空摘要），用于面板**不经过控制台外壳**被单独挂载的场景：那时它既不该替一个 `member` 去发
  `/api/admin/**`，也不该渲染一个按下去只会 403 的开关。这是纵深防御，不是线上 `member`
  看到的界面 —— `tests/users-admin-ui/users-shell-access.test.tsx` 钉住外壳行为，
  `tests/users-admin-ui/readme-contract.test.ts` 钉住这段文案本身。

### 7.6 控制台里的用户管理

`/console/users`（侧边栏 Users，**仅管理员可见**）：

- 表格列：用户名、显示名、角色、状态、最后登录、创建时间与行内操作；自己的那一行带 `you` 标记。
- 搜索框**防抖 300ms**，角色/状态两个下拉直接作为查询参数；「Load more」用上一页返回的
  `nextCursor` 追加并按 id 去重，并发写入不会把同一行渲染两次。
- 「Create account」按服务端规则前置校验（用户名格式、弱口令、口令含用户名），重名之类的服务端
  规则错误在对话框内联展示；成功后刷新列表并 Toast。
- 行内「Edit」改显示名/角色/状态，「Reset」设置新口令（吊销该账号其它设备），「Delete」走
  `ConfirmDialog` 二次确认。所有 `400` 规则文案内联展示，例如
  `At least one active admin must remain. Promote another account to admin first.`
- 「Load more」失败时**不会**把已经翻到的行换成整页错误：已加载的行与 `nextCursor` 都保留，
  列表底部出现内联错误与「Retry this page」，重试只重发刚才失败的那一页；只有首页就失败
  （屏幕上还没有任何行）时才用整块 `ErrorState`。
- 换过滤器/改搜索词/手动刷新（即「替换式」加载）失败时，屏幕上的行保留，但**游标作废**：
  那枚 `nextCursor` 是为*上一套*过滤器签发的，拿它继续追加会把两套过滤器的结果混在一屏。
  此时「Load more」禁用，底部提示变成 `Pagination resumes when the list loads again.`，
  等「Try again」成功拿到新游标才恢复分页。
- 实现拆在 `src/components/console/users/`（表格、列表状态机 `users-list-state.ts`、创建/编辑/
  重置口令三个对话框、共享字段），`UsersPanel.tsx` 只保留编排、过滤器与 Toast；面板接线/表格/
  创建校验的验收测试就是验收项点名的 `tests/ui/users-panel.test.tsx`，其余职责各有一份
  （`tests/users-admin-ui/`：列表状态机 / 注册开关 / 真实路由边界 / 分页竞态 / 外壳访问 /
  只读态 / README 契约），两处共用同一份 vitest 配置。
- 游客点任何受保护操作会弹登录弹窗；`member` 直接打开 `/console/users`（或任何面板）看到
  「Administrator access required」提示，不会白屏也不会崩溃，也不会发出任何管理员请求。

### 7.7 curl 示例

```cmd
rem 1) 取一张验证码：返回 challengeId 与 data:image/svg+xml 图片
curl -s http://127.0.0.1:3001/api/auth/captcha

rem 2) 注册一个 member（challengeId 用上一步的返回值，captchaAnswer 填图里的字符）
curl -i -c cookies.txt -X POST http://127.0.0.1:3001/api/auth/register ^
  -H "content-type: application/json" ^
  -d "{\"username\":\"alice\",\"password\":\"Quiet-H4rbour-1\",\"displayName\":\"Alice\",\"challengeId\":\"<challengeId>\",\"captchaAnswer\":\"ABCDE\"}"

rem 3) 登录（同样要验证码；成功后 Cookie 落在 cookies.txt）
curl -i -c cookies.txt -X POST http://127.0.0.1:3001/api/auth/login ^
  -H "content-type: application/json" ^
  -d "{\"username\":\"alice\",\"password\":\"Quiet-H4rbour-1\",\"challengeId\":\"<challengeId>\",\"captchaAnswer\":\"ABCDE\"}"

rem 4) 读身份（游客也是 200，user 为 null）
curl -b cookies.txt http://127.0.0.1:3001/api/auth/session

rem 5) 改自己的口令，然后登出
curl -b cookies.txt -X POST http://127.0.0.1:3001/api/auth/password ^
  -H "content-type: application/json" ^
  -d "{\"currentPassword\":\"Quiet-H4rbour-1\",\"newPassword\":\"Quiet-H4rbour-2\"}"
curl -b cookies.txt -X POST http://127.0.0.1:3001/api/auth/logout

rem 6) 管理员列表：分页、按角色/状态过滤、按关键字搜索
curl -b admin-cookies.txt "http://127.0.0.1:3001/api/admin/users?limit=20&role=member"
curl -b admin-cookies.txt "http://127.0.0.1:3001/api/admin/users?status=active&search=ali"

rem 7) 创建账号、改角色、重置口令、删除账号
curl -b admin-cookies.txt -X POST http://127.0.0.1:3001/api/admin/users ^
  -H "content-type: application/json" ^
  -d "{\"username\":\"bob\",\"password\":\"Quiet-H4rbour-3\",\"role\":\"member\"}"
curl -b admin-cookies.txt -X PATCH http://127.0.0.1:3001/api/admin/users/<id> ^
  -H "content-type: application/json" -d "{\"role\":\"admin\"}"
curl -b admin-cookies.txt -X POST http://127.0.0.1:3001/api/admin/users/<id>/password ^
  -H "content-type: application/json" -d "{\"password\":\"Quiet-H4rbour-4\"}"
curl -b admin-cookies.txt -X DELETE http://127.0.0.1:3001/api/admin/users/<id>

rem 8) 注册开关：读 → 关 → 再读
curl -b admin-cookies.txt http://127.0.0.1:3001/api/admin/settings
curl -b admin-cookies.txt -X PATCH http://127.0.0.1:3001/api/admin/settings ^
  -H "content-type: application/json" -d "{\"registration\":{\"enabled\":false}}"
```

> `admin-cookies.txt` 用「6.1 管理侧：登录」那条命令生成（`POST /api/admin/session`，自动化入口，
> 不需要验证码）。用 `/api/auth/login` 登录的浏览器场景，Cookie 名称与后续调用完全一致。

---

## 8. 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| `Node.js 版本过低：当前 18.x，要求 >= 22.5` | 升级 Node（官网安装包 / `winget upgrade --id OpenJS.NodeJS.LTS` / `nvm use 22.5.0`），重开终端 |
| `无法加载内置模块 node:sqlite` | Node 版本过旧或该构建仍门控该模块：升级到 22.13+/23+，或 `set NODE_OPTIONS=--experimental-sqlite` 后重启 |
| `端口 <n> 已被占用` | 省略 `-Port` 让脚本自动挑空闲端口，或换一个端口；也可先 `stop-dev.ps1` 清掉旧实例 |
| 启动卡在「等待服务就绪」然后失败 | 看 `.dev-logs/dev.log` 与 `.dev-logs/dev.err.log` 末尾；常见原因是 `.env.local` 缺字段或依赖装了一半，删掉 `node_modules` 重装 |
| `等待超过 120 秒仍未就绪` | 就绪等待上限是 `-TimeoutSeconds <n>`（默认 **120 秒**，例如 `scripts\start-dev.ps1 -TimeoutSeconds 300`）；`test-api.ps1` 用 `-StartTimeoutSeconds <n>` 透传同一个上限。超时后脚本会自动打印 `.dev-logs/dev.log` / `dev.err.log` 的最后 30 行，先据此判断是编译慢还是端口/环境问题 |
| `test-api.ps1` 第一条断言就超时，或刚启动时首条 `FAIL` | 首次 `next dev` 是**冷编译**（路由与页面要现编译），就绪探测拿到 HTTP 响应之后，第一条断言仍可能正好撞上这段编译时间——这是首次编译慢，不是功能坏了：**直接重跑一次** `scripts\test-api.ps1` 即可（此时 `.next` 已热，通常很快通过）；机器确实慢就加大 `-StartTimeoutSeconds` |
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

## 9. 安全说明

- 上游凭证以 AES-256-GCM 加密存 SQLite，接口只返回 `maskedKey`（如 `sk-a…a1b2`）；
- 入站凭证（`authorization`、`x-api-key`、`cookie`）在下发上游前被剥离，上游错误体
  回传前按已知密钥脱敏，避免运维凭证泄漏给低权限客户端；
- 会话为无状态 HMAC 签名 Cookie（`HttpOnly`、`SameSite=Lax`，7 天有效），口令比较使用
  常量时间比较，并对失败登录做限流；
- 请求体与缓冲响应都有硬上限，防止单个低权限 Key 或恶意上游耗尽内存；
- `.env.local`、`data/`、`.dev-logs/` 与运行期 PID/端口文件均在 `.gitignore` 中。

---

## 10. 品牌资源与图标流水线

头部的图标（`public/brand-mark.png` 与两档 favicon）是 AI 生成后用
`design/build-brand-assets.py` 规整的位图：脚本把画面投影到 C10 双色
（`#121212` 底板 + `#3ecf8e` 品牌绿）再逐级下采样，因此图标里的绿与控制台的强调色是同一个
色值。母版来自阿里云 MaaS 的 `qwen-image-3.0-pro`（见 `design/ai-logo.py`），一次生成多个
构图方向后用 `design/score-logos.py` 按覆盖率、形状完整度、对称性、居中与留白客观打分，
再把胜出的那张规整成图标。同一份母版派生出三处产物，全部走 Next.js App Router 的文件约定，
不依赖外链图片：

| 文件 | 尺寸 | 用途 | Next 注入的标签 |
| --- | --- | --- | --- |
| `public/brand-mark.png` | 512×512 | 页面内品牌标识（`BrandMark`） | —（普通 `<img>`） |
| `src/app/icon.png` | 256×256 | 浏览器标签页 favicon | `<link rel="icon" type="image/png">` |
| `src/app/apple-icon.png` | 180×180 | iOS 主屏图标 | `<link rel="apple-touch-icon" sizes="180x180">` |

重新生成整套图标（换一版美术只需换 `--source`）：

```bash
python design/ai-logo.py --all                                   # 生成候选（需 design/.env）
python design/score-logos.py design/ai/*.png                     # 客观打分排序
python design/contact-sheet.py                                   # 拼对比图 design/logo-candidates.png
python design/build-brand-assets.py --source design/ai/<选中>.png  # 规整成三档图标
```

`design/` 下保留 AI 生成的原始母版（`design/ai/`，1328×1328）、打分脚本、对比图生成器与
像素自检脚本 `design/inspect-logo.py`（检查出血、主色板、包围盒与居中情况）。生成用的端点
与 Key 放在 `design/.env`，该文件被 `.gitignore` 覆盖，不会进仓库。

---

## 11. 已知限制

诚实划界：下面是当前实现**明确不做**或**覆盖不到**的部分。按现状规划使用方式，不要指望它们。

### 测试覆盖的边界

| 限制 | 现状 | 影响与做法 |
| --- | --- | --- |
| `tests/ui/**` 与 `tests/users-admin-ui/**` 不在 `npx vitest run` 的 include 里 | 根 `vitest.config.ts` 的 include 只有 `tests/unit/**/*.test.ts`，所以 `npm test` **不会**执行 `tests/ui/**`（含 `.tsx`）、`tests/users-admin-ui/**` 与 `tests/integration/**` | 改了控制台请显式跑 `npx vitest run --config tests/ui/vitest.config.ts`（它的 include 已同时覆盖 `tests/ui/**` 与 `tests/users-admin-ui/**`）；改了转发/脚本请跑 `npx vitest run --config tests/integration/vitest.config.ts`。`npm test` 全绿**不等于** UI 与脚本回归通过 |
| 端到端链路由 `scripts/test-api.ps1` 承担 | 它要真实起 dev server、真实端口、真实进程树，还要拉起桩上游，因此**不在** `npm test` 里，只能手工运行 | 改动转发逻辑前后运行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\test-api.ps1`，以退出码与 `PASS`/`FAIL` 明细为准。它完全离线，但要占端口与那把命名互斥量，且首次运行受冷编译影响（见「故障排查」） |
| 上游真实连通性需人工确认 | 桩上游只验证协议形状、鉴权与凭证注入/剥离，**不校验**真实上游：Key 是否有效、模型名是否存在、网络是否可达，都不在自动化覆盖范围内 | 在控制台「Provider」页对每个 provider 点「Test」（等价于 `POST /api/admin/providers/<id>/test`，5 秒超时探测 `/v1/models`）手工确认；接真实上游前这一步不能省 |

### 运行时与产品边界

- **单管理员**：只有一份 `ADMIN_PASSWORD` 会话，没有多用户、角色或权限分级；操作记录也不区分操作人；
- **不做协议互转**：provider 行上的 `protocol` 决定上游路径，OpenAI 形状的请求不会被翻译成 Anthropic 形状（反之亦然），也没有模型名映射/别名；
- **单机单进程**：数据层是 `node:sqlite` 本地单文件（WAL），启停互斥量是按仓库路径派生的 Windows 命名 Mutex，因此不支持多机/多实例共享同一份数据，也不适合水平扩展；
- **无 Mock 模式**：没有可用 provider 时转发直接返回结构化错误 JSON，不会伪造成功响应；
- **启停脚本仅 Windows PowerShell**：`scripts/*.ps1` 依赖 Windows 的进程/端口内核对象，Linux/macOS 上请自行 `npm run dev -- -p <port> -H 127.0.0.1` 并用 `curl` 等工具验证。
