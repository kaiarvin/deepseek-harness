# dsh-file-drop-inbox

DSH web 插件：把非图片文件（日志、配置文件等）拖进窗口，保存到当前会话工作区的 `.dsh/inbox/`，并在输入框里插入**只显示文件名**的引用 chip（点击 chip 即可在宿主机器上直接打开该文件）。发送时 chip 序列化为 markdown 超链 `[文件名](<绝对路径>)`——消息气泡把该链接渲染为**可点击的文件链接**（点击即在宿主机器上打开文档，与「产物文件」的打开行为一致），模型也能从链接目标解析路径直接 `read` 文件，不需要等官方的通用附件功能。

图片（PNG/JPG/WebP/GIF）不受影响：纯图片拖放仍走内置图片 intake（附件栏 + 宿主限制）；混合拖放时图片继续进附件栏，非图片进 inbox。

## 工作原理

- **host 半**（`lib/index.js`）：挂一条 fenced 路由 `POST /inbox/upload`。请求带 `sessionId`、`cwd`（尽力而为）、`name`、`data`（base64），以及**当前消息草稿的去重上下文**（`draftNames`：草稿里已有 chip 的文件名；`batchNames`：本次拖入批次里已上传的文件名）。以会话 cwd 为准（session header 优先），写入 `<cwd>/.dsh/inbox/<name>`；同名去重**只按当前消息计数**——草稿里已有同名 chip（或同一次拖入多个同名文件）才加 `-1`/`-2` 后缀（在扩展名之前），新消息（草稿为空）第一次拖入总是回到裸文件名，历史对话/磁盘上已有的同名文件一律不计数。写盘用 tmp + rename，路径校验保证不逃出会话 cwd。路由带与 `/api` 网关一致的浏览器信任围栏（loopback / `webRuntime.trustedHosts`，拒绝 cross-site）。
- **client 半**（`lib/client.js`）：document 级 capture 阶段监听 `drop`（先于内置 InputBar 的 bubble 监听）。有非图片文件时 `preventDefault` + `stopPropagation`，上传后把每个文件作为 composer 引用 chip 插入（chip 标签只有文件名，点击 chip 直接打开文件——宿主 openFile 路径，与气泡链接一致）。插件同时注册一个空的 `@inbox-file` trigger source，仅提供 codec：发送时把 chip 序列化成 `[文件名](<绝对路径>)`。图片子集重新派发一个 drop 给内置 intake。纯图片拖放完全不干预。
- **气泡渲染**（DSH 本体 `ui-conversation` 的用户消息投影）：用户消息里的 `[文件名](<绝对路径>)` 被装饰为可点击链接（蓝色、悬停下划线），点击走聊天视图的 `openFile`（宿主打开文档）——与产物文件 chip 同一打开路径；链接目标非绝对路径时保持字面文本。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `maxUploadBytes` | `20971520`（20MB） | 单文件字节上限 |
| `inboxDirName` | `.dsh/inbox` | 会话 cwd 下的收件目录名 |

示例（profile 的 `cordis.patch.yml` 或 bundle 覆盖）：

```yaml
- id: file-drop-inbox
  config:
    maxUploadBytes: 52428800
    inboxDirName: '.dsh/inbox'
```

## 安装

在 profile 目录执行（或加到 `dsh.profile.bundles`）：

```sh
pnpm dsh plugin --profile web add ./profiles/web/file-drop-inbox
```

重启 `pnpm dsh web` 并硬刷新浏览器。验证：

```sh
pnpm dsh --profile web --dump-config | grep file-drop-inbox
```

## 测试

```sh
node --test lib/
```

覆盖文件名消毒、重名避让、路径越界防护等 host 纯函数。

## 已知限制

- 拖放悬停时内置 overlay 仍显示「图片拖到此处即可添加」——浏览器在 `dragover` 阶段拿不到文件内容，无法提前区分图片与非图片；放下时行为才分流。
- 非图片不做模型可见的「附件卡片」：草稿里是文件名 chip，发出去才是带完整路径的 markdown 超链（气泡里可点击打开）；这正是本插件的设计（工作区落盘 + 路径引用）。
- 无会话（hero 页）时拖入非图片会被忽略（没有可归属的 cwd）。
