# HaHart CI 流水线（OP-12）

流水线定义：仓库根 `Jenkinsfile`（声明式 pipeline）。
运行环境：`.37` 服务器上现有的 Jenkins，节点 label `any`。
本文件说明它跑什么、为什么这么跑、以及怎么在 Jenkins 里把它建起来。

---

## 1. 流水线跑什么

| # | Stage | 命令（逐字，与工单一致） |
|---|---|---|
| 1 | Build shared | `pnpm --filter @loomic/shared build` |
| 2 | Typecheck | `pnpm --filter @loomic/server typecheck` **且** `pnpm --filter @loomic/web exec tsc --noEmit` |
| 3 | Unit tests | `pnpm --filter @loomic/server test` |
| 4 | Invariants | `node scripts/check-invariants.mjs --allow-skips` |
| 5 | Web build + E2E | `pnpm --filter @loomic/web build` → `pnpm --filter @loomic/web e2e` |

全局设置：
- `options { timestamps(); disableConcurrentBuilds(); timeout(time: 45, unit: 'MINUTES') }`
- `environment`：`CI=true`、`NEXT_PUBLIC_HAHART_AUTH_PROVIDER=self`、`NEXT_PUBLIC_SERVER_BASE_URL=http://127.0.0.1:3001`
- `post { always { ... } }` 只打印 `job / build / result` 三件事，不放任何凭据。

### 每步对应哪个需求

| Stage | 对应需求项 | 说明 |
|---|---|---|
| Build shared | OP-12（流水线基础设施） | 其它包消费 `@loomic/shared/dist`，必须先构建，否则后面的 typecheck / build 直接炸 |
| Typecheck | **OP-12** | 这一步就是验收抓手：往任意 `.ts` 里提交一个故意写的类型错误，Typecheck stage 必须失败、流水线变红 |
| Unit tests | OP-12（后端基线） | 只跑 server 套件；`vitest.config.ts` 里已排除需要真实 DB 的套件（本机实测：185 文件 / 2658 用例全过） |
| Invariants | **QA-03** | 不变式脚本集；任一 `TOTAL FAILURES ≠ 0` 时脚本非 0 退出 → stage 失败 → 阻止继续部署（本机实测 `TOTAL CHECKS: 9`，其中 2 项因缺变量 SKIP） |
| Web build + E2E | **QA-02 / QA-12** | Playwright + msedge，覆盖 H5 端关键流程 |

---

## 2. 为什么 invariants 必须带 `--allow-skips`（T-163）

`scripts/check-invariants.mjs` 默认把「缺变量、无法执行」的不变式算成 **FAIL**（脚本头部注释写明：跳过项不算绿）。

但本部署里有两个**旧的 Supabase 校验脚本**永远拿不到所需的环境变量，它们在这个部署形态下无法判定。
不加 `--allow-skips` 的话：

- 每次构建这两个项都被记成 FAIL；
- `TOTAL FAILURES ≠ 0` → 退出码非 0 → 流水线**永远红**；
- 恒红的门禁等于没有门禁（没人再看它），比暂时降级更糟。

所以这里显式用 `--allow-skips`：不可执行项记为 `SKIP`、不计入 failures，**能执行的项仍然是硬门禁**。
对应事项号 **T-163**（清掉这两个旧脚本 / 补上它们需要的变量后，应去掉 `--allow-skips`，把门禁恢复成严格模式）。

> `Jenkinsfile` 的 `Invariants` stage 里也有同样理由的注释，防止后人「顺手把 flag 删掉」。

---

## 3. 为什么 `pnpm --filter @loomic/web test` 暂时**没有**进流水线

它现在是红的（既有缺陷，不是 CI 配置问题），红项包括：

- `chat-sidebar` 相关用例：缺少 `TierLimitToastProvider`
- `home-discovery-gallery` 相关用例：组件 props / 种子数据字段不匹配
- `projects` 相关用例：缺少 `ToastProvider`

把这些红项塞进 CI 的直接后果和 T-163 一样：**流水线恒红**，而且红的是与当次提交无关的旧债，
所有人都会开始忽略 CI 信号。

**债务与计划**：

1. 先把上面三处红项清零（补 provider 包裹 / 对齐字段），保证 `pnpm --filter @loomic/web test` 本地全绿；
2. 绿了之后，在 `Jenkinsfile` 的 `Unit tests` stage 里比照 server 加上
   `pnpm --filter @loomic/web test`，并把这条债从 `deploy/CI.md` 移除；
3. 在它进流水线之前，前端回归靠 `Typecheck` + `Web build + E2E` 兜（管住类型和关键链路，但不管组件单测）。

---

## 4. CI 不产生真实扣费

- **E2E 全 mock**：Playwright 跑的是 mock provider 路径，不调真实图像 / 文本 provider，不打真实账号。
- **Unit tests 不连外部**：server 套件排除了需要真实 DB 的用例；web 套件（进流水线后）同样只跑内存内组件逻辑。
- **Invariants 只读**：`scripts/check-invariants.mjs` 只读取仓库文件与配置做校验，不发起外部写操作。
- **将来的约束**：若之后要在流水线里加任何真实 provider 调用，**必须**走 mock 开关
  `HAHART_IMAGE_PROVIDER_MOCK`（在 CI environment 里设成开启），否则视为「CI 产生真实扣费」的回归。

---

## 5. 在 `.37` 的 Jenkins 里建这个 job

1. 在 `.37` 上确认 Jenkins 已有可用的 `any` 标签节点（现有节点即可，本流水线不指定特殊 agent）。
2. 该节点上需要预先具备：`node`、`pnpm`（版本与仓库 `package.json` 的 engines 对齐）、
   已安装 Playwright 需要的 msedge 浏览器（`pnpm --filter @loomic/web e2e` 依赖它）。
3. Jenkins → **新建 Item** → 类型选 **Pipeline**（或 MultiBranch Pipeline，取决于该 Jenkins 的既有习惯）。
4. 配置 → **Pipeline** 区：
   - Definition：**Pipeline script from SCM**
   - SCM：指向本仓库（`Loomic`）
   - Branch Specifier：`hahart/p0`（或按该 Jenkins 现有的分支策略）
   - **Script Path：`Jenkinsfile`**（即仓库根的这份文件）
5. 保存，先手动 **Build Now** 跑一次，确认五个 stage 依次变绿。
6. 验收「故意引入 typecheck 错误 → 流水线失败」：
   在仓库里随便挑一个 `.ts` 加一行类型错误（例如把某个 `number` 赋成字符串），推一次构建
   → 预期 `Typecheck` stage 红、后续 stage 不再执行；验证完**把该错误撤销并重新推一次**，确认恢复绿。

> 注意：本流水线不写死任何绝对路径（没有 `/mnt/c/...` 之类），全部用仓库相对路径，
> 所以换一台节点不用改 `Jenkinsfile`。
