# 快捷键全表（apps/web）

> **改这里要同步 spec**：本表与 `apps/web/e2e/shortcuts.spec.ts` 一一对应。
> 新增 / 修改 / 删除一个快捷键时，两处一起改；只改一处视为漏改。
>
> 盘点口径：`apps/web/src` 里所有**已注册的键盘处理**（`addEventListener("keydown")`、
> `onKeyDown`、`e.key ===`、`metaKey` / `ctrlKey` / `shiftKey` 判断）。行号取自
> 本轮执行时的源码，只做定位用。

## 1. 画布级（全局监听）

| 组合键 | 作用 | 作用域 | 代码位置 |
|---|---|---|---|
| `C` | 打开对话面板 | 画布**无元素**时挂在 `window` 上；焦点在输入框 / contenteditable 上时不触发 | `components/canvas-empty-hint.tsx:51` |

## 2. 对话输入框 / 选择列表

| 组合键 | 作用 | 作用域 | 代码位置 |
|---|---|---|---|
| `Enter` | 发送消息 | 对话输入框；`Shift` 按下或输入法组字中不发送 | `components/chat-composer.tsx:259` |
| `Shift+Enter` | 换行（不发送） | 对话输入框 | `components/chat-composer.tsx:259` |
| `Backspace` / `Delete` | 删除光标前 / 后的引用胶囊 | 对话输入框，仅当光标紧邻胶囊 | `components/chat-composer.tsx:270` |
| `Escape` | 关闭 `/` 技能列表与 `@` 引用列表（捕获阶段记录 dismissed） | 对话输入框外层 | `components/chat-input.tsx:210` |
| `ArrowDown` / `ArrowUp` | 高亮项循环下移 / 上移（首尾回卷） | `@` / `/` 列表打开时，捕获阶段独占 | `components/canvas-image-picker.tsx:168` / `:172` |
| `Enter` | 插入当前高亮项 | 同上 | `components/canvas-image-picker.tsx:176` |
| `Escape` | 关闭列表，已输入文本保留 | 同上 | `components/canvas-image-picker.tsx:163` |

## 3. 对话面板

| 组合键 | 作用 | 作用域 | 代码位置 |
|---|---|---|---|
| `ArrowLeft` | 面板宽度 +20px（上限 600） | 桌面端分隔条聚焦时 | `components/chat-sidebar.tsx:261` |
| `ArrowRight` | 面板宽度 -20px（下限 300） | 桌面端分隔条聚焦时 | `components/chat-sidebar.tsx:264` |

## 4. 画布编辑

| 组合键 | 作用 | 作用域 | 代码位置 |
|---|---|---|---|
| `Tab` | 打开单图快速编辑面板（**焦点陷阱式的命令键，会 preventDefault**） | 画布上恰好选中 1 张图、焦点不在 input/textarea/contenteditable 上 | `components/canvas/image-toolbar-layer.tsx:677` |
| `Escape` | 关闭快速编辑面板 | 快速编辑面板内 | `components/canvas/quick-edit-panel.tsx:114` |
| `Escape` | 退出翻转 / 旋转模式 | 翻转旋转条 | `components/canvas/flip-rotate-bar.tsx:112` |
| `Enter` | 提交角度输入 | 角度输入框 | `components/canvas/flip-rotate-bar.tsx:151` |
| `Escape` | 关闭底部工具条 | 底部工具条 | `components/canvas-bottom-bar.tsx:62` |
| `Enter` | 提交十六进制颜色输入 | 颜色输入框 | `components/canvas-bottom-bar.tsx:290` |
| `Escape` | 关闭图层面板 | 图层面板 | `components/canvas-layers-panel.tsx:212` |
| `Escape` | 关闭文件面板 | 文件面板 | `components/canvas-files-panel.tsx:129` |
| `Escape` | 关闭视频播放面板 | 视频播放面板 | `components/canvas/video-player-panel.tsx:54` |

## 5. 生成面板与通用弹层

