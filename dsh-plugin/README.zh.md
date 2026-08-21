# dsh-plugin

[English](README.md) | 中文

我的 DeepSeek Harness（DSH）web profile 插件配置仓库。目标是：**clone 下来 → 跑一次 setup.sh → 插件即用**。

## 目录结构

```
dsh-plugin/
├── profiles/web/        # web profile plugin config (committable declaration files)
│   ├── package.json         # dependency manifest + dsh.profile.bundles (the plugin "supply list")
│   ├── pnpm-workspace.yaml  # allowBuilds / minimumReleaseAgeExclude
│   ├── pnpm-lock.yaml       # pinned exact versions (reproducible install)
│   ├── cordis.patch.yml     # manual mount rows (plugins without a dsh.bundle)
│   ├── cordis.yml           # profile root (empty list, template)
│   └── file-drop-inbox/     # local plugin package: drop files into the workspace .dsh/inbox (see its README)
├── setup.sh             # one-shot deploy (bash / macOS / Linux)
├── setup.bat            # one-shot deploy (Windows cmd, equivalent to setup.sh)
└── .gitignore           # ignores node_modules and other machine-specific artifacts
```

## 已配置的插件

| 插件 | 用途 | 安装方式 |
|---|---|---|
| `dsh-better-sidebar` | 右侧栏工作台（文件/编辑器/终端/Git/浏览器） | npm，bundle 自动挂载 |
| `dsh-skill-mcp-panel` | Web 界面管理 skills 与 MCP（启停/删除/添加/迁移/分组；MCP 面板） | GitHub release tarball，bundle 自动挂载 |
| `auto-compact` | 自动压缩 | npm，bundle 自动挂载 |
| `dsh-file-drop-inbox` | 文件拖入工作区 `.dsh/inbox`，草稿插入只显示文件名的 chip，发送为 `[文件名](<路径>)`，气泡中可点击打开文档（log/配置等非图片；图片仍走内置 intake） | 本地包 `profiles/web/file-drop-inbox`，bundle 自动挂载 |

## 快速开始（新机器）

前置：本机已有 dsh 本体（deepseek-harness checkout，能跑 `pnpm dsh web`），node ≥ 20、pnpm ≥ 10。

```sh
# 1. clone this repository (or use the dsh-plugin directory inside your deepseek-harness clone)
git clone <your-repo-url> dsh-plugin
cd dsh-plugin

# 2. one-shot deploy of the plugin config
bash setup.sh
#    or point DSH_HOME at a non-default location:
#    DSH_HOME=/custom/dsh bash setup.sh
#    preview without executing:
#    bash setup.sh --dry-run

# 3. restart dsh web (the plugin host half needs a restart to take effect)
#    Ctrl+C in the dsh terminal, then pnpm dsh web again; hard-refresh the browser with Cmd+Ctrl+R
```

**Windows 用户**：用 `setup.bat`（等价于 setup.sh），在 cmd/PowerShell 中：

```bat
:: 2. one-shot deploy of the plugin config (equivalent Windows command)
setup.bat
::    or point DSH_HOME at a non-default location:
::    set DSH_HOME=C:\path\to\dsh && setup.bat
::    preview without executing:
::    setup.bat --dry-run
```

> 注意：`setup.bat` 与 `setup.sh` 等价；脚本内只用 ASCII（无中文），LF / CRLF 行尾均可被 cmd 正确解析，仓库 `.gitattributes` 统一按 LF 管理。

验证是否生效：

```sh
pnpm dsh --profile web --dump-config | grep -E 'better-sidebar|skill-mcp-panel|file-drop-inbox'
```

浏览器里：设置 → 插件下方应出现「技能」页和「MCP」页（skill-mcp-panel），右侧栏出现工作台（better-sidebar）。

## 日常维护

**新增插件**：在 `~/.dsh/profiles/web` 执行 `pnpm dsh plugin --profile web add <pkg>`，然后把更新后的 `package.json` / `pnpm-lock.yaml`（及必要的 `cordis.patch.yml` 挂载行）同步回本仓库 `profiles/web/` 并提交。

**更新插件**：同上，用 `pnpm dsh plugin --profile web update <pkg>`，同步 lockfile。

**卸载插件**：`pnpm dsh plugin --profile web remove <pkg>`，同步声明文件。

## 注意事项

- **node_modules 不提交**：它含平台相关二进制（node-pty 等）和指向本机绝对路径的符号链接，clone 到别处会断。由 `pnpm install` 按 lockfile 精确重建。
- **dsh 本体与本配置分离**：本仓库只管理「插件配置层」（`~/.dsh/profiles/web`）。dsh 本体（deepseek-harness）是另一个仓库，两者都需就位才能运行。
- 若插件声明 `dsh.bundle.patch`，`dsh plugin add` 会自动追加进 `dsh.profile.bundles`；无 bundle 的插件需手动加挂载行到 `cordis.patch.yml`。
