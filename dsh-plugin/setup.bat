@echo off
setlocal EnableExtensions
rem =============================================================================
rem dsh-plugin setup - deploy the dsh web profile (plugin config layer)
rem
rem Purpose: copy profiles/web plugin configs from this repo into the local DSH
rem          profile, then run pnpm install to rebuild plugin dependencies.
rem          Run once after cloning on a new machine.
rem
rem Usage:
rem   setup.bat                     deploy to %USERPROFILE%\.dsh\profiles\web
rem   set DSH_HOME=C:\path\to\dsh ^& setup.bat   specify a custom DSH home
rem   setup.bat --dry-run           print the actions without writing anything
rem
rem Prereq:
rem   - dsh itself (deepseek-harness checkout that can run `pnpm dsh web`)
rem   - node >= 20 and pnpm >= 10 on PATH
rem
rem Note: only declaration files are deployed; node_modules is not copied
rem       (machine-specific and large). pnpm install rebuilds all plugin deps
rem       from package.json + lockfile.
rem =============================================================================

set "DRY_RUN="

:parse
if "%~1"=="" goto :parse_done
if /I "%~1"=="--dry-run" (
  set "DRY_RUN=1"
) else (
  echo [error] unknown argument: %~1 ^(only --dry-run is supported^) 1>&2
  exit /b 2
)
shift
goto :parse
:parse_done

rem ---- paths ----
set "SCRIPT_DIR=%~dp0"
set "SRC_DIR=%SCRIPT_DIR%profiles\web"

if defined DSH_HOME (
  set "DSH_ROOT=%DSH_HOME%"
) else if defined HOME (
  set "DSH_ROOT=%HOME%\.dsh"
) else (
  set "DSH_ROOT=%USERPROFILE%\.dsh"
)
set "PROFILE_DIR=%DSH_ROOT%\profiles\web"

set "FILES=package.json pnpm-workspace.yaml pnpm-lock.yaml cordis.patch.yml cordis.yml"

rem ---- preflight checks ----
if not exist "%SRC_DIR%" (
  echo [error] source config dir not found: %SRC_DIR% 1>&2
  echo [error] please run from the dsh-plugin repo root 1>&2
  exit /b 1
)
for %%f in (%FILES%) do (
  if not exist "%SRC_DIR%\%%f" (
    echo [error] missing source config file: %SRC_DIR%\%%f 1>&2
    exit /b 1
  )
)
where node >nul 2>&1 || (
  echo [error] node not found ^(need node ^>= 20^) 1>&2
  exit /b 1
)
where pnpm >nul 2>&1 || (
  echo [error] pnpm not found ^(need pnpm ^>= 10^) 1>&2
  exit /b 1
)

echo [setup] source config : %SRC_DIR%
echo [setup] target profile : %PROFILE_DIR%

if defined DRY_RUN (
  echo [setup] [dry-run] step 1: mkdir "%PROFILE_DIR%"
  echo [setup] [dry-run] step 2: copy %FILES% to %PROFILE_DIR% ^(overwrite^)
  echo [setup] [dry-run] step 3: cd /d "%PROFILE_DIR%" ^&^& pnpm install ^(rebuild plugin deps, incl. node-pty build^)
  echo [setup] [dry-run] done. next: restart dsh web ^(pnpm dsh web^) and hard-refresh the browser.
  exit /b 0
)

rem ---- step 1: ensure profile dir exists ----
if not exist "%PROFILE_DIR%" mkdir "%PROFILE_DIR%"

rem ---- step 2: copy declaration files (overwrite) ----
for %%f in (%FILES%) do (
  copy /Y "%SRC_DIR%\%%f" "%PROFILE_DIR%\%%f" >nul
  echo [setup] deployed %PROFILE_DIR%\%%f
)

rem ---- step 3: install dependencies ----
echo [setup] running pnpm install (%PROFILE_DIR%)...
pushd "%PROFILE_DIR%"
call pnpm install
set "PNPM_RC=%errorlevel%"
popd
if not "%PNPM_RC%"=="0" (
  echo [error] pnpm install failed with exit code %PNPM_RC% 1>&2
  exit /b 1
)

echo [setup] done. next: restart dsh web and hard-refresh (Ctrl+Shift+R)
echo [setup] verify: pnpm dsh --profile web --dump-config ^| findstr "better-sidebar skills-viewer mcp-manager"

exit /b 0
