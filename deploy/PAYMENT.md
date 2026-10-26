# 支付回调（OP-16）：对外地址与验签约定

> 状态：**约定已登记，路由尚未实现**。
> 本文件只写"约定与配置口径"，不含任何真实密钥。
> 验签实现：`apps/server/src/payments/callback-signature.ts`（纯函数 + 单元测试）。

## 0. 现状（实现本文件时的实测结论）

- 仓库里**没有**支付回调处理路由：`apps/server/src/payments/` 只有本单新增的验签模块；
  `apps/server/src/features/payments/lemon-squeezy-client.ts` 只有 checkout / subscription 的
  HTTP 客户端，**没有任何验签或入账逻辑**。
- 旧的支付入口已按 BL-40 / D-27 退役：`POST /api/payments/webhook`、`POST /api/payments/checkout`、
  `GET /api/payments/subscription`、`POST /api/payments/cancel`、`POST /api/payments/change-plan`
  统一返回 `410 feature_retired`（见 `apps/server/src/http/payments-retired.ts`）。
  这些路径**不读请求体、不读头、不写账**。
- 因此下面登记的 `/api/payments/callback` 目前**没有任何监听者**：在实现并验收之前，
  不要把它填到支付平台后台。

## 1. 对外回调地址（约定）

```
https://hahart.design/api/payments/callback
```

- 链路：`https://hahart.design` → Cloudflare 隧道 → 本机 Caddy → API `127.0.0.1:3001`。
- 方法：`POST`，`Content-Type: application/json`，请求体是平台原始 JSON。
- **未实现路由前不注册到支付平台**：路径现在会落到 404 / 410，注册过去只会让平台侧
  持续重试并把它在平台上标记为不可用。实现路由、加入验签、并出对应工单验收之后，
  才在平台后台填写这个地址。
- 这个地址是**唯一**对外口径；本地/staging 联调时用平台测试模式或临时隧道域名，
  不要把测试域名写进平台正式配置。

## 2. `HAHART_PAY_SIGN_KEY` 怎么配

共享密钥（HMAC 的 key）放在**服务端环境变量**里，名字固定为 `HAHART_PAY_SIGN_KEY`。

| 位置 | 怎么配 | 进不进仓库 |
|---|---|---|
| 本机开发 | 写在仓库根目录的 `.env.local`（已在 `.gitignore` 里） | 不进 |
| `.37` 生产 | 写在该机的 `.env.production`（或部署用的环境变量文件） | 不进 |
| 仓库 | 只出现在本文件与源码里（作为变量名），**任何真实值都不进仓库** | — |

规则：

1. **不得硬编码**：源码里只有变量名常量 `PAY_SIGN_KEY_ENV = "HAHART_PAY_SIGN_KEY"`，
   通过 `paySignKeyFromEnv()` 从 `process.env` 读取；值不打印、不写日志、不进错误响应。
2. **不得写进测试常量冒充真密钥**：测试用一次性假值（`test-only-...`）。
3. **生成方式**（任选，产出至少 32 字节随机）：`openssl rand -base64 48` 或
   `openssl rand -hex 32`。生成后直接粘贴到 `.env.local` / `.env.production`，
   不要经过聊天工具、工单、提交记录。
4. **未配置时的行为**：`paySignKeyFromEnv()` 返回 `undefined`（未设置与只有空白都算未配置），
   验签返回 `{ ok: false, reason: "missing_field" }` —— 也就是**一律拒绝**，不会出现
   "没配密钥就放行"的分支。
5. **轮换**：在平台侧与服务器两侧同时换（平台留旧密钥的过渡期由平台是否支持双密钥决定），
   换完重启 API 进程；旧的 `previous` 密钥不要在仓库任何地方留档。
6. 本变量目前**没有**登记在 `src/config/env.ts` 的 `ServerEnv` 里，也**没有**写进
   `.env.example`（本单白名单只含本文件与源码，改 `env.ts` / `.env.example` 需要另一张单）。
   在补齐之前，它由验签模块直接从 `process.env` 读取。

