# 本机 staging 运行手册（无容器）

> 读者：下一个接手本机环境的人。照着从头做一遍，能得到一套和当前一致的栈。
> **本机约定根目录：`D:\hahart-local`** —— 这是本机约定路径，不在仓库里、也没有版本管理；换机器时把它整体替换成等价路径即可，命令其余部分不用改。
> 本机是 Windows + PowerShell 5.1；`pnpm` 一律写成 `pnpm.cmd` 以外的形式时请在 PowerShell 里用 `pnpm`（若遇到执行策略问题改用 `pnpm.cmd`）。

---

## 本机 staging（无容器）

**定位**：开发机上的第二套可用栈，和 `.37` 上的容器部署**并存、互不影响**。

- `.37` 仍是**现役**：docker compose + nginx + Cloudflare Tunnel，安装与巡检步骤见 `deploy/README.md`。本章的任何操作都不碰 `.37`。
- 本机这套**不用容器**：该机 BIOS 未开 VT-x，Docker Desktop / WSL2 里的容器起不来，所以全部改成原生进程 —— Postgres 16.6 的 Windows 二进制 + node（API / worker / Next dev）。
- **不监听公网**：Postgres 只 `listen_addresses = '127.0.0.1'`，API 与 web 也只绑回环，没有隧道、没有证书、没有反向代理。
- **数据自包含**：库文件、对象文件、日志全在 `D:\hahart-local` 下；删掉这个目录就等于抹掉本机 staging 的全部数据，与 `.37` 的数据和仓库内容都无关。
- 用途：在本机跑真实后端 + 真实 Postgres 做冒烟与联调；不承担可用性、不代表生产形态。

---

## 组成与端口

| 组件 | 形态 | 监听 / 路径 | 启动方式 | 数据与日志 |
|---|---|---|---|---|
| PostgreSQL 16.6 | 原生 Windows 二进制（zip 解压） | `127.0.0.1:55432` | `pg_ctl -D D:\hahart-local\pgdata start` | 数据 `D:\hahart-local\pgdata`，日志 `D:\hahart-local\logs\pg.log` |
| API（`@loomic/server`） | node + tsx（`--watch`） | `http://127.0.0.1:3001` | `pnpm run dev:server`（cwd `apps/server`） | 控制台输出 |
| worker（`@loomic/server`） | node + tsx（无 watch） | 无端口，轮询队列 | `pnpm run worker`（cwd `apps/server`） | 控制台输出 |
| web dev（`@loomic/web`） | `next dev` | `http://127.0.0.1:3000` | `pnpm run dev`（cwd `apps/web`） | 控制台输出 |
| 对象存储（文件卷） | `HAHART_STORAGE_PROVIDER=fs` | 目录 `D:\hahart-local\objects`（`<bucket>/<key>`） | 随 API 起 | 文件即数据；签名读取由 API 签发 |

端口来源：API 端口来自 `HAHART_SERVER_PORT=3001`（`apps/server/src/config/env.ts` 的默认值也是 3001）；web 端口来自 `apps/web/package.json` 的 `dev` 脚本（`next dev -p 3000`）；库端口来自 `postgresql.conf` 里追加的 `port = 55432`。

---

## 一次性准备

四步，做完这四步之后每次只需要「起停」一节。**顺序不要换**：第 3 步（shared dist）没做，第 4 步与后面的 health 检查会直接踩坑。

### 1) Postgres 16.6 落地并启动

`D:\hahart-local` 是本机约定根目录，先建好，再把 Windows 版 Postgres 16.6 的 zip 解压到 `D:\hahart-local\pgsql`（解压后应能看到 `bin\initdb.exe`、`bin\pg_ctl.exe`、`bin\psql.exe`）。

```powershell
New-Item -ItemType Directory -Force -Path D:\hahart-local, D:\hahart-local\logs | Out-Null
# pg16.zip 放在 D:\hahart-local\pg16.zip，解压出 pgsql\ 目录
Expand-Archive -LiteralPath D:\hahart-local\pg16.zip -DestinationPath D:\hahart-local -Force
Test-Path D:\hahart-local\pgsql\bin\initdb.exe      # 期望 True
```

初始化数据目录（`-A trust` 只适用于本机回环，不要照搬到任何对外环境；`-E UTF8` 必须，否则中文/中文排序会坏）：

```powershell
& D:\hahart-local\pgsql\bin\initdb.exe -D D:\hahart-local\pgdata -U postgres -A trust -E UTF8 --locale=C
```

