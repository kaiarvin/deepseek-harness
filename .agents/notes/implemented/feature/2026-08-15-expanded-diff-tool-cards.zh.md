# Agent Note：edit/write 的展开式 diff 工具卡片

Status: implemented

[English](2026-08-15-expanded-diff-tool-cards.md) | 中文

## 问题

web 对话流通过出厂自带的 `file-mutation-toolview` 渲染 `edit`／`write` 工具调用，它在默认折叠的展开体内绘制已应用的 diff，且对话流里最多显示 8 行（`CHAT_DIFF_MAX_LINES`）。因此修改内容被藏在展开交互后面并被截断，读者无法一眼看到 agent 刚刚改了什么。

## 决定

新增一个纯客户端包 `@deepseek-ai/dsh-client-ui-diff-viewer`（`packages/client/ui-diff-viewer`），接管 `ui-tool` 的 keyed `tool.call.toolview` slot 中 `edit` 和 `write` 两个 key，把每次修改渲染为默认展开的彩色 diff 卡片。卡片由头部（修改动作标题、可点击路径、生命周期状态、查看详情入口、整卡收起开关）加上产品自带的 `DiffBlock` 原语构成——后者以错误／成功颜色绘制删除侧与新增侧，按自身高度上限折叠长正文，并提供复制与 `+A -R · N file(s)` 底部统计。

hunk 与生命周期只派生自冻结的工具调用／结果切片（已结算用 `block.resultView`，运行中用 `block.callView`——即工具的 `card: 'diff'` 渲染意图），绝不读取文件系统，因此回放跨窗口、跨会话保持稳定。注册一个出厂组合已覆盖的 key 会替换该占用者（keyed 孔位有文档记录的接管语义）；移除 bundle 即恢复出厂行。

卡片正文把新旧两侧按行对齐（有界 LCS），并在**每一行上绘制逐文件行号**：删除行显示旧行号，新增行显示新行号，上下文行两者都显示。真实文件坐标挂在 `FileDiff` 契约的可选字段 `oldStart`／`newStart`（1-based 的 hunk 起始行）上，`computeHunkDiffs` 现在从 `structuredPatch` 的 hunk 元数据填充；调用时视图与较早持久化的结果没有这些字段时，在 hunk 内从第 1 行编号。字段为可选，并在 `diffsFromMeta`（tool-fs）与客户端 `narrowDiffs` 中均做校验，因此旧数据退化为 hunk 内相对行号而非失败。

该行通过 `packages/bundle/web-app/cordis.patch.yml` 中的一次 insert 加上一个 workspace 依赖接入 web 表面，与其它 `dsh.client` 浏览器行一致。node 半边是空 `apply`；浏览器半边经由 `exports["./client"]` 提供，由 `dsh.client` 声明发现。

## 备选方案

- **保留出厂行，只提高行数上限**——不改变请求所针对的默认折叠呈现；接管的要点正在于此。
- **手写逐行对齐的 LCS diff 渲染器**——重复实现产品统一的 `DiffBlock` 表面（与详情面板和 TUI 共用）；复用才能保持视觉与交互一致。
- **发一个新的带 diff 的会话事件**——没有必要：hunk 已经随持久化的调用／结果视图存在；按"模型可见 ⟺ 已记录"规则，新增模型可见输入还需对应会话事件。

## 后果

- 默认 web 组合现在为文件修改显示展开的 diff；移除 bundle 后，出厂折叠行仍是回退。
- 不新增任何工具、事件或模型可见上下文；这是纯粹的客户端呈现表面。
- 仅含工具结果的 history 页（调用头落在运行时窗口外）仍回退到通用行，因为键控分派需要配对的调用。
- 独立源码镜像位于 `https://codeup.aliyun.com/5f27f6eddb0493ecef90b94a/ywy_sky/dsh-show-diff.git`。