## 3. 验签算法与窗口

实现：`apps/server/src/payments/callback-signature.ts` 的 `verifyCallbackSignature()`。

```
canonical  = timestamp + "\n" + rawBody        // rawBody = 收到的原始 body 字节
signature  = hex( HMAC-SHA256( key = HAHART_PAY_SIGN_KEY, message = canonical ) )
```

请求里带两个值：

| 头 | 内容 | 例 |
|---|---|---|
| （平台约定的签名头） | 上面算出的 hex 摘要 | `9f2c...`（小写或大写 hex 均可） |
| （平台约定的时间戳头） | unix **秒**，纯 ASCII 数字 | `1793000000` |

校验顺序与失败原因（`reason`）：

| 顺序 | 检查 | 失败原因 |
|---|---|---|
| 1 | body / signature / timestamp / secret 是否都存在且非空白 | `missing_field` |
| 2 | timestamp 是否为纯数字（unix 秒） | `bad_timestamp` |
| 3 | `abs(now - timestamp) <= 窗口`（默认 **300 秒**，可由调用方传入；未来时间同样受限） | `expired_timestamp` |
| 4 | 用常量时间比较（`crypto.timingSafeEqual`，先比长度，长度不等直接判错，不抛异常）比较 hex 摘要 | `bad_signature` |

约定细节：

- **必须用原始 body 计算**，不能先 `JSON.parse` 再 `JSON.stringify`：键顺序与空白会变，
  签名就全错。
- 时间戳字符串**原样参与 HMAC**，所以改时间戳会让签名一起失效，不能"用旧签名配新时间戳"重放。
- 窗口默认 300 秒；平台重试间隔若超过它，平台必须重新签名（每次重试重新生成 timestamp）。
- `verifyCallbackSignature()` **不抛异常**，任何异常路径都返回 `{ ok: false, reason }`，
  调用方按原因回 `401`（不要回 `500`，否则平台会无限重试）。
- 幂等与重放：验签只回答"这包是不是平台发的、新不新"，同一笔订单重复投递仍要由入账侧
  按平台事件 id / 订单 id 去重（本单不含入账逻辑）。

## 4. 平台侧要填什么

| 项 | 填什么 |
|---|---|
| 回调地址（Webhook / notify URL） | `https://hahart.design/api/payments/callback`（**路由实现并验收后再填**） |
| 请求方法 | `POST` |
| 内容类型 | `application/json` |
| 签名密钥 | 与服务器 `HAHART_PAY_SIGN_KEY` 完全一致的那一串（在平台后台粘贴，不要从聊天记录里复制） |
| 签名算法 | `HMAC-SHA256`，输出 **hex**；被签内容 `${timestamp}\n${rawBody}` |
| 签名头名称 | 平台后台自定义，需与实现路由时的读取保持一致（实现前先定下来，写进那张单） |
| 时间戳头名称 | 同上；值必须是 unix **秒** |
| 事件范围 | 只订阅需要入账的事件（支付成功 / 退款 / 订阅变更），其余不要发 |
| 重试策略 | 平台默认即可；每次重试必须重新签名（新 timestamp），否则会被 `expired_timestamp` 拒掉 |
| 期望响应 | 验签通过 `2xx`；验签失败 `401`（平台会按自身策略重试） |
| 测试/沙箱 | 先用平台沙箱或本机隧道联调，确认收到 `2xx` 之后再切正式地址 |

## 5. 上线检查清单

- [ ] 路由已实现并注册到 API（本文件登记地址之前不存在监听者）
- [ ] `HAHART_PAY_SIGN_KEY` 在 `.37` 与本机 `.env.local` 都配好，且两边一致
- [ ] 用篡改 body / 过期 timestamp 各打一次，拿到 `401`
- [ ] 平台后台填好地址与密钥，沙箱投递拿到 `2xx`
- [ ] 入账侧有幂等去重（按平台事件 id）
- [ ] 日志里不出现密钥、不出现完整签名