期望：最后打印 `Success. You can now start the database server using:` 以及一行 `pg_ctl ... start`。

改端口与监听地址 —— 追加到 `D:\hahart-local\pgdata\postgresql.conf` 末尾：

```ini
# hahart-local
port = 55432
listen_addresses = '127.0.0.1'
```

（`logging_collector` 保持 `off`，日志走 `-l` 指定的文件，免得 stderr 重定向到 Windows 上的空设备而丢日志。）

启动并建库：

```powershell
& D:\hahart-local\pgsql\bin\pg_ctl.exe -D D:\hahart-local\pgdata -l D:\hahart-local\logs\pg.log -w start
# 期望：server started
& D:\hahart-local\pgsql\bin\psql.exe -h 127.0.0.1 -p 55432 -U postgres -c "create database hahart"
# 期望：CREATE DATABASE
& D:\hahart-local\pgsql\bin\psql.exe -h 127.0.0.1 -p 55432 -U postgres -d hahart -tAc "select version()"
# 期望：PostgreSQL 16.6 ...
```

> 本机当时还留了一个等价脚本 `D:\hahart-local\pg-setup.ps1`（解压 + initdb + 改 conf + 启动 + 建库一条龙，末行打印 `PG_SETUP_DONE`）。它**不在仓库里**，换机器不会带上，所以上面把等价命令逐条写出来；脚本只作对照。

### 2) 装依赖（两个 filter 都要，缺一个起不来）

```powershell
pnpm install --filter @loomic/server --frozen-lockfile
pnpm install --filter @loomic/web --frozen-lockfile
```

期望：`Lockfile is up to date`、`Done in ...`，退出码 0。

**必须分别装**：`@node-rs/argon2` 是带平台二进制的原生包（server 密码哈希用），`next` 是 web 的工作区依赖；`--filter` 只装一个包时另一个不会被解析进来，表现是启动即报模块缺失。装完之后：

```powershell
Test-Path D:\AnimalMafia_ArtResource\Kiro-AnimalMafia\scripts\temp\_shell_cwd\<你的执行树>\node_modules\.pnpm   # 期望 True
Test-Path apps\server\node_modules\@node-rs\argon2                                        # 期望 True
```

安装依赖时**先把 `pnpm run dev:server` 停掉**（原因见「已知坑」的 `--watch` 一条）。

### 3) 构建 `@loomic/shared` 的 dist（必须做）

```powershell
pnpm --filter @loomic/shared build
```

期望：退出码 0（`tsc --build` 无输出即成功），产出 `packages/shared/dist/index.js` 与 `dist/index.d.ts`。

**这一步为什么必须**：服务端 import 的是 `@loomic/shared` 的 **dist**（`packages/shared/package.json` 的 `main`/`exports` 指向 `./dist/index.js`），不是 `src`。dist 落后于源码时，`GET /api/health` 直接 **500**，报：

```
Invalid literal value, expected "loomic-server"
```

那是因为旧 dist 里的响应契约字面量还是 `loomic-server`，而当前 `packages/shared/src/http.ts` 已经是 `z.literal("hahart-server")` —— 解析失败即 500。**这是本机最容易踩的坑：改了 shared 源码必须重新 build dist，不是重启 server 就行。**

### 4) 建表 + 建管理员

`db:migrate` / `db:bootstrap-admin` 这两个脚本定义在 `apps/server/package.json`，**要在 `apps/server` 目录下跑**（仓库根的 `package.json` 里没有这两个脚本）；在仓库根用 `pnpm --filter @loomic/server run <script>` 等价。

```powershell
cd apps\server
pnpm run db:migrate
```

期望：第一行 `applied=12 skipped=0`，随后 12 行 `applied <文件名>`，对应 `apps/server/db/canonical/0001_auth.sql` … `0012_brand_skills_home.sql`；退出码 0。第二次再跑期望 `applied=0 skipped=12`（幂等）。

建管理员（密码只从环境变量读，**从不打印**）：

```powershell
# PowerShell
$env:HAHART_BOOTSTRAP_ADMIN_PASSWORD = "<自己定的强密码>"
pnpm run db:bootstrap-admin -- --email admin@hahart.local
Remove-Item Env:\HAHART_BOOTSTRAP_ADMIN_PASSWORD
```

