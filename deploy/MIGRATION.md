# 整机迁移 runbook（`.74` 自主服务栈 → 目标机）

> 本单状态：**本单未执行真演练，需目标机**。这里只交付「照着做就能迁 + 迁前能自检」。
> 迁前自检脚本：`scripts/migration-precheck.ps1`（只读，打印逐项 OK/MISSING + `SUMMARY ok=<n> missing=<m>`）。
> 真实形态按 `.74`（Windows）现状写，**不是 Docker**；旧文档里的 Docker/Compose 假设（`deploy/verify-tunnel.sh` 一类）不适用于本机栈。

---

## 1. 现状：要迁的到底是什么

| 组件 | 真实形态 | 本机位置 |
|---|---|---|
| 静态站 + 反代 | **Caddy :80**：`apps/web/out` 静态托管；`/api/*` → `127.0.0.1:3001`；`www.hahart.design` → `https://hahart.design` 301 | `D:\hahart-local\bin\caddy.exe`，配置 `D:\hahart-local\bin\Caddyfile` |
| API | **Fastify :3001**（Node 进程，监听回环） | 仓库 `apps/server` 构建产物 |
| 数据库 | **Postgres :55432**（非默认端口） | 数据目录 `D:\hahart-local\pgdata`，二进制 `D:\hahart-local\pgsql` |
| 对外入口 | **cloudflared** 隧道 `hahart`（ingress → `http://127.0.0.1:80`），跑在计划任务里 | `D:\hahart-local\bin\cloudflared.exe`，配置 `D:\hahart-local\cf\config.yml`，凭据 `D:\hahart-local\cf\<tunnel-uuid>.json` |
| 计划任务 | `hahart-tunnel`（cloudflared）、`hahart-jenkins-agent`（`cmd /c D:\hahart-local\ci\start-agent.cmd`）、`hahart-gitdaemon74`（`git daemon --base-path=D:\hahart-local\ci --port=9418`） | 任务计划程序 |
| 仓库 | 分支 `hahart/p0`，工作树 `D:\cherry stuido\Loomic`；CI 通过 git daemon（:9418）+ Jenkins agent 取代码 | — |

迁完之后，Caddy 只对外提供 80；TLS 由 Cloudflare 边缘终结（`auto_https off`），所以**新机不需要证书**。

---

## 2. 迁移清单：必须带走的 7 类东西

| # | 类别 | 具体内容 | 带走方式 |
|---|---|---|---|
| 1 | **仓库 + 构建产物** | `D:\cherry stuido\Loomic`（含 `.git`，分支 `hahart/p0`）；`apps/web/out`（静态站已构建结果）；`apps/server` 构建产物 | 仓库走 `git clone` / `git bundle`（`D:\hahart-local\ci\p0.bundle` 可作离线包）；产物可新机重新 `build` 或整目录拷 |
| 2 | **PG 数据目录或 dump** | 首选 `pg_dump` 逻辑备份（跨版本更稳）；`D:\hahart-local\pgdata` 仅在同版本二进制下直接搬 | `pg_dump -p 55432 -Fc` 出 `.dump`（本机样例 `D:\hahart-local\import\hahart.dump`） |
| 3 | **`.env.local`（含密钥）** | 两个位置：仓库根 `.env.local`、`apps/web/.env.local`（另有 `deploy/.env.production.example` 只作键名模板） | **单独加密传递**（压缩 + 加密，或经密码管理器/安全渠道），**不进仓库、不进群、不贴文档** |
| 4 | **Caddy 配置与二进制** | `D:\hahart-local\bin\caddy.exe` + `D:\hahart-local\bin\Caddyfile` | 整文件拷；`Caddyfile` 里 `root` 指向仓库的 `apps\web\out`，新机路径变了要同步改 |
| 5 | **cloudflared 凭据与 config** | `D:\hahart-local\bin\cloudflared.exe`、`D:\hahart-local\cf\config.yml`、`D:\hahart-local\cf\<tunnel-uuid>.json`；`cf-token.txt` / `cf-zone.txt` 为改 DNS 用的 API token / zone id | 同样**只经加密渠道**；凭据 json 等于隧道身份，泄露即等于隧道被接管 |
| 6 | **计划任务清单** | `hahart-tunnel`、`hahart-jenkins-agent`、`hahart-gitdaemon74`（含运行账户、触发器、动作参数、工作目录） | 在新机**重新创建**（导出/导入 XML 亦可），不要指望拷目录就恢复 |
| 7 | **本机自建脚本** | `D:\hahart-local\pg-setup.ps1`、`D:\hahart-local\smoke.ps1`、`D:\hahart-local\ci\start-agent.cmd`（内含 Jenkins agent secret，整体带走、不贴任何文档） | 整文件拷 + 检查里面的绝对路径是否仍是新机的路径 |

