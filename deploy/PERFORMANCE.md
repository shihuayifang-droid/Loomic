# PERFORMANCE.md — 性能第 0 期 · 运维口径（OP-21 运维泳道）

> 本文件是 OP-21 的**运维口径**：慢查询阈值怎么设与怎么验证、索引审计结果与建议、前后数字从哪来、以及慢查询与现有告警的接入口。
> 审计脚本：`scripts/db-index-audit.mjs`（Node，**只读**）。本单**没有**在数据库上执行任何 DDL，**没有**修改任何服务器配置。
> 文中每个数字都标明来源，没有估算值。

---

## 1. 慢查询阈值：建议 `log_min_duration_statement = 200ms`

### 1.1 为什么是 200ms

- `/api/credits` 热态实测中位 ≈ **20ms**（19–27ms，见 §3），目标 ≤ 50ms。
- 200ms ≈ 现有热态的 **7–10 倍**、也是接口目标（50ms）的 **4 倍**：正常请求不会刷日志，一旦越线就说明有查询真的退化了。
- 阈值只影响日志量，不影响执行计划与业务行为，风险低；先用 200ms 收集一周，再按日志实际量决定要不要收紧到 100ms。

### 1.2 只写做法（本单未实际改生产配置）

在 `.37` 的数据库容器 / 实例上二选一：

1. **容器启动参数**（`deploy/docker-compose.yml` 的数据库服务 `command:` 追加）
   `-c log_min_duration_statement=200`，然后重建该容器。
2. **运行期参数**（不改文件，重启即失效）
   ```sql
   ALTER SYSTEM SET log_min_duration_statement = 200;
   SELECT pg_reload_conf();
   ```
   `ALTER SYSTEM` 写的是 `postgresql.auto.conf`，只影响日志级别，不阻塞连接。

### 1.3 怎么验证真的生效

1. 值生效：`SHOW log_min_duration_statement;` → 期望 `200ms`（不是 `-1`）。
2. 日志落地：`SHOW log_destination;` 与 `SHOW logging_collector;` 确认走容器 stdout 还是文件；`docker compose logs db` 里能看到 `LOG:` 级别行。
3. 触发一条**必然超阈值**的语句（只读，不写数据）：
   ```sql
   SELECT pg_sleep(0.3);
   ```
   期望日志出现形如 `LOG:  duration: 3xx.xxx ms  statement: SELECT pg_sleep(0.3);` 的一行；没有这一行说明阈值或日志目的地没生效。
4. 反向确认正常请求不被记录：跑一次热态 `/api/credits`（≈20ms），日志里**不应**出现该请求的语句。
5. （可选）`CREATE EXTENSION pg_stat_statements` 需要 DDL 与重启，**不在本单范围**，留给维护窗口。

> 排查慢日志时注意：`duration:` 行的 `statement:` 可能带参数占位符（`$1`），要结合 `reqId`/时间戳对应的应用日志定位端点。

---

## 2. 索引审计（真实运行输出）

命令（本机有 `DATABASE_URL`，PostgreSQL **16.6**）：

```bash
node --env-file=.env.local scripts/db-index-audit.mjs   # 或先 export DATABASE_URL 再 node scripts/db-index-audit.mjs
```

脚本行为：`DATABASE_URL` 不在 `process.env` 时打印 `SKIP no DATABASE_URL` 并以 exit 0 退出；否则只发 **SELECT / EXPLAIN / 元数据查询**，绝不写库。

### 2.1 审计到的表结构事实

| 请求的表 | 实际状态 | 现有索引（名 → 列） |
|---|---|---|
| `credits` | **schema public 里没有这张表**（`to_regclass` 返回 NULL）；积分状态在 `credit_*` 表 | —（故脚本回落到 `credit_*` 表，见下） |
| `canvases` | 存在，9 列（`id, project_id, name, is_primary, created_by, created_at, updated_at, content, version`） | `canvases_pkey(id)`、`canvases_one_primary_per_project_key(project_id) WHERE is_primary`、`canvases_project_id_idx(project_id)` |
| `projects` | 存在，11 列（`id, workspace_id, name, slug, description, created_by, archived_at, created_at, updated_at, thumbnail_path, brand_kit_id`） | `projects_pkey(id)`、`projects_id_workspace_id_key(id, workspace_id)`、`projects_workspace_id_idx(workspace_id)`、`projects_workspace_slug_key(workspace_id, slug)`、`projects_created_by_idx(created_by)` |

`credits` 回落到实际存在的积分表：

