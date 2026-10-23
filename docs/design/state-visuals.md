# 状态视觉规范（BR-15）

> 单一来源：`apps/web/src/lib/state-visuals.ts`。本稿与代码逐项一致，`apps/web/test/state-visuals.test.ts` 会核对。
> 色调（tone）→ 类名见 `TONE_CLASSES`；品牌色 ink `#111111`、accent `#E4F23A`（BR-04）。

## 1. 价格五态

| 状态 | 文案 | 色调 | 图标 | 动画 | 出现位置 | 一期是否已用 |
|---|---|---|---|---|---|---|
| estimating | 估算中 | progress | spinner | 是 | `apps/web/src/components/ui/price-tag.tsx` | 是 |
| priced | 询价返回的数字（无固定文案） | neutral | none | 否 | `apps/web/src/components/ui/price-tag.tsx` | 是 |
| free | 免费 | success | none | 否 | `apps/web/src/components/ui/price-tag.tsx` | 是 |
| pending | 待定价 | warning | none | 否 | `apps/web/src/components/ui/price-tag.tsx` | 是 |
| error | 价格获取失败，点击重试 | danger | none | 否 | `apps/web/src/components/ui/price-tag.tsx` | 是 |

## 2. 占位六态

| 状态 | 文案 | 色调 | 图标 | 动画 | 出现位置 | 一期是否已用 |
|---|---|---|---|---|---|---|
| queued | 排队中 | neutral | clock | 否 | `apps/web/src/hooks/use-job-progress-label.ts` → `generation-shimmer.tsx` | 是 |
| running | 生成中 | progress | spinner | 是 | `apps/web/src/components/media/generation-shimmer.tsx` | 是 |
| retrying | 重试中 | warning | refresh | 是 | `apps/web/src/lib/job-status.ts`（`formatRetryLabel`）→ `generation-shimmer.tsx` | 是 |
| failed | 生成失败 | danger | alert | 否 | `apps/web/src/components/media/failed-generation-slot.tsx` | 是 |
| canceled | 已取消 | neutral | ban | 否 | 无独立占位（取消即删除占位） | 否 |
| succeeded | 完成 | success | check | 否 | 无独立占位（完成即替换为结果） | 否 |

## 3. 标识四种

| 标识 | 文案 | 色调 | 图标 | 动画 | 出现位置 | 一期是否已用 |
|---|---|---|---|---|---|---|
| trial | 试用 | info | sparkle | 否 | 待实现（BL-08，P2） | 否 |
| demo | 演示模式 | warning | none | 否 | 待实现（X-23，P2） | 否 |
| stopped | 已停止 | neutral | stop | 否 | 待实现（AG-37，P1） | 否 |
| readonly_share | 只读 | info | eye | 否 | 待实现（PJ-10，P1） | 否 |

## 4. 透明棋盘格

唯一定义：`TRANSPARENT_CHECKERBOARD_STYLE`（`state-visuals.ts`）；8px 方格、`#ccc` 与透明交替。
出现位置：`apps/web/src/components/canvas-bottom-bar.tsx`（背景色「透明」色块）。一期已用：是。CV-15 画布透明棋盘格后续也引用同一定义。

## 5. 失败态与未开始态的区分

- failed：danger 边框 + 警示图标（alert）+ 文案「生成失败」+ 原因 + 重试 / 删除。
- queued：中性（neutral）边框 + 时钟图标（clock）+ 文案「排队中」。

二者色调（danger / neutral）、图标（alert / clock）、文案（生成失败 / 排队中）三项都不同；failed 与 retrying 的色调也不同（danger / warning）。