```bash
# bash 写法（同一个脚本，仅语法不同）
HAHART_BOOTSTRAP_ADMIN_PASSWORD='<自己定的强密码>' pnpm run db:bootstrap-admin -- --email admin@hahart.local
```

期望：退出码 0，打印创建结果（新建账号 + 个人工作区 + 单团队工作区）。同一邮箱重跑**不会改密码**。密码策略由 `apps/server/src/auth/password.js` 校验，太弱会以退出码 1 失败。

---

## 环境变量

仓库根的 `.env.local`（`.gitignore` 里已有 `.env*.local`，不会进仓库）。做法是先 `Copy-Item .env.example .env.local`，再按下面这张表改；`.env.example` 里用不到的键留空即可。

| 键 | 本机取值 | 说明 |
|---|---|---|
| `DATABASE_URL` | `postgresql://postgres@127.0.0.1:55432/hahart` | 指向本机 Postgres；`native` 队列与迁移都读它 |
| `HAHART_SERVER_PORT` | `3001` | API 端口 |
| `HAHART_WEB_ORIGIN` | `http://localhost:3000` | CORS 允许的 web 源 |
| `NEXT_PUBLIC_SERVER_BASE_URL` | `http://127.0.0.1:3001` | web 直连 API（本机没有 nginx 同源代理那一层） |
| `HAHART_AUTH_PROVIDER` | `self` | 自研认证；`self` 仅限全新库 |
| `HAHART_AUTH_JWT_SECRET` | `<32 字节以上随机串>` | `self` 模式必填，短于 32 字节拒绝启动 |
| `HAHART_STORAGE_PROVIDER` | `fs` | 对象存储走本地文件卷 |
| `HAHART_OBJECT_ROOT` | `D:\hahart-local\objects` | 文件卷根目录，目录内按 `<bucket>/<key>` 存放 |
| `HAHART_OBJECT_URL_SECRET` | `<32 字节以上随机串>` | 签名读取用，短于 32 字节拒绝启动 |
| `HAHART_OBJECT_PUBLIC_BASE` | `<本机 API 基址，例 http://127.0.0.1:3001>` | `fs` 模式必填，用来拼对象 URL |
| `HAHART_QUEUE_PROVIDER` | `native` | 新库里的原生队列（需要 `DATABASE_URL`） |
| `HAHART_IMAGE_PROVIDER_MOCK` | `1` | 出图全部走 mock，不打真实上游 |
| `HAHART_SKILLS_ROOT` | `../../skills` | 相对 `apps/server` 的工作目录解析 |
| `HAHART_AGENT_MODEL` | `google:gemini-3-flash-preview` | 与 `.env.example` 默认一致；真要跑通需 `GOOGLE_API_KEY` |
| `WORKER_ID` | `w1` | worker 日志里的稳定标识 |

随机串可以这样生成（96 个 hex 字符）：

```powershell
-join (1..48 | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })
```

**文档与仓库里都不放真实密钥**：`HAHART_AUTH_JWT_SECRET`、`HAHART_OBJECT_URL_SECRET`、`HAHART_BOOTSTRAP_ADMIN_PASSWORD`、任何上游 API key 一律用上面的占位符，实际值只写在本机 `.env.local` 与 `D:\hahart-local\admin.txt` 里。

`HAHART_IMAGE_PROVIDER_MOCK=1` 意味着**本机不做真实出图**：真实上游（kwjm 网关）余额为 0，真实生成返回 `403 insufficient balance`，该问题挂在 U-25，与这套栈的搭建无关；要验真实出图必须先解决 U-25。

---

## 起停

所有命令在仓库根带 `pnpm --filter ...` 形式给出；也可以 `cd` 到对应包目录后直接用包内脚本名。

**server**（前台跑，占一个终端）：

```powershell
pnpm --filter @loomic/server run dev:server
# 等价：cd apps\server; pnpm run dev:server
```

**不要用 `pnpm run dev`**（根 `package.json` 里 `dev` 是 `turbo run dev`，`apps/server` 的 `dev` 又用 `&` / `wait` 串起 server+worker，那两个是 bash 语法，Windows 下无效）。

自检：

```powershell
curl.exe -s --max-time 10 http://127.0.0.1:3001/api/health
# 期望：{"ok":true,...,"service":"hahart-server"}
```

**worker**（另一个终端；它没有 `--watch`）：

```powershell
pnpm --filter @loomic/server run worker
# 等价：cd apps\server; pnpm run worker
```