| 表 | 现有索引 |
|---|---|
| `credit_balances` | `credit_balances_pkey(id)`、`credit_balances_workspace_id_key(workspace_id)`（唯一） |
| `credit_transactions` | `idx_credit_transactions_workspace(workspace_id, created_at DESC)`、`idx_credit_transactions_job(job_id) WHERE job_id IS NOT NULL`、`credit_transactions_one_refund_per_job(job_id) WHERE …`、`credit_transactions_pkey(id)` |
| `user_credit_wallets` | `user_credit_wallets_pkey(user_id)` |
| `daily_credit_claims` | `daily_credit_claims_workspace_id_claim_date_key(workspace_id, claim_date)`、`daily_credit_claims_pkey(id)` |
| `team_credit_pools` | `team_credit_pools_pkey(workspace_id, period_month)` |
| `credit_cap_templates` | `credit_cap_templates_workspace_id_name_key(workspace_id, name)`、`credit_cap_templates_pkey(id)` |

### 2.2 EXPLAIN 结果（`EXPLAIN (FORMAT JSON)`，采样查询 = 各表「按属主/工作区取最新一页」）

| 表 | 采样查询的过滤/排序列 | Plan Rows | 是否走索引 | 计划节点链 |
|---|---|---|---|---|
| `canvases` | `project_id` / `updated_at` | 1 | no | `Limit > Sort > Seq Scan` |
| `projects` | `workspace_id` / `updated_at` | 1 | no | `Limit > Sort > Seq Scan` |
| `credit_balances` | `workspace_id` / `updated_at` | 1 | no | `Limit > Sort > Seq Scan` |
| `credit_transactions` | `workspace_id` / `created_at` | 1 | no | `Limit > Sort > Seq Scan` |
| `user_credit_wallets` | `user_id` / `updated_at` | 1 | no | `Limit > Sort > Seq Scan` |
| `daily_credit_claims` | `workspace_id` / `created_at` | 1 | no | `Limit > Sort > Seq Scan` |
| `team_credit_pools` | `workspace_id` / `updated_at` | 1 | no | `Limit > Sort > Seq Scan` |
| `credit_cap_templates` | `workspace_id` / `created_at` | 4 | **yes** | `Limit > Sort > Bitmap Heap Scan > Bitmap Index Scan(credit_cap_templates_workspace_id_name_key)` |

**读法**：本机这套库行数极少（`Plan Rows=1` 意味着顺序扫描只会碰到个位数行），planner 按代价选 `Seq Scan` 是**正确**选择，它**不**证明生产上会顺序扫描。所以下面的建议依据不是 `Seq Scan` 本身，而是两件可复核的事实：**计划链里出现 `Sort` 节点**（说明 `ORDER BY` 列没被索引覆盖）+ **`pg_indexes` 里过滤列/排序列是否成对出现**。

---

## 3. 索引建议表

| 表 | 建议索引 | 依据（EXPLAIN 看到的扫描方式或计划行数） | 预期收益 | 风险 |
|---|---|---|---|---|
| `projects` | `(workspace_id, updated_at DESC)` | 现只有 `projects_workspace_id_idx(workspace_id)`；采样计划 `Limit > Sort > Seq Scan`，`Sort` 说明 `ORDER BY updated_at DESC` 未被覆盖 | 项目列表（`/api/projects` 主查询）去掉一次内存排序；行数上万后走 Index Scan，翻到后几页不再全表取行 | 多一个 btree（写放大、磁盘）；`workspace_id` 单列索引可能变成冗余，但删除同样要维护窗口 |
| `canvases` | `(project_id, updated_at DESC)` | 现有 `canvases_project_id_idx(project_id)` 不含排序列；计划 `Limit > Sort > Seq Scan` | 画布列表按更新时间排序不再 `Sort`；`/api/canvases/{id}` 的明细查询仍由 `canvases_pkey` 承担 | 同上；`canvases` 含 `jsonb content`，索引只建在两列上，体积可控 |
| `credit_transactions` | **不需要新增** | 已有 `idx_credit_transactions_workspace(workspace_id, created_at DESC)`，采样查询的过滤列与排序列都被覆盖；`Plan Rows=1` 时 planner 选 `Seq Scan` 属正常 | 账单分页在数据量上来后直接走该索引 | 现状保持 |
| `user_credit_wallets` | **不需要新增** | 采样查询按 `user_id` 取行，`user_credit_wallets_pkey(user_id)` 已覆盖；`Plan Rows=1` | — | 现状保持 |
| `daily_credit_claims` | **不需要新增** | 已有 `(workspace_id, claim_date)` 唯一索引，覆盖"某工作区某天是否已领"这条每日发放的判定查询 | 每日发放判定保持索引命中 | 现状保持 |
| `team_credit_pools` | **不需要新增** | 主键 `(workspace_id, period_month)` 覆盖按工作区+月份的取行 | 团队池读取保持索引命中 | 现状保持 |
| `credit_balances` | **不需要新增** | `credit_balances_workspace_id_key(workspace_id)` 唯一索引覆盖"按工作区取余额" | 余额读取保持索引命中 | 现状保持 |
| `credit_cap_templates` | **不需要新增** | 审计中唯一走索引的表：`Bitmap Index Scan(credit_cap_templates_workspace_id_name_key)` | — | 现状保持 |

