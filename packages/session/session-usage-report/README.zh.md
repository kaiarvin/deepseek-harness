# @deepseek-ai/dsh-session-usage-report

[English](README.md) | 中文

跨会话 token 用量统计服务（`ctx.sessionUsage`）：把每个逻辑会话的持久日志（优先活动会话，其次通过已挂载的持久化后端读取持久会话）折叠成按本地日 × 模型的计费 token 汇总。折叠通过 `ctx.sessionQuery` 的精确读取（而非搜索索引）逐个读取会话，因此任何挂载了查询接缝的 profile 都能使用本报告。

## 提供的内容

`ctx.sessionUsage.report({ timezoneOffsetMinutes? })` 返回一份独立快照：

- `days` — 本地日分桶，从旧到新；每个分桶含 `dayStartMs`（本地日零点的 UTC 毫秒时间戳）、去重会话数、当日 token 汇总，以及按模型的明细行（`provider`、`model`、`calls`、`sessions`、`tokens`）。
- `timezoneOffsetMinutes` — 调用方请求的时区偏移，原样回显。

`dayStartMs` 用调用方的 locale 渲染即得到该查看者的日历日期。调用方传入浏览器的 `Date.getTimezoneOffset()`，使日边界与查看者的墙钟一致。

token 分桶使用互斥的 provider 字段：未缓存 `input`、`output`、`cacheRead`、`cacheWrite`。只有携带 provider `usage` 的 `assistant/message` 事件会计入；每条样本归属到它之前最近的 `request/header`（provider/model），因此会话中途切换模型也能正确拆分。

## 行为

- 报告按请求的时区缓存，并带 stale-while-revalidate 窗口：任何 `session/event` 都会将其标记为脏，但脏缓存仍会在 30 秒内继续对外服务，同时后台重新扫描刷新它——因此快速连续打开对话框不会每次都付出完整的语料库折叠成本。仅当缓存冷，或脏状态超过窗口期时，报告调用才会同步重新扫描（插件的 `freshMs` 配置可调整窗口）。
- 新扫描结果会持久化到磁盘（`~/.dsh/usage-report/usage-report-<tz>.json`，原子临时文件替换，写失败自动忽略）：进程重启后在磁盘新鲜窗口内（默认 1 小时，`diskFreshMs` 配置可调）会直接复用上次扫描，而不是在首次冷打开时付出完整的语料库折叠成本。版本不匹配或无法读取的缓存文件会被丢弃，代价只是一次重新扫描。
- 单个会话或读取失败会被跳过并记录警告——一条损坏日志不会阻塞其余报告。
- 未挂载 `ctx.sessionQuery`（或没有任何活动/持久会话）的组合返回空 `days` 列表。

## 组合

```yaml
- name: '@deepseek-ai/dsh-session-query-sqlite'
- name: '@deepseek-ai/dsh-session-usage-report'
```

本服务没有配置项。Web 用量对话框（`@deepseek-ai/dsh-client-ui-usage-report`）通过 apiproxy 的 `usage.report` RPC 消费同一份折叠结果。

## 模型体验

间接地，通过 Web 用量对话框；本服务本身不添加任何提示词、消息、schema、工具或模型调用。