**web dev**（第三个终端）：

```powershell
cd apps\web
$env:NEXT_PUBLIC_SERVER_BASE_URL = "http://127.0.0.1:3001"
pnpm run dev
# 等价：pnpm --filter @loomic/web run dev（此时先在根 .env.local 里放好 NEXT_PUBLIC_SERVER_BASE_URL）
```

期望：`next dev -p 3000` 打印 `Ready in ...`，`http://127.0.0.1:3000/` 返回 200。

**停**：

```powershell
& D:\hahart-local\pgsql\bin\pg_ctl.exe -D D:\hahart-local\pgdata stop
# 期望：server stopped

# 结束占着 3001 / 3000 的 node 进程（先看清单再杀）
Get-NetTCPConnection -LocalPort 3001, 3000 -State Listen |
  Select-Object LocalPort, OwningProcess |
  Sort-Object LocalPort -Unique
Get-NetTCPConnection -LocalPort 3001, 3000 -State Listen |
  Select-Object -ExpandProperty OwningProcess -Unique |
  ForEach-Object { Stop-Process -Id $_ -Force }
```

顺序建议：先停 web / server / worker，最后停 Postgres；先停 Postgres 的话 API 会因连接断开持续报错刷屏。

---

## 冒烟

本机用 **PowerShell 版** `D:\hahart-local\smoke.ps1`：检查项与 `.37` 的 `smoke.sh` 相同，去掉容器专属项（容器状态、nginx 同源代理、compose 健康检查）。脚本是**纯 ASCII**（PowerShell 5.1 按 GBK 读 `.ps1`），要改也请保持 ASCII。

跑之前：Postgres、API、worker、web 四个都得起着，且第 4 步的 `db:migrate` 与管理员已就绪。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File D:\hahart-local\smoke.ps1
```

期望最后一行：

```
SMOKE pass=11 fail=0
```

11 项检查（按脚本里的顺序与名字）：

| # | 检查名 | 打的是哪个端点 | 判据 |
|---|---|---|---|
| 1 | `web /` | `GET http://127.0.0.1:3000/` | 200 |
| 2 | `api health` | `GET http://127.0.0.1:3001/api/health` | 响应含 `"ok":true` 且含 `hahart-server`（含 `loomic-server` 说明 shared dist 旧了） |
| 3 | `sign-in` | `POST /api/auth/sign-in`，body `{"email","password"}` | 200 且 `accessToken` 长度 > 100；密码从 `D:\hahart-local\admin.txt` 的 `password=` 行读 |
| 4 | `viewer` | `GET /api/viewer`（带 `authorization: Bearer <token>`） | 200 |
| 5 | `create project` | `POST /api/projects`，body `{"name"}` | 201 且返回 `project.id` 与 `project.primaryCanvas.id` |
| 6 | `list projects` | `GET /api/projects` | 200 |
| 7 | `read canvas` | `GET /api/canvases/<primaryCanvas.id>` | 200 |
| 8 | `upload` | `POST /api/uploads`（multipart：`projectId` + `file`，1×1 PNG） | 201 且返回 `url` |
| 9 | `signed read` | `GET <upload 返回的 url>` | 200 |
| 10 | `unsigned read refused` | `GET <url 去掉 ? 之后的裸路径>` | 非 200（签名缺失必须被拒） |
| 11 | `websocket` | `ws://127.0.0.1:3001/api/ws?token=<token>`（node 内建 WebSocket，8s 超时） | 打印 `open` |

**两个必踩的坑**：

1. **PowerShell 5.1 把 JSON 传给 `curl.exe -d` 会被吃引号。** PS 会重解析原生进程的引号，`-d '{"email":"x"}'` 到 curl 手里变成 `{email:x}`，后端直接 400/解析失败。正确做法：把 body 用显式 UTF-8 写到文件，再 `-d @文件`：

   ```powershell
   $f = "D:\hahart-local\logs\body.json"
   [IO.File]::WriteAllText($f, (@{ email = "admin@hahart.local"; password = $pw } | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
   curl.exe -s --max-time 30 -o D:\hahart-local\logs\out.json -w "%{http_code}" -X POST http://127.0.0.1:3001/api/auth/sign-in -H "content-type: application/json" -d "@$f"
   ```

   `smoke.ps1` 的 `PostJson` 就是这么写的；`-d` 引号内加 `@` 是 curl 的读文件语法，不要改。