| 组合键 | 作用 | 作用域 | 代码位置 |
|---|---|---|---|
| `Enter` | 提交提示词（`Shift+Enter` 换行） | 图片 / 视频生成面板输入框 | `components/canvas/image-generator-panel.tsx:802`、`components/canvas/video-generator-panel.tsx:821` |
| `Escape` | 关闭工具块面板 | 工具块面板 | `components/chat/tool-block-view.tsx:540` |
| `Escape` | 关闭代理模型下拉 | `agent-model-selector` | `components/agent-model-selector.tsx:80` |
| `Escape` | 关闭图片模型偏好弹层 | `image-model-preference` | `components/image-model-preference.tsx:77` |
| `Escape` | 关闭积分余额弹层 | `credit-balance` | `components/credits/credit-balance.tsx:76` |
| `Escape` | 关闭积分头部按钮弹层 | `credit-header-button` | `components/credits/credit-header-button.tsx:46` |

## 6. 图片灯箱

| 组合键 | 作用 | 作用域 | 代码位置 |
|---|---|---|---|
| `Escape` | 关闭灯箱 | 灯箱打开时 | `components/chat/image-lightbox.tsx:118` |
| `+` / `=` | 放大 | 同上 | `components/chat/image-lightbox.tsx:119` |
| `-` | 缩小 | 同上 | `components/chat/image-lightbox.tsx:120` |
| `r` | 顺时针旋转 | 同上 | `components/chat/image-lightbox.tsx:121` |
| `Enter` / `Space` | 激活灯箱缩略图 | 灯箱内缩略图聚焦时 | `components/chat/image-lightbox.tsx:374` |

## 7. 表单 / 列表条目

| 组合键 | 作用 | 作用域 | 代码位置 |
|---|---|---|---|
| `Enter` | 保存 | 品牌套件内联输入 | `components/brand-kit/inline-input.tsx:41` |
| `Escape` | 取消 | 品牌套件内联输入 | `components/brand-kit/inline-input.tsx:43` |
| `Enter` | 保存项目名 | 可编辑项目名 | `components/editable-project-name.tsx:53` |
| `Escape` | 取消改名 | 可编辑项目名 | `components/editable-project-name.tsx:56` |
| `Enter` | 提交导入 URL | 技能导入面板 | `components/skills/import-panel.tsx:99` |
| `Enter` / `Space` | 激活条目（等价点击） | 项目列表 / 会话选择 / 品牌套件侧栏 | `components/project-list.tsx:44`、`components/session-selector.tsx:174`、`components/brand-kit/brand-kit-sidebar.tsx:56` |

## 8. Excalidraw 自带快捷键（库提供，不在本仓库源码里）

| 组合键 | 作用 | 作用域 |
|---|---|---|
| `Ctrl+Z` / `Ctrl+Shift+Z` | 撤销 / 重做 | 画布焦点内，由 Excalidraw 历史栈处理 |
| `V` / `R` / `D` / `O` / `A` / `L` / `P` / `T` / `E` / `H` | 选择 / 矩形 / 菱形 / 椭圆 / 箭头 / 线 / 自由绘制 / 文本 / 橡皮 / 抓手 | 画布焦点内 |
| `Ctrl+A` / `Delete` / `Ctrl+D` | 全选 / 删除选中 / 复制选中 | 画布焦点内 |

`components/canvas-logo-menu.tsx:44` 有一个 `dispatchKeyToExcalidraw`：菜单里的「撤销 / 重做」
按钮是**向 Excalidraw 补发一个合成的 `Ctrl+Z` / `Ctrl+Shift+Z` keydown**，不是另一个新组合键。

## 9. 本表里 mock 环境下无法断言的部分

`apps/web/e2e/shortcuts.spec.ts` 用 `test.fixme` 逐条标注了原因，不静默跳过：
`C`（需要空画布，mock 覆盖 canvas 内容会让页面客户端初始化抛异常）、`Backspace`/`Delete`
删胶囊（光标必须紧贴胶囊右缘，纯键盘摆不出该位置）、撤销/重做（Excalidraw 内部历史）、
图片灯箱（需要历史消息里的图片）、`Tab` 快速编辑（需要选中画布元素）、以及面板类
`Escape` / 生成面板 `Enter`（面板本身在纯 mock 下不可达）。
