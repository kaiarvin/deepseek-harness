# dsh-plugin

我的 DeepSeek Harness（DSH）web profile 插件配置仓库。目标是：**clone 下来 → 跑一次 setup.sh → 插件即用**。

## 目录结构

```
dsh-plugin/
├── profiles/web/        # web profile 插件配置（可提交的声明文件）
│   ├── package.json         # 依赖清单 + dsh.profile.bundles（插件“货源清单”）
│   ├── pnpm-workspace.yaml  # allowBuilds / minimumReleaseAgeExclude
│   ├── pnpm-lock.yaml       # 锁定精确版本（可复现安装）
│   ├── cordis.patch.yml     # 手动挂载行（无 dsh.bundle 的插件）
│   └── cordis.yml           # profile 根（空列表，模板）
├── setup.sh             # 一键部署：复制配置到 DSH profile + pnpm install
└── .gitignore           # 忽略 node_modules 等机器相关产物
```

## 已配置的插件

| 插件 | 用途 | 安装方式 |
|---|---|---|
| `dsh-better-sidebar` | 右侧栏工作台（文件/编辑器/终端/Git/浏览器） | npm，bundle 自动挂载 |
| `dsh-skill-viewer` | Web 界面管理 skills（启停/删除/添加/迁移/分组） | GitHub release tarball，bundle 自动挂载 |
| `dsh-mcp-manager` | MCP server 管理（设置页） | npm，cordis.patch.yml 手动挂载 |
| `auto-compact` | 自动压缩 | npm，bundle 自动挂载 |

## 快速开始（新机器）

前置：本机已有 dsh 本体（deepseek-harness checkout，能跑 `pnpm dsh web`），node ≥ 20、pnpm ≥ 10。

```sh
# 1. clone 本仓库（或你已 clone 的 deepseek-harness 里的 dsh-plugin 目录）
git clone <你的仓库地址> dsh-plugin
cd dsh-plugin

# 2. 一键部署插件配置
bash setup.sh
#    或用 DSH_HOME 指定非默认位置：
#    DSH_HOME=/custom/dsh bash setup.sh
#    预览不执行：
#    bash setup.sh --dry-run

# 3. 重启 dsh web（插件 host 半需要重启才生效）
#    在 dsh 终端 Ctrl+C 后重新 pnpm dsh web，浏览器硬刷新 Cmd+Ctrl+R
```

验证是否生效：

```sh
pnpm dsh --profile web --dump-config | grep -E 'better-sidebar|skills-viewer|mcp-manager'
```

浏览器里：设置 → 插件下方应出现「技能」页（skill-viewer），右侧栏出现工作台（better-sidebar）。

## 日常维护

**新增插件**：在 `~/.dsh/profiles/web` 执行 `pnpm dsh plugin --profile web add <pkg>`，然后把更新后的 `package.json` / `pnpm-lock.yaml`（及必要的 `cordis.patch.yml` 挂载行）同步回本仓库 `profiles/web/` 并提交。

**更新插件**：同上，用 `pnpm dsh plugin --profile web update <pkg>`，同步 lockfile。

**卸载插件**：`pnpm dsh plugin --profile web remove <pkg>`，同步声明文件。

## 注意事项

- **node_modules 不提交**：它含平台相关二进制（node-pty 等）和指向本机绝对路径的符号链接，clone 到别处会断。由 `pnpm install` 按 lockfile 精确重建。
- **dsh 本体与本配置分离**：本仓库只管理「插件配置层」（`~/.dsh/profiles/web`）。dsh 本体（deepseek-harness）是另一个仓库，两者都需就位才能运行。
- 若插件声明 `dsh.bundle.patch`，`dsh plugin add` 会自动追加进 `dsh.profile.bundles`；无 bundle 的插件（如 mcp-manager）需手动加挂载行到 `cordis.patch.yml`。