2. **漏带 `authorization` 头会得到 401。** `/api/viewer`、`/api/projects`、`/api/canvases/*`、`/api/uploads` 都要 `authorization: Bearer <accessToken>`；`smoke.ps1` 里 `GetCode` 有无头是两种调用方式，手动测试时最容易漏。401 不是服务没起来，先看头再怀疑服务。

---

## 与 .37 的差异

| 维度 | 本机 staging | `.37`（现役） |
|---|---|---|
| 运行方式 | 原生进程（Postgres 二进制 + node + next dev） | Docker Compose 容器（web / server / worker / nginx / postgres） |
| 入口与代理 | **无 nginx**：同源代理那层不存在，web 用 `NEXT_PUBLIC_SERVER_BASE_URL=http://127.0.0.1:3001` **直连 3001** | nginx 做同源代理与静态托管，浏览器只同源访问 |
| 对外暴露 | 只回环（3001/3000/55432），不监听公网 | Cloudflare Tunnel 终结 TLS，源站 nginx 监听 80 |
| 容器级验证 | **无**：没有容器，就没有「重建容器 / 冷启动后仍可用」这类验证（`.37` 的网桥自愈、`REVISION`、每日备份都属于容器侧，本机不做） | 有：`docker compose` 重建、`hahart-bridge-rules.service`、`hahart-backup.timer`、`REVISION` 文件（见 `deploy/README.md`、`deploy/BACKUP.md`） |
| Node 版本 | **Node 24**（本机装的） | 按仓库开发的 Node 22 |
| 冒烟脚本 | `D:\hahart-local\smoke.ps1`（PowerShell，11 项） | `smoke.sh`（bash，含容器专属项） |
| 对象存储根 | `D:\hahart-local\objects`（`fs` 文件卷） | 容器内挂载的对象目录 |
| 数据 | 可随意删（`D:\hahart-local`），删完按「一次性准备」重建 | 生产数据，只能走备份/恢复流程 |

---

## 已知坑

1. **shared dist 旧 → `GET /api/health` 500**，报 `Invalid literal value, expected "loomic-server"`。服务端读的是 `packages/shared/dist`，改过 shared 源码（或从旧提交拉下来）必须重跑 `pnpm --filter @loomic/shared build`。判断依据看 health 响应里的 `service` 字面量。

2. **`node --watch` 把 `node_modules` 的变动当代码变更，反复重启。** `apps/server` 的 `dev:server` / `dev:worker` 带 `--watch`；`pnpm install` 期间会写 `node_modules`（以及 workspace link），watch 就一遍遍重启，表现为「装依赖时服务疯狂重启、日志刷满、偶发端口占用」。**装依赖前先停掉 `dev:server`/`dev:worker`**。另外 `dev:server` 用的是 `--env-file=../../.env.local`（不是 `--env-file-if-exists`）：`.env.local` 不存在时 node 直接报错退出，先按「环境变量」一节建好文件。

3. **`POST /api/uploads` 在 `projectId` 缺失时仍会返回 201**，对象落到**工作区**前缀而不是项目前缀。也就是说 201 本身不能当「项目上传成功」的证据 —— 写冒烟/巡检时不要用空 `projectId` 当成功依据，必须校验返回的 `url`（以及它落在项目前缀下），否则会把「字段没带上」误判成通过。

4. **仓库根的 `package.json` 里没有 `dev:server` / `worker` / `db:migrate` / `db:bootstrap-admin`**，它们都在 `apps/server/package.json`。在仓库根直接 `pnpm run dev:server` 会报 `Missing script`；要么 `cd apps\server`，要么用 `pnpm --filter @loomic/server run <script>`。

5. **不要在 PowerShell 5.1 里用 `>` 写文件**（会写成 UTF-16LE，node 读不了 JSON/env），用 `[IO.File]::WriteAllText(路径, 内容, [Text.UTF8Encoding]::new($false))`；`.ps1` 一律纯 ASCII。

6. **`HAHART_QUEUE_PROVIDER=native` 依赖 `DATABASE_URL`**，`HAHART_STORAGE_PROVIDER=fs` 依赖 `HAHART_OBJECT_ROOT` / `HAHART_OBJECT_URL_SECRET`（≥32 字节）/ `HAHART_OBJECT_PUBLIC_BASE` 三个都在；缺任何一个都是**启动即拒绝**并打印一行明确的缺失说明，不是运行期才坏。
