# apps/web 前端约定（CONVENTIONS.md）

> 需求条目：**X-05（testid 命名规范）**、**ED-00b（下拉一律 click 展开）**、**ED-00h（通用参数滑块）**
> 本文是这些约定的**唯一出处**。其它文档、工单、代码注释引用约定时，一律指回这里，不要再各自维护一份。
> 适用范围：`apps/web/**`（含 testid、ARIA、下拉交互三条）。

---

## 1. testid 命名（X-05）

### 1.1 骨架

```
{区域}-{组件}-{元素}[-{值}]
```

- **区域**：界面上的一块地方，取自产品或信息架构的名字，例如 `canvas`、`adjust`、`home`、`agent`。
- **组件**：这块地方里的具体控件，例如 `zoom-dropdown`、`slider`、`bottom-bar`。
- **元素**：控件内部的元素，例如 `trigger`、`menu`、`item`、`value`。
- **值**（可选）：同一类元素有多份时用来区分，取值用业务语义而不是下标，例如 `item-0.5`、`slider-exposure`。

四条硬规则：

1. **全部小写 kebab-case**，只用 `[a-z0-9-]` 与 `.`；其中**只有末段可以是带小数点的数字（如 `-0.5`），其余位置不得出现 `.`**。
   不用驼峰、不用下划线、不出现空格。
   - ✅ 末段是带小数点的数字或普通段：`canvas-zoom-dropdown-item-0.5`、`canvas-zoom-dropdown-item-1`。
   - ❌ `.` 出现在非末段，或末段的小数形态不完整：`canvas.zoom-item`、`canvas-zoom.dropdown-item`、
     `canvas-zoom-item-.5`、`canvas-zoom-item-0.`。
   - 这一条由 `test/testid-lint.test.ts` 强制（本次与工单 30D 一起改，两处说法必须一致）。
2. **段数从长到短**：区域 → 组件 → 元素 → 值。父子关系在 testid 里用连字符表达，不靠 `__` 之类的分隔符。
3. **参数化 testid 用规范名，不用下标**：`adjust-slider-exposure`，不要 `adjust-slider-0`。
   下标会随着配置顺序调整而失效，规范名不会。
4. **动态出现的元素也必须有 testid**：菜单、tooltip、Toast、条件渲染的按钮、后插入的行 —— 只要它可能在界面上出现，
   就得能被测试点到。不要用「文案断言」代替 testid。

### 1.2 状态不进 testid

**testid 不随状态改名**。同一个元素在开/关、选中/未选中、禁用/可用之间**始终是同一个 testid**，
状态用 `data-state`、`data-disabled`、`aria-*` 表达。

- ✅ `data-testid="canvas-zoom-dropdown"` + `aria-expanded="true|false"`
- ❌ `data-testid="canvas-zoom-dropdown-open"` / `canvas-zoom-dropdown-closed"`

理由：测试的写法是「先找元素，再断言状态」；testid 带状态会把同一元素拆成两个对象，
断言就退化成「找得到 `-open` 就算开」，一旦改名两边一起失效，测不出回归。

### 1.3 跨模式同名，模式差异用 `data-mode`

同一个元素在不同模式（工具）里**共用同一个 testid**，模式差异写在 `data-mode` 上：

```tsx
<div data-testid="adjust-slider" data-mode="multi-angle" />
<div data-testid="adjust-slider" data-mode="white-model" />
```

- ❌ 按模式各起一套名字：`multi-angle-slider` / `white-model-slider`。
  后果是「跨模式同名」这条约定失效，同一个组件在两种模式下要写两份测试，且改名时漏改一边不会被发现。
- 取值型 testid 同理：`{tool}` 只在 testid 里用来区分**同一模式内的不同参数**，
  不承担「模式」的身份 —— 模式的身份永远是 `data-mode`。

### 1.4 testid 与显示名语义一致

testid 里出现的词，必须和用户在界面上看到的这个名字对得上。
**界面改名了，testid 要一起改**；反之 testid 不许编码只有开发者知道的名字。

### 1.5 正例 / 反例

**正例两个：**

1. ✅ `canvas-zoom-dropdown` —— 区域 `canvas` + 组件 `zoom-dropdown`，段序从长到短，
   与界面上的缩放百分比按钮语义一致（1.1 / 1.4 都满足）。
2. ✅ `adjust-slider-exposure` —— 参数化写法，值用业务名 `exposure` 而不是下标 `0`；
   新增参数只加新 testid，已有的一条都不用改（1.1 第 3 条）。

**反例两个：**

