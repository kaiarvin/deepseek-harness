# @deepseek-ai/dsh-session-usage-report

[English](README.md) | 中文

跨会话 token 用量统计服务（`ctx.sessionUsage`）：一份增量用量账本。每条携带 provider `usage` 的 `assistant/message` 在追加到活动会话的那一刻就落成一条样本（墙钟时间、provider、model、会话、计费 token）——打开时不进行任何折叠。样本会持久化到磁盘（防抖写入、原子临时文件替换）并在服务启动时加载，因此报告调用只需按查看者的本地日对内存样本分桶即可瞬时返回，全程零语料读取。

当首次启动且没有已持久化的样本时，服务会通过 `ctx.sessionQuery` 的精确读取（而非搜索索引）对会话语料做一次性回填；此后聚合完全由事件驱动。

## 提供的内容

`ctx.sessionUsage.report({ timezoneOffsetMinutes? })` 返回一份独立快照：

- `days` — 本地日分桶，从旧到新；每个分桶含 `dayStartMs`（本地日零点的 UTC 毫秒时间戳）、去重会话数、当日 token 汇总，以及按模型的明细行（`provider`、`model`、`calls`、`sessions`、`tokens`）。
- `timezoneOffsetMinutes` — 调用方请求的时区偏移，原样回显。

`dayStartMs` 用调用方的 locale 渲染即得到该查看者的日历日期。调用方传入浏览器的 `Date.getTimezoneOffset()`，使日边界与查看者的墙钟一致。

token 分桶使用互斥的 provider 字段：未缓存 `input`、`output`、`cacheRead`、`cacheWrite`。只有携带 provider `usage` 的 `assistant/message` 事件会计入；每条样本归属到它之前最近的 `request/header`（provider/model），因此会话中途切换模型也能正确拆分。

## 行为

- 实时聚合：携带 `assistant/message` 用量的 `session/event` 会立即更新账本，`request/header` 事件则更新每个会话的归属。每次调用报告都反映最新样本——没有陈旧窗口，没有重新扫描。
- 持久化：样本在短暂防抖后写入 `~/.dsh/usage-report/usage-report-samples.json`（原子临时文件替换，写失败自动忽略），并在销毁时冲刷。重启后直接加载该文件，不再扫描语料。
- 一次性回填：当没有样本文件时，服务会对完整语料折叠一次（通过 `ctx.sessionQuery` 逐个读取会话）以填充账本；单独失败的会话或读取会被跳过并记录警告。回填与实时流按序号对账，回填已计入的事件绝不会被实时火线重复计入。
- 保留期：早于 `retentionDays`（默认 40）的样本会在加载与写入时被裁剪；Web 对话框最多展示 30 天。
- 重放安全：`session/event` 只在实时追加时触发（构造种子——重放、fork、恢复——从不发布），因此重启绝不会重复计数。
- 未挂载 `ctx.sessionQuery`（或没有任何会话）的组合在实时样本到达前返回空 `days` 列表。

## 组合

```yaml
- name: '@deepseek-ai/dsh-session-query-sqlite'
- name: '@deepseek-ai/dsh-session-usage-report'
```

配置均为可选：`cacheDir`（默认 DSH 主目录下的 `usage-report` 目录）、`retentionDays`（默认 40）与 `persistDelayMs`（默认 1000）。Web 用量对话框（`@deepseek-ai/dsh-client-ui-usage-report`）通过 apiproxy 的 `usage.report` RPC 消费同一份报告。

## 模型体验

间接地，通过 Web 用量对话框；本服务本身不添加任何提示词、消息、schema、工具或模型调用。

#### KV Cache effect

无；本服务只读取会话日志并为每条带用量的消息写入一个本地样本文件，不产生提示侧或 KV 缓存 token 影响。

## 已知限制与后续工作

- 账本按用量发生时间计数：压缩或删除会话不会追溯移除其已计入的用量（用量报告是账本，不是当前日志的投影）。
- 早于保留期的样本会被裁剪，因此只保留最近 `retentionDays`（默认 40）天——与对话框的 30 天范围一致。
- 升级后的首次启动会一次性回填完整语料；语料较大时这一次扫描可能需要数十秒（升级前的报告每次打开都付出同样的成本）。
