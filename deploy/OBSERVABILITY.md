# 可观测性：日志、告警事件与分发（OP-18）

> 本文件描述**当前代码里已经存在**的东西：`apps/server/src/observability/alerts.ts`
> 定义的事件与分发器，`apps/server/src/features/notifications/alert-sink.ts`（OP-11）
> 与 `mailer.ts`（BR-09）提供的两条出口。渠道选型（邮件 / 企业微信 webhook）
> 尚待用户决策（U-30），所以代码里的默认值是 `off`，本文件也不预设结论。
>
> 本文件不得写入任何真实地址、收件人、密钥或 token。示例一律用占位符。

## 1. 日志集中目前的做法

- 服务与 worker 的日志都写 **stdout / stderr**，代码里不落本地日志文件，不做轮转。
- 由部署侧收集：容器运行时（`deploy/docker-compose.yml`）的日志驱动负责落盘与转发，
  接入哪一家日志后端属于部署环境配置，不写在仓库里。
- 因此排障的第一现场是 `docker compose logs <service>`，而不是某个应用内日志目录。
- 结构化信息以单行 JSON 或带前缀的单行文本输出（如 `[alert:noop] …`），
  便于按前缀检索；应用不负责解析自己的日志。

## 2. 告警事件（六个）

事件常量是英文的，直接出现在日志、webhook body 与去重键里；中文标题是人读的
（邮件标题、webhook 的 `title` 字段）。定义见 `ALERT_EVENT_TITLES`。

| 事件常量 | 中文标题 | 含义 | 典型触发点 |
|---|---|---|---|
| `abnormal_spend` | 异常消耗 | 某一用户 / 任务 / 时间窗的算力或额度消耗显著偏离基线（例如单次任务消耗远超同类任务） | 额度扣减与用量统计路径，在单次或窗口汇总超出阈值时 |
| `reconcile_mismatch` | 对账不一致 | 内部账目与外部支付 / 渠道流水对不上（金额、笔数、状态任一不一致） | 每日对账任务 `daily-reconcile-schedule` 的差异分支 |
| `compensation_failed` | 补偿失败 | 失败任务的补偿（重试、退款、回滚）最终未成功 | 补偿执行器在重试耗尽或抛出不可恢复错误时 |
| `storage_above_80` | 存储使用率超过 80% | 对象存储 / 数据库 / 磁盘使用率越过 80% 水位线 | 容量巡检任务或部署侧的定时检查 |
| `cron_failed` | 定时任务失败 | 某个定时任务的一轮执行失败（异常退出、超时、前置条件不满足） | `stuck-job-reaper-schedule`、`job-retention-schedule` 等调度器的失败分支 |
| `worker_unhealthy` | worker 不健康 | worker 心跳缺失、卡死或健康检查不通过 | worker 健康检查 / 心跳超时判定处 |

调用形如 `dispatchAlert("cron_failed", { job: "reconcile" })`：
第二个参数是任意可 JSON 序列化的上下文，会原样进入邮件正文与 webhook body。

## 3. 渠道（三种取值，默认 `off`）

渠道由环境变量 `HAHART_ALERT_CHANNEL` 决定：

| 取值 | 行为 | 需要同时配置 | 缺失时 |
|---|---|---|---|
| `off`（**默认**） | 不分发，直接返回 `{ delivered: false, reason: "channel_off" }` | 无 | —— |
| `mail` | 通过 BR-09 的 mailer 发一封告警邮件 | `HAHART_ALERT_MAIL_TO`（收件人）；mailer 自身还需 `HAHART_MAIL_API_URL` + `HAHART_MAIL_API_TOKEN`（可选 `HAHART_MAIL_FROM`） | 返回 `mail_to_not_configured` / `mailer_not_configured` |
| `webhook` | 向 webhook 发一次 JSON POST（企业微信 / Slack 等机器人 URL） | `HAHART_ALERT_WEBHOOK_URL`（地址）；可选 `HAHART_ALERT_WEBHOOK_TOKEN`（变为 `Authorization: Bearer …`） | 返回 `webhook_url_not_configured` |

环境变量一览（值一律由部署侧注入，不写进仓库）：

```dotenv
HAHART_ALERT_CHANNEL=off            # off | mail | webhook
HAHART_ALERT_MAIL_TO=               # mail 渠道的收件人
HAHART_ALERT_WEBHOOK_URL=          # webhook 渠道的地址（占位示例：https://example.com/hook）
HAHART_ALERT_WEBHOOK_TOKEN=        # 可选，Bearer token
```

未设置、空白、拼错或无法识别的取值一律按 `off` 处理 —— 默认不发，是刻意的：
服务一上线就按错误配置乱发告警，比安静更糟。

## 4. 分发语义

- **绝不抛异常**：分发发生在业务已经在错误路径上的时刻，告警渠道失败不能变成第二个故障。
  任何失败都以 `{ delivered: false, reason }` 返回并记一行 `console.warn`。
- **去重窗口**：同一事件在窗口内（默认 5 分钟，`ALERT_DEDUP_WINDOW_MS`）只发一次，
  重复的返回 `{ delivered: false, reason: "deduped" }`。时钟与去重表都可注入，测试用移动时钟而不是等待。
- **只有成功才记入去重**：发送失败的事件下一轮仍会重试，不会被窗口静默掉。
- **超时**：webhook 与 mailer 都是 10 秒上限，超时按失败处理并吞掉。
- `reason` 的取值集合：`channel_off` / `deduped` / `mail_to_not_configured` /
  `mailer_not_configured` / `webhook_url_not_configured` / `delivery_failed`。

## 5. 尚待决策（U-30）

最终用**邮件**还是**企业微信 webhook**（或两者并存），属于产品/运维决策，目前未定。
因此：

- 代码默认 `off`，不绑定任何一家供应商；
- 邮件走的是通用 JSON 网关（供应商适配在网关侧），webhook 走机器人 URL，两者都不需要改代码即可切换；
- 决策落定后，只需要在部署环境设置 `HAHART_ALERT_CHANNEL` 及对应目标变量，本文件与代码无需改动。

## 6. 自测与验证

```bash
cd apps/server
pnpm exec vitest run --config vitest.isolated.config.ts src/observability --reporter=dot
```

用例覆盖：默认 off 不发且不抛、mail 渠道发出、webhook 渠道发出、窗口内重复被判 `deduped`、
发送抛错返回 `delivery_failed` 且不冒泡、六个事件都能构造并分发。
