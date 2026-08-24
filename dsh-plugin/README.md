# dsh-plugin

English | [中文](README.zh.md)

My DeepSeek Harness (DSH) web profile plugin configuration repository. Goal: **clone → run setup.sh once → plugins ready**.

## Layout

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

## Configured plugins

| Plugin | Purpose | Install method |
|---|---|---|
| `dsh-better-sidebar` | Right-rail workbench (files/editor/terminal/Git/browser) | npm, bundle auto-mount |
| `dsh-skill-mcp-panel` | Manage skills and MCP from the Web UI (enable/disable/remove/add/migrate/group; MCP panel) | GitHub release tarball, bundle auto-mount |
| `auto-compact` | Automatic compaction | npm, bundle auto-mount |
| `dsh-file-drop-inbox` | Drop files into the workspace `.dsh/inbox`; the draft inserts a filename-only chip, sent as `[filename](<path>)`; the bubble link opens the document (logs/configs and other non-images; images still use the built-in intake) | Local package `profiles/web/file-drop-inbox`, bundle auto-mount |

## Quick start (new machine)

Prerequisite: a working dsh checkout (deepseek-harness, able to run `pnpm dsh web`), node ≥ 20, pnpm ≥ 10.

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

**Windows users**: use `setup.bat` (equivalent to setup.sh), from cmd/PowerShell:

```bat
:: 2. one-shot deploy of the plugin config (equivalent Windows command)
setup.bat
::    or point DSH_HOME at a non-default location:
::    set DSH_HOME=C:\path\to\dsh && setup.bat
::    preview without executing:
::    setup.bat --dry-run
```

> Note: `setup.bat` and `setup.sh` are equivalent; the scripts use ASCII only (no Chinese), and both LF and CRLF line endings parse correctly in cmd. The repository `.gitattributes` manages everything as LF.

Verify it took effect:

```sh
pnpm dsh --profile web --dump-config | grep -E 'better-sidebar|skill-mcp-panel|file-drop-inbox'
```

In the browser: Settings → the "Skills" and "MCP" pages should appear below the plugins (skill-mcp-panel), and the workbench appears in the right rail (better-sidebar).

## Daily maintenance

**Add a plugin**: in `~/.dsh/profiles/web`, run `pnpm dsh plugin --profile web add <pkg>`, then sync the updated `package.json` / `pnpm-lock.yaml` (plus any required `cordis.patch.yml` mount row) back to `profiles/web/` in this repository and commit.

**Update a plugin**: same flow with `pnpm dsh plugin --profile web update <pkg>`, then sync the lockfile.

**Remove a plugin**: `pnpm dsh plugin --profile web remove <pkg>`, then sync the declaration files.

## Notes

- **node_modules is not committed**: it contains platform-specific binaries (node-pty etc.) and symlinks pointing at local absolute paths, which would break elsewhere. `pnpm install` rebuilds it exactly from the lockfile.
- **dsh itself is separate from this config**: this repository only manages the plugin configuration layer (`~/.dsh/profiles/web`). The dsh checkout (deepseek-harness) is another repository; both must be in place to run.
- If a plugin declares `dsh.bundle.patch`, `dsh plugin add` appends it to `dsh.profile.bundles` automatically; plugins without a bundle need a manual mount row in `cordis.patch.yml`.