**完整索引落地需在维护窗口执行 DDL（`CREATE INDEX CONCURRENTLY`），属高风险操作，未在本单实施。** 本单只产出审计与建议，不碰生产库结构。

---

## 4. 前后数字（全部来自已有实测，无估算）

### 4.1 `/api/credits` 延迟（45CT，`.37` 实测）

| 指标 | 改前 | 改后 |
|---|---|---|
| 热态中位 | **65–67 ms** | **19–27 ms（中位 ≈ 20 ms）** |
| 冷启首调 | 268 ms | 205 ms |

改法：**先查后写** —— 三条写型语句（`bootstrap_viewer` / personal foundation / `grant_daily_credits`）改为先 `select 1 … limit 1` 探测，命中则只读返回。目标 ≤50ms，改后热态达标。

### 4.2 单语句增量 ≈ **+0.21 ms**（同机实测，证伪"每事务开销 67ms"）

| 执行方式 | 单次耗时 |
|---|---|
| 裸查询 | 0.11 ms |
| 事务包裹（`BEGIN + set_config + SQL + COMMIT`） | 0.32 ms |

即**每多一条语句只增约 +0.21 ms**：6 条语句合计 ≈1.3 ms，**解释不了 67 ms**。这条数字的原用途是**否掉**当时"事务包裹是主因"的假设（该假设已被证伪），不要再用它推算端点延迟。

### 4.3 重复调用（前端，45CV 实测）

单次 `/home` 加载的请求数：

| 指标 | 改前 | 改后 |
|---|---|---|
| 请求数 / 端点数 | **8 请求 / 6 端点** | **6 请求 / 6 端点** |
| 重复项 | `/api/viewer` ×2、`/api/credits` ×2 | 各 ×1 |

改法：`/api/viewer` 与 `/api/credits` 收敛到单一来源 + in-flight 去重（viewer 只合并进行中的请求、不缓存结果；credits 保持 5s TTL）。

> 口径说明（避免混淆）：需求原文里的 "22 次 / 15 次" 是**问题描述**，指 `/api/credits` 被调 **22 次**、`/api/canvases/{id}` 被调 **15 次**（见 `docs/项目/hahart/04-部署运维/自建部署与外网访问-方案.md` 第 449 行）；它不是一对"改前 → 改后"的数字。本文件里的前后对是 §4.3 的 8 → 6。

---

## 5. 与告警的接入口

事件名取自 `apps/server/src/observability/alerts.ts`：

- 第 62 行：`| "abnormal_spend"`（第 81 行中文名"异常消耗"）
- 第 67 行：`| "worker_unhealthy"`（第 86 行中文名"worker 不健康"）

| 告警 | 慢查询在这里怎么用 | 具体做法 |
|---|---|---|
| `abnormal_spend` | 慢查询导致的**超时重试 / 重复扣费**会先在这个事件上冒出来 | 该事件触发时，用慢日志同一时间窗（`duration: >200ms`）对照：若同一 `reqId` 的扣费语句超阈值，则根因归到 DB 退化而不是计费逻辑；否则才按计费 bug 排查 |
| `worker_unhealthy` | worker 心跳超时既可能是进程挂了，也可能是**它卡在慢 SQL 上**（批量领任务、写 `background_jobs`） | 该事件触发时先看慢日志有没有 worker 侧的写型语句；有则按 DB 退化处理（限流/扩连接），无再重启 worker |

落地方式（不改代码、不加新指标）：把 `log_min_duration_statement=200ms` 的日志按 `reqId` / `worker` 关键字与这两个事件的时间戳对齐即可；后续若要做成自动关联，再加一个读日志的采集器，本单不做。

---

## 6. 本单边界

- 只新增 `scripts/db-index-audit.mjs` 与 `deploy/PERFORMANCE.md` 两个文件。
- 未改生产配置、未建索引、未执行任何 DDL。
- 索引建议为**待评审**方案，落地需维护窗口 + `CREATE INDEX CONCURRENTLY`，属高风险操作。