**不要带走**：`D:\hahart-local\log*`、`D:\hahart-local\import\*.tgz` 之类的临时产物、`pg16.zip` 安装包（新机按需重新下载）。

---

## 3. 步骤

### 3.1 目标机准备
1. 装 Node（跑 `apps/server`）、Git、Postgres（版本与旧机一致）、可选 JDK21（跑 Jenkins agent）。
2. 建运行时根目录 `D:\hahart-local\`，其下 `bin\` `cf\` `ci\` `import\` `logs\`。
3. 确认本机 80、3001、55432、9418 端口未被占用；防火墙只放行集群内需要的端口（对外只靠隧道，不直接暴露 80）。

### 3.2 还原仓库与产物
1. `git clone`（或 `git bundle` 解包）到新机，切到 `hahart/p0` 目标提交。
2. 装依赖并构建：`pnpm.cmd install` → 构建 server、导出 `apps/web/out`。
3. 校验 `apps/web/out/index.html` 存在，否则 Caddy 静态兜底会 404。

### 3.3 还原 PG
1. 用新机二进制初始化数据目录（沿用旧机 `pg-setup.ps1` 的端口/参数，端口必须是 **55432**）。
2. `pg_restore -p 55432 -d <db> hahart.dump`（旧机导出的 dump）。
3. 起 PG 并确认 `Get-NetTCPConnection -LocalPort 55432 -State Listen` 有结果。
4. 行数抽查几张核心表，与旧机对比量级（不做全量校验，只看有没有明显缺表）。

### 3.4 放配置
1. 把 `.env.local`（仓库根）与 `apps/web/.env.local` 解密放到同位置，权限只给服务账户。
2. 把 `caddy.exe` + `Caddyfile` 放到 `D:\hahart-local\bin\`，**改 `Caddyfile` 里的 `root` 为新机仓库的 `apps\web\out` 绝对路径**。
3. 把 `cloudflared.exe` 放到 `bin\`，`config.yml` + `<tunnel-uuid>.json` 放到 `cf\`，`config.yml` 里的 `credentials-file` 改成新机路径。

### 3.5 起 Caddy / API
1. 起 API（`apps/server`，监听 `127.0.0.1:3001`），确认日志无报错。
2. 起 Caddy：`D:\hahart-local\bin\caddy.exe run --config D:\hahart-local\bin\Caddyfile`。
3. 本机验：`curl -s -o NUL -w "%{http_code}" http://127.0.0.1/` 应为 200；`http://127.0.0.1/api/health` 应为 200。
4. 建计划任务：`hahart-tunnel`（cloudflared，参数照旧机：`tunnel --config <config.yml> run hahart`）、`hahart-jenkins-agent`（`cmd /c D:\hahart-local\ci\start-agent.cmd`）、`hahart-gitdaemon74`（`git daemon --base-path=D:\hahart-local\ci --export-all --reuseaddr --port=9418`），账户与旧机一致。

### 3.6 装 cloudflared 并改 DNS 指向新机
1. 隧道**不用重建**：同一 `<tunnel-uuid>` 换个地方跑起来即可，DNS CNAME 仍指向 `<uuid>.cfargotunnel.com`。
2. 真正要改的是**新机能不能出网**：cloudflared 出站 7844/UDP+HTTPS 必须通；不通就先排查出网，别先动 DNS。
3. 需要改 DNS 时用 Cloudflare API（zone id 与 token 从 `D:\hahart-local\cf-zone.txt` / `cf-token.txt` 读，**token 只存本机，不入库、不写进脚本、不贴文档**）：
   ```powershell
   # 示例形状，不要把 token 明文写进仓库或命令历史文件
   $h = @{ Authorization = "Bearer $env:CF_API_TOKEN"; 'Content-Type' = 'application/json' }
   Invoke-RestMethod -Method Patch -TimeoutSec 30 -Headers $h `
     -Uri "https://api.cloudflare.com/client/v4/zones/<zone-id>/dns_records/<record-id>" `
     -Body '{"content":"<new-tunnel-uuid>.cfargotunnel.com"}'
   ```
