# Agent Note：新会话流程中的独立（无工作区）会话选项

Status: implemented

[English](2026-08-15-standalone-session-option.md) | 中文

## 问题

Web GUI 里的每个新会话最终都会落在某个 Workspace：Hero 的 Workspace 选择器列出真实 Workspace 与**添加工作区…**，而列表为空时锚点手势会直接跳进添加流程。有些工作根本不需要文件夹——一个不带任何项目记账的独立会话——但界面没有入口。后端其实早就支持（`session.create` 允许既不传 `workspaceId` 也不传 `cwd`，回落到 Host 默认 cwd，会话不带记账、显示在未分组下），但客户端既没有入口，更糟的是把任何空白的未分组会话当成未完成的挑选：Hero 渲染「选择工作区」chip 和只读编辑器。

## 决策

一个 owner 动作、一个运行时动词、一个菜单入口：

- **`WorkspaceRuntime.connectStandalone()`**（同时放宽 `IWorkspaces` 与 `SessionsPort.create` 面到可选的 `workspaceId`）：复用第一个未计入任何 Workspace 的空白会话——松散的空白会话本质上就是独立会话桩——否则 `sessions.create({})`（不带 Workspace、不带 cwd，落在 Host 默认 cwd）。已归档的空白会话永不复用（没有任何分组视图能展示它）；并发调用合并为同一个进行中的 create，因为该路径在菜单上没有 busy 臂。`TestWorkspaces` 双实现覆盖放宽后的面（记录 + 可 stub）。
- **`ConversationInjected.startStandalone()`**（ui-conversation）：`connectStandalone()` 后打开该会话，并按 Workspace 切换的同样方式携带当前空白会话的草稿／图片（草稿搬运逻辑抽取为共享的 `carryDraft` 辅助函数）。失败仅作为非致命的控制台诊断，与 `startSession` 的姿态一致。ConversationRoot 以 `EmptyWorkspaceOwnerProps.onStandalone` 传入 hero slot。
- **Workspace 选择器菜单入口**（ui-workspace）：hero 流程在菜单 footer 的**添加工作区…**旁固定**不在项目中工作 / Work without a project**（没有 Workspace 时则在条目列表中）。入口由 owner 提供（共享 `WorkspacePickFlow` 上的 `onStandalone?`），因此侧边栏只用于添加的流程不包含该入口并保留自动打开添加的行为；存在独立会话选项时，菜单是真正的选择，绝不自动打开添加流程，且 hero 菜单永远不会为空（「完全无浮层」的情况现在只存在于没有该选项的界面）。
- **Hero chip**：没有所属 Workspace 的会话（独立会话，或所属工作区被删除的会话）现在把 chip 标注为**未分组 / Ungrouped**，而不是「选择工作区」占位；空白未分组会话可直接使用——只读的惰性姿态现在只存在于尚未选择任何会话时，因此 composer block 对未分组会话与其他会话一样生效。

## 备选方案

**让未分组桶的侧边栏 ＋ 生效。** 否决：该行的 ＋ 被显式测试记录为惰性（未分组桶没有对应的 Workspace 卡片）；该功能属于新会话的选择点，而不是浏览列表。

**区分「主动独立」与「工作区被删除」。** 否决：两者是同一个持久事实（无 Workspace 记账），客户端没有任何字段可以区分；把所有未分组会话都当作可用会话是自洽的规则，也顺带修好了工作区被删除后编辑器失活的场景。

## 影响

每个 hero 界面的新会话流程都多了一条无项目退路；`connectStandalone` 是 workspaces 面新增的一个方法（面若再放宽，`TestWorkspaces` 双实现会在编译期报错）。未分组会话的 chip 从占位符改为真实标签，`skeleton.client.spec.tsx` 中的无工作区姿态测试随之更新。无需任何宿主改动——后端本就接受空 create 载荷。