1. ❌ `agent-image-generator-prompt` / `video-prompt-input` —— 同一条规则（1.3 跨模式同名）的两个触犯方式：
   - `agent-image-generator-prompt`：「组件」段写成了实现名 `image-generator`，于是生视频模式下只能另起
     `video-prompt-input` —— 同一个提示词输入框被拆成两套 testid，写测试要写两份，改名时漏改一边不会被发现。
   - `video-prompt-input`：只剩两段（缺「区域」段），段序也错了（模式名 `video` 顶到了最前）；
     模式差异本该写 `data-mode="video"`，却编码进了 testid。
2. ❌ `option-chat`（界面上显示为「Agent」）—— 违 1.4：testid 与显示名语义相反。
   照着 testid 找「chat」的人，在界面上找不到任何叫 chat 的东西；界面把「Agent」改名为「智能体」时，
   这个名字也不会被一起改。

---

## 2. ARIA 约定

### 2.1 下拉

- 触发器必须有 **`aria-haspopup="menu"`**，并把开合状态写在 **`aria-expanded`**（`true` / `false`）上。
- 菜单本体 `role="menu"`，菜单项 `role="menuitem"`（由 `ui/dropdown-menu.tsx` 的 Base UI Menu 提供）。
- 禁用项用 `aria-disabled` 表达，**不要**用 testid 或文案表达禁用。

### 2.2 滑块

四个属性各司其职：

| 属性 | 写什么 |
|---|---|
| `aria-valuenow` | **内部值**（滑块的数值域，例如 0~100） |
| `aria-valuemin` / `aria-valuemax` | 内部值域的上下限 |
| `aria-valuetext` | **显示值**（给用户看的那份，例如「广角」、`45°`） |

**显示值只进 `aria-valuetext`，不许覆盖 `aria-valuenow`**：档位/单位/百分号这类格式化信息一旦写进
`aria-valuenow`，读屏器读到的数就和滑块实际位置对不上了。

---

## 3. 交互约定：下拉一律 click 展开，hover 只出 tooltip（ED-00b）

> **这一条的唯一出处就是本节。** 后续任何「菜单要不要 hover 展开」的争论，都以本节为准。

1. **所有下拉/菜单一律 click 展开。** 任何组件都不得使用 hover 展开（不传 `openOnHover`，
   或者显式传 `openOnHover={false}`）。
2. **hover 只允许出 tooltip**，不允许因此展开菜单。触发器可以同时挂 tooltip 和菜单：
   hover 出 tooltip、click 才展开菜单。
3. 键盘等价路径必须存在：Enter / Space 打开，Esc 收起，点击外部收起。
4. 统一入口是 `components/ui/app-dropdown.tsx` 的 `AppDropdown`，不要在业务组件里直接拼
   `ui/dropdown-menu.tsx` —— 直接拼就绕过了本条的约束（`dropdown-menu.tsx` 本身不改，它已有三处在用）。

---

## 4. 用法示例

### 4.1 `ParamSlider`（ED-00h）

**新增一个参数只改配置，不改组件。** 组件里不许出现任何具体参数名（`exposure`、`zoom`…）。

```tsx
import { ParamSlider } from "@/components/ui/param-slider";
import type { ParamSliderConfig } from "@/lib/param-slider";

const ZOOM: ParamSliderConfig = {
  id: "zoom",                       // → testid 里的参数名
  label: "缩放",
  defaultValue: 0,                  // 内部值
  display: { kind: "steps", labels: ["特写", "中等", "广角"] },
};

const EXPOSURE: ParamSliderConfig = {
  id: "exposure",
  label: "曝光",
  defaultValue: 50,
  display: { kind: "linear", a: -45, k: 0.9, round: 0, unit: "°" }, // 显示值 = a + v × k
};

<ParamSlider
  tool="multi-angle"
  config={ZOOM}
  onChange={(internal, submit) => {
    // internal：内部值（0~100），写进 aria-valuenow
    // submit：显示值（steps → "广角"，linear → 取整后的数字），提交给后端用这个
  }}
/>;
```

- testid：`{tool}-slider-{config.id}`（例：`multi-angle-slider-zoom`）；显示值的 span 是
  `{tool}-slider-{config.id}-value`。
- 滑块本体（上面那个 testid）是**根节点**，`aria-valuenow/min/max/valuetext` 在它内部的原生
  `input[type=range]`（`role="slider"`）上：`within(screen.getByTestId("multi-angle-slider-zoom")).getByRole("slider")`。
- 双击滑块回到 `config.defaultValue`。
- 档位吸附由 `lib/param-slider.ts` 的 `snap()` 自己算，不依赖原语的 `step`
  （档位数不能整除 100 时 step 会变成小数，拖到一半就会漂移）。

### 4.2 `AppDropdown`（ED-00b）

