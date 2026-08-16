# Agent Note：跨会话 token 用量统计与 Web 用量对话框

Status: implemented

[English](2026-08-15-cross-session-usage-report.md) | 中文

## 问题

token 计量（`dsh-token-meter`）此前仅限单会话：三个会话投影服务当前会话的计费与占用，没有任何跨逻辑语料库的聚合。因此"我每天用了多少 token、哪些模型占大头"这类自然的产品问题，Web GUI 无法回答。

## 决策

两个新包加一个网关 RPC：

- **`@deepseek-ai/dsh-session-usage-report`** — 聚合服务（`ctx.sessionUsage.report({ timezoneOffsetMinutes? })`）。通过 `ctx.sessionQuery` 精确读取（优先活动会话，持久会话经已挂载后端；绝不使用搜索索引）枚举语料库，并逐个折叠会话的原始日志：归属遵循最近的前置 `request/header`（provider/model），只有携带 provider `usage` 的 `assistant/message` 事件会计入，事件落入查看者的本地日分桶（调用方传入 `Date.getTimezoneOffset()`；`dayStartMs` 是本地零点的 UTC 毫秒时间戳，用调用方的 locale 渲染）。token 使用互斥的 provider 分桶（未缓存输入、输出、缓存读、缓存写）。报告按请求的时区缓存，任何 `session/event` 都会使其失效；单个失败的会话会被跳过并记录警告，一条损坏日志不会阻塞其余部分。
- **apiproxy 网关的 `usage.report`** — 一个一元 RPC：`api/usage.ts`（契约）、`api/usage.schema.ts`（zod）、`rpc-map` 行、`fetch/handler.ts` 路由、`IApiClient` 方法，以及 fixture/dispatch 面。宿主 handler 委托给可选的 `ctx.get('sessionUsage')` 服务，未挂载时返回 `usage-unavailable`。
- **`@deepseek-ai/dsh-client-ui-usage-report`** — Web 表面：侧边栏底部设置旁的图标（`sidebar.footer.action`）打开一个对话框，含汇总条（计费 token 总量、天数、会话数）、模型占比（每个模型的计费总量与占比条，按降序）以及按天行（本地日期、当日总量、各模型的输入/输出/调用数/会话数）。范围选择器把报告截取到最近 7 天或最近 30 天（默认 30）——窗口外的天数一律不计、不显示、也不进热力图，因此很久之前的用量不会污染汇总。对话框是一次性 RPC 读取，自带加载/空态/错误座位；文案支持中英文。

两个包都在默认组合中发布：`session-usage-report` 在 base bundle（token-meter 旁），`ui-usage-report` 在 web-app bundle（ui-settings-general 旁）。客户端类型从线契约派生（`ResponseValue<'usage.report'>`），经 `dsh-api-remotes/client` 引入——客户端 bundle 无宿主依赖。

## 备选方案

**客户端用 `session.list` + `session.history` 自行聚合。** 已拒绝：每次打开都要经分页 wire API 重拉全部会话历史，语料库折叠属于日志侧，不属于浏览器。

**做一个会话投影键。** 已拒绝：投影是每会话的；跨语料库的 root 作用域键需要新的投影基础设施，并且仍然需要本服务已拥有的语料库枚举。

**用精确分词器重计价而非 provider usage。** 已拒绝：provider usage 已在日志中；启发式只适用于没有 usage 的地方，且报告刻意不重复计费（reasoning 是输出的细分，不是独立分桶）。

## 影响

部署无需配置即可获得 Web 用量对话框；未挂载 `session-usage-report` 时，对话框显示错误座位，其余 RPC 不受影响。报告是持久语料库上的快照：只反映已提交的事件，`session/event` 使缓存失效后更新；事件之间的崩溃只会使缓存报告过期，绝不会损坏它。按天分桶按设计依赖查看者时区（UI 传本地偏移），因此不同时区的查看者看到各自的天；UTC 调用方传 `0`。客户端的范围选择器（7/30 天）只收窄聚合与渲染范围，wire 仍携带完整报告，对话框只呈现最近窗口——无需宿主侧保留策略，旧活动就不会进入汇总。
