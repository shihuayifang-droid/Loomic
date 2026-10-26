# 品牌词条表（Glossary）

> **唯一来源：`apps/web/src/lib/brand.ts`**
> 品牌名 / 标语在 `BRAND`，界面术语在 `GLOSSARY`。本文件是同一份内容的**成文对照表**，只用于查阅与评审，**不是第二份数据源** —— 不要从本文件复制文字回代码。
> 需求：BR-19「词条表：界面文案统一词条表，品牌名只在一处定义」。

## 怎么改（改这里一处，全站同步）

1. 打开 `apps/web/src/lib/brand.ts`，改 `BRAND`（品牌名 / 标语 / 描述）或 `GLOSSARY`（界面术语）里的**值**。字段名（`name` / `tagline` / `description` / 术语 key）是代码契约，改 key 要连带改所有引用处。
2. 界面上凡是引用 `BRAND.name` / `BRAND.tagline` / `glossary(key)` 的位置，**随一处改动自动跟上**，不需要逐文件查找。
3. 仍然写死字面量的文案（尚未收敛到词条的，属后续单）按本文件「中文写法」逐字替换成引用，不要手打字符串。
4. 改完跑 `pnpm --filter @loomic/web exec tsc --noEmit`（0 error）与 `apps/web` 下的 `pnpm run build`（成功）确认没有遗漏的引用。
5. 同步更新本文件的对照表，使两者文字继续逐字一致。

## 品牌词条

| 词条 key | 中文写法 | 英文写法 | 用在哪 | 禁止写法 |
|---|---|---|---|---|
| `BRAND.name` | HaHart | HaHart | 全站品牌名：侧栏标题 `<名> Agent`、页面标题、manifest、metadata | HaHart AI、HaHart 画布、HAHART、Hahart、haHart |
| `BRAND.tagline` | AI 创意画布 | —（无英文版本，勿自造） | 落地页与品牌介绍里的一句话定位 | AI 创意工坊、AI 设计画布、智能创意画布 |
| `BRAND.description` | HaHart · AI 创意画布 | —（同中文写法） | metadata 与 manifest 的站点描述（由 name · tagline 拼成，勿另行手写） | 任何与 `name · tagline` 不一致的拼接 |

## 界面术语

| 词条 key | 中文写法 | 英文写法 | 用在哪 | 禁止写法 |
|---|---|---|---|---|
| `GLOSSARY.canvas` | 画布 | Canvas | 画布页、画布对象提及标签、画布底栏（背景色等） | 画板、绘图区、白板、工作台、画布页 |
| `GLOSSARY.workspace` | 工作区 | Workspace | 工作区内的订阅相关提示语、路由分组 `(workspace)` | 空间、团队空间、组织、租户 |
| `GLOSSARY.project` | 项目 | Projects | 首页「最近项目」、项目库、新建 / 删除项目、侧栏导航 | 工程、作品、作品集、方案 |
| `GLOSSARY.credits` | 积分 | Credits | 定价页套餐额度、积分不足提示、已退回 N 积分、后台调积分 | 点数、额度、金币、代币、Credit |
| `GLOSSARY.agent` | Agent | Agent | 侧栏标题 `<名> Agent`、输入框旁的模型选择、设置页「Agent」分区、首页入口 | 智能体、助手、AI 助手、Agent 助手、机器人 |
| `GLOSSARY.asset` | 素材 | Assets | 提及标签、我的素材、团队成员转移提示 | 资源、文件、资产（指代同一样东西时） |
| `GLOSSARY.file` | 附件 | Attachments | 提及标签、对话里的附件与拖入提示 | 文件（与「附件」混用）、上传物 |
| `GLOSSARY.model` | 模型 | Models | 提及标签、模型切换与不稳定提示、模型偏好设置 | 引擎、算法、大模型、AI 模型（同一处混用） |
| `GLOSSARY.skill` | 技能 | Skills | 侧栏导航「Skills」、`/` 列表、技能创建对话框 | 能力、插件、工具、Skill |
| `GLOSSARY.conversation` | 对话 | Chat | 对话面板标题区、会话列表、拖入对话的提示 | 聊天、会话、消息、Chat 面板 |
| `GLOSSARY.brandKit` | 品牌套件 | Brand Kit | 侧栏导航、品牌套件编辑器、定价页套餐说明 | 品牌包、品牌库、品牌资产、BrandKit |
| `GLOSSARY.subscription` | 订阅 | Subscription | 订阅相关错误提示、定价与计费说明 | 会员、订购、付费方案（指代订阅关系时） |
| `GLOSSARY.generation` | 生成 | Generation | 生成面板与按钮、定价页积分说明、生成失败 / 退款提示 | 创作、出图（仅指图片时）、渲染、Gen |

## 维护约束

- 本文件的「中文写法」必须与 `apps/web/src/lib/brand.ts` 里的值**逐字一致**；两者不一致时以代码为准，并当场修正本文件。
- 新增术语：先在 `GLOSSARY` 加 key 与值，再加本文件一行，最后才在界面里用。
- 本文件不含密钥、token、内部地址、账号信息 —— 它是对外可评审的文案文档。