```tsx
import { AppDropdown } from "@/components/ui/app-dropdown";

<AppDropdown
  testid="canvas-zoom-dropdown"
  label={`${Math.round(zoom * 100)}%`}
  tooltip="缩放预设"                       // 可选：hover 只出它，不展开菜单
  side="top"
  items={[
    { id: "0.5", label: "50%", onSelect: () => setZoom(0.5) },
    { id: "1", label: "100%", onSelect: () => setZoom(1) },
    {
      id: "fit-all",
      label: "Fit All",
      onSelect: () => fitAll(),
      separatorBefore: true,               // 在这一项前画分隔线
      disabled: true,
      disabledReason: "画布为空时不可用",   // disabled 的原因走 tooltip（X-P5）
    },
  ]}
/>;
```

- 触发器：`{testid}`；开合状态走 `aria-expanded`，`aria-haspopup="menu"`。
- 菜单：`{testid}-menu`；菜单项：`{testid}-item-{itemId}`。
- 禁用项的原因：`{testid}-item-{itemId}-reason`（只有带 `disabledReason` 的项才挂 tooltip）。

---

## 5. 改动本文的规矩

本文不是建议清单。要改某条约定，先改本文件，再改代码 —— 顺序反了就会出现「代码里一套、文档里一套」。
新组件的 testid 一律照第 1 节起名，第一批样本是 `ParamSlider` 与 `AppDropdown`（工单 30A）。

---

## 6. 已落地的区域前缀表（工单 30C）

> 这张表是 `test/testid-lint.test.ts` 的数据源：测试会解析本节表格，任何 testid 的第一段
> 都要能在这里找到对应的区域。新增一块界面时**先在这里加一行**，再写 testid。

| 前缀 | 区域 |
|---|---|
| `account-` | 账号与计费（登录、注册、个人资料、套餐升级、取消订阅） |
| `agent-` | Agent 相关的选择与偏好（模型选择、默认模型、模型偏好弹层） |
| `app-` | 应用外壳（侧边栏、错误兜底页） |
| `attachment-` | 附件条（附件的移除） |
| `brand-kit-` | 品牌资料（侧边栏、编辑器、色板、字体、logo、素材卡） |
| `canvas-` | 画布（工具菜单、底部栏、图层与文件面板、图像/视频生成面板、视频播放器、图片选择器） |
| `chat-` | 对话（消息块、思考块、工具块、会话选择器、技能快捷、图片灯箱） |
| `credits-` | 积分（余额、头部入口、用量历史、不足弹窗、限额提示） |
| `home-` | 首页（提示词框、发现画廊、示例浏览器、项目卡片） |
| `image-` | 逐图工具条（工具条、分隔线、tooltip、「更多」菜单与菜单项） |
| `landing-` | 落地页（浮动导航、价格预览） |
| `price-` | 价格展示（PriceTag 五态文案与获取失败重试） |
| `pricing-` | 价格页（套餐卡片、对比表、常见问题、月付与年付切换） |
| `project-` | 单个项目的详情控件（项目名编辑） |
| `projects-` | 项目列表与项目弹窗（新建、删除、重试） |
| `settings-` | 设置页（分区导航、返回、各分区表单） |
| `skills-` | 技能（列表页、技能卡、创建/导入/市场/详情弹窗） |
| `toast-` | 全局 toast（toast 本体与入口按钮） |
| `ui-` | 设计系统原语（`components/ui/` 里的对话框关闭按钮等） |

**带值的 testid 怎么取值**（测试只校验形态，取值是评审要看的部分）：

1. 优先用业务键，例如 `skills-card-{slug}`、`pricing-card-{tier.id}-cta`、`skills-tab-{tab}`。
2. 业务键里出现 testid 不允许的字符（`:`、`/`、空格）时，在表达式里用 `-` 替换：
   `` data-testid={`canvas-image-generator-ratio-item-${r.replace(/:/g, "-")}`} ``。
3. 业务键是运行时随机 id（Excalidraw 元素 id、上传资产 id），或者只有中文显示名可用时，
   **整列共用一个不带值的 testid**（例如 `canvas-layers-panel-item`），E2E 用
   `getAllByTestId` 按文档顺序取 —— 这比把随机 id 拼进 testid 更稳定，也不违反「不用下标」。

**调用方前缀（装饰值）**：接收 `testid` prop 的原语（`ui/app-dropdown.tsx`、`ui/param-slider.tsx`）
自己写的是 `${testid}-menu` 这类「后缀装饰」，静态看第一段是 `${...}`。测试把 `${...}` 换成 `x`
之后，以 `x-` 开头的值视为「前缀由调用方给」，只校验后缀形态，不查本节表格；
真正的调用点传的是字面量（例如 `canvas-zoom-dropdown`），仍然受本节约束。