4. **新旧并行窗口**：先把新机隧道跑起来，用 `cloudflared` 的独立 hostname（如 `new.hahart.design`）验证全绿，再把 `hahart.design` / `www.hahart.design` 的记录切过去。观察窗口建议 ≥30 分钟，覆盖一次真实用户访问高峰。

---

## 4. 验证清单（迁完逐条打勾）

| # | 项 | 命令 / 做法 | 预期 |
|---|---|---|---|
| 1 | 站点首页 | `curl -s -o NUL -w "%{http_code}" https://hahart.design` | `200` |
| 2 | API 健康 | `curl -s -o NUL -w "%{http_code}" https://hahart.design/api/health` | `200` |
| 3 | www 跳转 | `curl -s -o NUL -w "%{http_code}" https://www.hahart.design` | `301` |
| 4 | 发信 | `bash deploy/verify-mail.sh`（或走应用内测试发信接口） | `exit 0` |
| 5 | 仓库可达 | `git ls-remote <新机 git daemon 地址>` | 退出码 0，列出 refs |
| 6 | CI 能跑 | 在 Jenkins 上手动触发一次 P0 流水线 | 构建成功、能 checkout 到新机仓库 |
| 7 | 计划任务 | `Get-ScheduledTask -TaskName hahart-tunnel,hahart-jenkins-agent,hahart-gitdaemon74` | 三个任务均 `Running` / `Ready` |
| 8 | 迁前自检 | `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/migration-precheck.ps1` | 末行 `SUMMARY ok=<n> missing=0`，退出码 0 |

> 注意：上表第 2 条的 `/api/health` 由 Fastify 提供；若 502，先查 `127.0.0.1:3001` 是否活着，再查 Caddy 的 `reverse_proxy` 目标。

---

## 5. 回滚

**一句话操作**：把 Cloudflare DNS 里 `hahart.design` / `www.hahart.design` 的记录 content 改回旧机隧道的 `<old-uuid>.cfargotunnel.com`（同 3.6 的 PATCH 调用，换 content 即可）。

```powershell
# 回滚 = 同一调用，content 换回旧隧道 uuid
# PATCH .../dns_records/<record-id> -Body '{"content":"<old-tunnel-uuid>.cfargotunnel.com"}'
```

回滚前提与注意：
- 旧机（`.74`）在观察窗口内**保持在线、PG 不删、Caddy 不停**，否则回滚只剩 DNS 没有后端。
- 回滚后旧机 PG 里的数据可能落后于新机期间产生的写入 —— 观察窗口内尽量只读验证，或明确接受这段数据丢失再切。
- DNS 生效有 TTL 缓存（Cloudflare 代理记录通常秒级，但客户端可能有缓存），回滚后 1–5 分钟内复核第 4 节第 1–3 条。
- 新旧并行观察窗口建议 ≥30 分钟；窗口结束后再拆旧机任务、旧机 PG 只做只读封存一段时间再删。

---

## 6. 迁前自检脚本用法

```powershell
# 在执行树根（或任一新机仓库根）跑；纯只读，不写文件、不起停服务
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/migration-precheck.ps1

# 可选参数：仓库根 / 运行时根 / PG 端口
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/migration-precheck.ps1 `
  -RepoRoot "D:\cherry stuido\Loomic" -HahartBase "D:\hahart-local" -PgPort 55432
```

输出形如：

```
repo-root=D:\cherry stuido\Loomic
OK repo D:\cherry stuido\Loomic
OK apps/web/out D:\cherry stuido\Loomic\apps\web\out
OK env .env.local keys=22
...
SUMMARY ok=12 missing=0
```

检查项：仓库路径、`apps/web/out`、两个 `.env.local` 的**键数量**（只打印数量，绝不打印值）、Caddy 可执行与 `Caddyfile`、cloudflared 可执行 / `config.yml` / 凭据 json、计划任务 `hahart-tunnel` 与 `hahart-jenkins-agent`、PG 端口 55432 监听。
有任一 MISSING → 退出码 **1**；全部存在 → 退出码 **0**。

---

## 7. 本单未做的事

- **未执行真演练**：本单没有目标机，只做了「清单 + 步骤 + 验证 + 回滚」的文档与只读自检脚本，本机能验的只有脚本本身。
- 未打包/未加密传递任何真实密钥；`.env.local`、`cf/token`、`<tunnel-uuid>.json`、Jenkins agent secret 都只在原机，按第 2 节走加密渠道。
- 真演练需要第二台机器（C 类），届时按第 3、4 节跑一遍并把实际耗时与踩坑补回本文。
