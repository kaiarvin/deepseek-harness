#!/usr/bin/env bash
# =============================================================================
# dsh-plugin setup — 一键部署 dsh web profile（插件配置层）
#
# 用途：把本仓库 dsh-plugin/profiles/web 下的插件配置部署到本机 DSH profile，
#       并运行 pnpm install 重建插件依赖。新机器 clone 后跑一次即可。
#
# 用法：
#   bash setup.sh            # 部署到默认 ~/.dsh/profiles/web
#   DSH_HOME=/path/to/dsh bash setup.sh   # 指定 DSH home
#   bash setup.sh --dry-run  # 只打印将要执行的操作，不写文件
#
# 前置：
#   - 本机已有 dsh 本体（deepseek-harness checkout，可运行 `pnpm dsh web`）
#   - node >= 20、pnpm >= 10
#
# 注意：本脚本只部署「声明文件」，不复制 node_modules（机器相关、体积大）。
#       pnpm install 会按 package.json + lockfile 精确重建全部插件依赖。
# =============================================================================
set -euo pipefail

DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    *) echo "未知参数: ${arg}（仅支持 --dry-run）" >&2; exit 2 ;;
  esac
done

# ── 路径 ─────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$SCRIPT_DIR/profiles/web"
DSH_HOME="${DSH_HOME:-${HOME:-${USERPROFILE:-}}/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/web"
FILES=(package.json pnpm-workspace.yaml pnpm-lock.yaml cordis.patch.yml cordis.yml)
# 本地插件包目录（整目录部署；仓库内不含 node_modules，lib 为预构建产物）
DIRS=(file-drop-inbox)

say()  { printf '\033[32m[setup]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

# ── 前置校验 ─────────────────────────────────────────────────────────────────
[ -d "$SRC_DIR" ] || die "找不到源配置目录：${SRC_DIR}（请确认在 dsh-plugin 仓库根目录运行）"
for f in "${FILES[@]}"; do
  [ -f "$SRC_DIR/$f" ] || die "源配置缺少文件：${SRC_DIR}/${f}"
done
for d in "${DIRS[@]}"; do
  [ -d "$SRC_DIR/$d" ] || die "缺少插件目录：${SRC_DIR}/${d}"
done
command -v node >/dev/null 2>&1 || die "未找到 node（需要 node >= 20）"
command -v pnpm >/dev/null 2>&1 || die "未找到 pnpm（需要 pnpm >= 10）"

say "源配置：${SRC_DIR}"
say "目标 profile：${PROFILE_DIR}"
say "将部署 ${#FILES[@]} 个配置文件和 ${#DIRS[@]} 个插件目录并运行 pnpm install"

if [ "$DRY_RUN" = true ]; then
  say "[dry-run] 步骤 1：mkdir -p ${PROFILE_DIR}"
  say "[dry-run] 步骤 2：复制 ${#FILES[@]} 个配置文件到 ${PROFILE_DIR}（覆盖）"
  for d in "${DIRS[@]}"; do
    say "[dry-run] 步骤 2：复制插件目录 ${d}/ 到 ${PROFILE_DIR}/${d}/（覆盖）"
  done
  say "[dry-run] 步骤 3：cd ${PROFILE_DIR} && pnpm install（重建插件依赖，含 node-pty 构建）"
  say "[dry-run] 完成。下一步：重启 dsh web（pnpm dsh web）并硬刷新浏览器。"
  exit 0
fi

# ── 步骤 1：确保 profile 目录存在 ───────────────────────────────────────────
mkdir -p "$PROFILE_DIR"

# ── 步骤 2：复制声明文件（覆盖）─────────────────────────────────────────────
for f in "${FILES[@]}"; do
  cp "$SRC_DIR/$f" "$PROFILE_DIR/$f"
  say "已部署 ${PROFILE_DIR}/${f}"
done
for d in "${DIRS[@]}"; do
  rm -rf "$PROFILE_DIR/$d"
  cp -r "$SRC_DIR/$d" "$PROFILE_DIR/$d"
  say "已部署 ${PROFILE_DIR}/${d}/"
done

# ── 步骤 3：安装依赖 ─────────────────────────────────────────────────────────
say "运行 pnpm install（${PROFILE_DIR}）..."
(
  cd "$PROFILE_DIR"
  pnpm install
)

say "完成。下一步：重启 dsh web 并硬刷新浏览器（Cmd/Ctrl+Shift+R）"
say "若想验证：pnpm dsh --profile web --dump-config | grep -E 'better-sidebar|skill-mcp-panel|file-drop-inbox'"
