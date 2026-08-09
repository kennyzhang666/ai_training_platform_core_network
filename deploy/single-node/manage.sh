#!/usr/bin/env bash
set -Eeuo pipefail

action="${1:-}"
case "$action" in
  Prepare|Start|Stop|Status|Backup|Restore|Doctor) ;;
  *) printf '用法：%s {Prepare|Start|Stop|Status|Backup|Restore|Doctor} [--archive PATH] [--environment PATH]\n' "$0" >&2; exit 2 ;;
esac
shift

archive=""
environment_file=""
while (($#)); do
  case "$1" in
    --archive) [[ $# -ge 2 ]] || { printf '%s\n' '--archive 缺少路径' >&2; exit 2; }; archive="$2"; shift 2 ;;
    --environment) [[ $# -ge 2 ]] || { printf '%s\n' '--environment 缺少路径' >&2; exit 2; }; environment_file="$2"; shift 2 ;;
    *) printf '未知参数：%s\n' "$1" >&2; exit 2 ;;
  esac
done

deploy_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
project_root="$(cd "$deploy_root/../.." && pwd -P)"
environment_file="${environment_file:-$deploy_root/.env}"
environment_file="$(realpath -m "$environment_file")"

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

import_environment() {
  if [[ ! -f "$environment_file" ]]; then
    if [[ "$action" == 'Prepare' ]]; then
      cp -- "$deploy_root/.env.example" "$environment_file"
      printf '已生成配置文件：%s\n' "$environment_file"
      printf '%s\n' '请填写 PostgreSQL、SSO、LDAP、管理员、Worker 和 Code Agent 配置后重新执行 Prepare。'
      exit 0
    fi
    die "配置文件不存在：$environment_file。请先执行 Prepare。"
  fi
  set -a
  # shellcheck disable=SC1090
  source "$environment_file"
  set +a
  export PROJECT_ROOT="$project_root"
}

env_value() {
  local name="$1" default_value="${2:-}" value="${!1:-}"
  printf '%s' "${value:-$default_value}"
}

resolve_project_path() {
  local value="$1"
  if [[ "$value" == /* ]]; then realpath -m "$value"; else realpath -m "$project_root/$value"; fi
}

inside_path() {
  local parent child
  parent="$(realpath -m "$1")"
  child="$(realpath -m "$2")"
  [[ "$child" == "$parent"/* ]]
}

assert_project_child() {
  local path label
  path="$(realpath -m "$1")"
  label="$2"
  inside_path "$project_root" "$path" || die "$label 必须位于发布目录内：$path"
  printf '%s' "$path"
}

set_path_environment() {
  local name="$1" default_value="$2" path
  path="$(assert_project_child "$(resolve_project_path "$(env_value "$name" "$default_value")")" "$name")"
  printf -v "$name" '%s' "$path"
  export "$name"
}

assert_configured() {
  local name="$1" minimum="${2:-1}" value
  value="$(env_value "$name")"
  if ((${#value} < minimum)) || [[ "$value" =~ ^\<.*\>$ ]] || [[ "$value" == *replace-me* ]] || [[ "$value" == *change-me* ]]; then
    die "请在 $environment_file 中填写 $name"
  fi
}

resolve_executable() {
  local configured="$1" label="$2" candidate
  if [[ "$configured" == */* ]]; then
    candidate="$(resolve_project_path "$configured")"
    [[ -f "$candidate" && -x "$candidate" ]] || die "$label 不存在或不可执行：$candidate"
    printf '%s' "$candidate"
    return
  fi
  candidate="$(command -v "$configured" 2>/dev/null || true)"
  [[ -n "$candidate" ]] || die "找不到 $label：$configured"
  printf '%s' "$candidate"
}

import_environment

set_path_environment SINGLE_NODE_DATA_ROOT data
set_path_environment SINGLE_NODE_RUNTIME_ROOT runtime-state
set_path_environment SINGLE_NODE_BACKUP_ROOT backups
set_path_environment ARTIFACT_ROOT data/artifacts
set_path_environment ARTIFACT_UPLOAD_TMP_ROOT runtime-state/artifact-uploads
set_path_environment ENGINE_PACKAGE_ROOT data/engine-packages
set_path_environment EVALUATION_BATCH_ROOT runtime-state/evaluation-batches
set_path_environment EVALUATION_LOG_ROOT runtime-state/evaluation-logs
set_path_environment ENGINE_CACHE_ROOT data/worker-engines
set_path_environment PIP_CACHE_DIR data/pip-cache
set_path_environment ENGINE_PIP_FIND_LINKS deploy/single-node/wheelhouse

data_root="$SINGLE_NODE_DATA_ROOT"
runtime_root="$SINGLE_NODE_RUNTIME_ROOT"
backup_root="$SINGLE_NODE_BACKUP_ROOT"
artifact_root="$ARTIFACT_ROOT"
artifact_upload_root="$ARTIFACT_UPLOAD_TMP_ROOT"
engine_package_root="$ENGINE_PACKAGE_ROOT"
batch_root="$EVALUATION_BATCH_ROOT"
evaluation_log_root="$EVALUATION_LOG_ROOT"
engine_cache_root="$ENGINE_CACHE_ROOT"
pip_cache_root="$PIP_CACHE_DIR"
wheelhouse="$ENGINE_PIP_FIND_LINKS"

for state_path in "$artifact_root" "$engine_package_root" "$engine_cache_root" "$pip_cache_root"; do
  inside_path "$data_root" "$state_path" || die "持久数据路径必须位于 SINGLE_NODE_DATA_ROOT 内：$state_path"
done
inside_path "$runtime_root" "$artifact_upload_root" || die "上传临时目录必须位于 SINGLE_NODE_RUNTIME_ROOT 内：$artifact_upload_root"

pid_root="$runtime_root/pids"
log_root="$runtime_root/process-logs"
nginx_runtime_config="$runtime_root/nginx.conf"
runtime_node=""
runtime_python=""
runtime_gateway_python=""
runtime_nginx=""
runtime_mode=""

ensure_layout() {
  mkdir -p -- "$data_root" "$artifact_root" "$engine_package_root" "$engine_cache_root" "$pip_cache_root" \
    "$wheelhouse" "$runtime_root" "$pid_root" "$log_root" "$artifact_upload_root" "$batch_root" \
    "$evaluation_log_root" "$backup_root"
}

assert_preflight() {
  local pair name expected actual pip_help
  for pair in \
    'NODE_ENV=production' \
    'PLATFORM_DEPLOYMENT_PROFILE=single-node' \
    'PLATFORM_REPOSITORY=postgres' \
    'OBJECT_STORAGE_MODE=local' \
    'PLATFORM_IDENTITY_MODE=TRUSTED_GATEWAY' \
    'EMBEDDED_EVALUATION_WORKER=false'; do
    name="${pair%%=*}"
    expected="${pair#*=}"
    actual="$(env_value "$name")"
    [[ "${actual,,}" == "$expected" ]] || die "$name 必须是 $expected"
  done

  assert_configured DATABASE_URL
  assert_configured TRUSTED_GATEWAY_HMAC_SECRET 32
  assert_configured LDAP_GATEWAY_SESSION_SECRET 32
  assert_configured PLATFORM_BOOTSTRAP_GLOBAL_ADMIN_EMPLOYEE_NO
  assert_configured EVALUATION_WORKER_EMPLOYEE_NO
  assert_configured EVALUATION_WORKER_NAME
  assert_configured EVALUATION_WORKER_TRUSTED_GATEWAY_SECRET 32
  assert_configured LDAP_SERVER
  assert_configured LDAP_BASE_DN
  assert_configured NGINX_EXE
  [[ "$(env_value EVALUATION_WORKER_TRUSTED_GATEWAY_SECRET)" == "$(env_value TRUSTED_GATEWAY_HMAC_SECRET)" ]] || \
    die 'EVALUATION_WORKER_TRUSTED_GATEWAY_SECRET 必须与 TRUSTED_GATEWAY_HMAC_SECRET 相同'

  [[ -f "$project_root/apps/web/dist/index.html" ]] || die 'Web 构建产物不存在'
  [[ -f "$project_root/services/platform-api/dist/main.js" ]] || die 'API 构建产物不存在'

  runtime_mode="$(env_value PLATFORM_RUNTIME_MODE workspace)"
  runtime_mode="${runtime_mode,,}"
  [[ "$runtime_mode" == 'workspace' || "$runtime_mode" == 'bundled' ]] || die 'PLATFORM_RUNTIME_MODE 必须是 workspace 或 bundled'
  runtime_node="$(resolve_executable "$(env_value NODE_EXE node)" 'Node.js')"
  runtime_python="$(resolve_executable "$(env_value PYTHON .venv/bin/python)" '平台 Python')"
  runtime_gateway_python="$(resolve_executable "$(env_value LDAP_GATEWAY_PYTHON services/ldap3-gateway/.venv/bin/python)" 'LDAP 网关 Python')"
  runtime_nginx="$(resolve_executable "$(env_value NGINX_EXE)" 'Nginx')"

  if [[ "$runtime_mode" == 'workspace' ]]; then
    command -v pnpm >/dev/null 2>&1 || die '找不到 pnpm'
  else
    [[ -f "$project_root/services/platform-api/node_modules/prisma/build/index.js" ]] || die 'Prisma 迁移工具不存在'
  fi
  pip_help="$($runtime_python -m pip --help 2>&1 || true)"
  [[ "$pip_help" == *'--python'* ]] || die '平台 Python 的 pip 不支持 --python，无法创建隔离依赖环境'
  "$runtime_gateway_python" -c 'import ldap3' >/dev/null 2>&1 || die 'LDAP 网关 Python 缺少 ldap3'
  resolve_executable "$(env_value CODE_AGENT_COMMAND)" 'Code Agent' >/dev/null
  command -v tar >/dev/null 2>&1 || die '找不到 tar'
}

invoke_platform_package() {
  pnpm --filter '@ai-training/platform-api' "$@"
}

invoke_platform_node() {
  local script="$1"
  shift
  (cd "$project_root" && "$runtime_node" "$script" "$@")
}

use_bundled_runtime() {
  [[ "$(env_value PLATFORM_RUNTIME_MODE workspace | tr '[:upper:]' '[:lower:]')" == 'bundled' ]]
}

deploy_database() {
  if use_bundled_runtime; then
    invoke_platform_node "$project_root/services/platform-api/node_modules/prisma/build/index.js" migrate deploy \
      --schema "$project_root/services/platform-api/prisma/schema.prisma"
  else
    invoke_platform_package prisma:migrate:deploy
  fi
}

check_database() {
  if use_bundled_runtime; then
    invoke_platform_node "$project_root/services/platform-api/node_modules/prisma/build/index.js" migrate status \
      --schema "$project_root/services/platform-api/prisma/schema.prisma"
  else
    invoke_platform_package exec prisma migrate status --schema "$project_root/services/platform-api/prisma/schema.prisma"
  fi
}

export_database() {
  local output="$1"
  if use_bundled_runtime; then
    invoke_platform_node "$project_root/services/platform-api/scripts/backup-postgres.mjs" --output "$output"
  else
    invoke_platform_package backup:postgres -- --output "$output"
  fi
}

import_database() {
  local source="$1"
  if use_bundled_runtime; then
    invoke_platform_node "$project_root/services/platform-api/scripts/restore-postgres.mjs" \
      --source "$source" --confirm --confirm-production
  else
    invoke_platform_package restore:postgres -- --source "$source" --confirm --confirm-production
  fi
}

new_nginx_config() {
  local nginx_home mime_types template
  nginx_home="$(cd "$(dirname "$runtime_nginx")/.." && pwd -P)"
  mime_types="$(env_value NGINX_MIME_TYPES "$nginx_home/conf/mime.types")"
  mime_types="$(resolve_project_path "$mime_types")"
  [[ -f "$mime_types" ]] || die "Nginx MIME 配置不存在：$mime_types"
  template="$deploy_root/nginx-http.conf.template"
  "$runtime_python" - "$template" "$nginx_runtime_config" \
    "$runtime_root/nginx.pid" "$log_root/nginx-error.log" "$log_root/nginx-access.log" "$mime_types" \
    "$(env_value SINGLE_NODE_LISTEN_PORT 8080)" "$(env_value SINGLE_NODE_SERVER_NAME _)" "$project_root/apps/web/dist" <<'PY'
from pathlib import Path
import sys

template, target, pid, error_log, access_log, mime_types, port, server_name, web_root = sys.argv[1:]
text = Path(template).read_text(encoding="utf-8")
values = {
    "__NGINX_PID__": pid,
    "__NGINX_ERROR_LOG__": error_log,
    "__NGINX_ACCESS_LOG__": access_log,
    "__NGINX_MIME_TYPES__": mime_types,
    "__LISTEN_PORT__": port,
    "__SERVER_NAME__": server_name,
    "__WEB_ROOT__": web_root,
}
for key, value in values.items():
    text = text.replace(key, value)
Path(target).write_text(text, encoding="utf-8")
PY
  "$runtime_nginx" -t -p "$nginx_home/" -c "$nginx_runtime_config"
}

pid_file() {
  printf '%s/%s.pid' "$pid_root" "$1"
}

managed_pid() {
  local file pid command_line
  file="$(pid_file "$1")"
  [[ -f "$file" ]] || return 1
  pid="$(<"$file")"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  command_line="$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)"
  [[ "$command_line" == *"$project_root"* ]] || return 1
  printf '%s' "$pid"
}

start_managed() {
  local name="$1" working_directory="$2" executable="$3" stdout stderr pid
  shift 3
  if pid="$(managed_pid "$name")"; then
    printf '%s 已在运行（PID %s）\n' "$name" "$pid"
    return
  fi
  stdout="$log_root/$name.stdout.log"
  stderr="$log_root/$name.stderr.log"
  (
    cd "$working_directory"
    nohup "$executable" "$@" >>"$stdout" 2>>"$stderr" &
    printf '%s\n' "$!" >"$(pid_file "$name")"
  )
  sleep 0.5
  pid="$(managed_pid "$name" || true)"
  [[ -n "$pid" ]] || die "$name 启动失败，请查看 $stderr"
}

stop_managed() {
  local name="$1" pid command_line attempt
  pid="$(managed_pid "$name" || true)"
  if [[ -z "$pid" ]]; then
    rm -f -- "$(pid_file "$name")"
    return
  fi
  command_line="$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)"
  [[ "$command_line" == *"$project_root"* ]] || die "拒绝停止不属于当前部署的进程：$name PID $pid"
  kill -TERM "$pid"
  for attempt in {1..50}; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.2
  done
  if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null || true; fi
  rm -f -- "$(pid_file "$name")"
}

wait_health() {
  local name="$1" uri="$2" attempt
  for attempt in {1..30}; do
    if "$runtime_node" -e 'fetch(process.argv[1]).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))' "$uri"; then return; fi
    sleep 0.5
  done
  die "$name 健康检查失败：$uri"
}

start_all() {
  ensure_layout
  assert_preflight
  deploy_database
  new_nginx_config
  start_managed api "$project_root" "$runtime_node" "$project_root/services/platform-api/dist/main.js"
  start_managed ldap3 "$project_root/services/ldap3-gateway" "$runtime_gateway_python" \
    "$project_root/services/ldap3-gateway/ldap3_gateway.py"
  wait_health '平台 API' 'http://127.0.0.1:3000/api/v1/health'
  wait_health 'LDAP 网关' 'http://127.0.0.1:8081/healthz'
  start_managed worker "$project_root" "$runtime_node" "$project_root/scripts/evaluation-worker.mjs" \
    --api "$(env_value PLATFORM_API http://127.0.0.1:3000/api/v1)" \
    --employee "$(env_value EVALUATION_WORKER_EMPLOYEE_NO)" \
    --worker "$(env_value EVALUATION_WORKER_ID single-node-worker)" \
    --batch-root "$batch_root" --cache "$engine_cache_root"
  local nginx_home
  nginx_home="$(cd "$(dirname "$runtime_nginx")/.." && pwd -P)"
  start_managed nginx "$nginx_home" "$runtime_nginx" -p "$nginx_home/" -c "$nginx_runtime_config"
  printf '单服务器平台已启动：http://127.0.0.1:%s/\n' "$(env_value SINGLE_NODE_LISTEN_PORT 8080)"
}

stop_all() {
  local name
  for name in nginx worker ldap3 api; do stop_managed "$name"; done
  printf '%s\n' '单服务器平台已停止'
}

show_status() {
  local name pid
  printf '%-10s %-10s %s\n' '服务' '状态' 'PID'
  for name in api ldap3 worker nginx; do
    pid="$(managed_pid "$name" || true)"
    if [[ -n "$pid" ]]; then printf '%-10s %-10s %s\n' "$name" '运行中' "$pid"; else printf '%-10s %-10s %s\n' "$name" '已停止' '-'; fi
  done
}

safe_remove_runtime() {
  local path
  path="$(realpath -m "$1")"
  inside_path "$runtime_root" "$path" || die "拒绝清理运行目录之外的路径：$path"
  rm -rf -- "$path"
}

any_running() {
  local name
  for name in api ldap3 worker nginx; do managed_pid "$name" >/dev/null 2>&1 && return 0; done
  return 1
}

platform_version() {
  if [[ -f "$project_root/VERSION" ]]; then
    tr -d '\r\n' <"$project_root/VERSION"
  elif [[ -f "$project_root/package.json" ]]; then
    "$runtime_node" -p 'require(process.argv[1]).version' "$project_root/package.json"
  else
    printf '%s' 'unknown'
  fi
}

new_backup() {
  ensure_layout
  assert_preflight
  local was_running='false' stamp destination staging version cleanup_required='true'
  any_running && was_running='true'
  [[ "$was_running" == 'false' ]] || stop_all
  stamp="$(date +%Y%m%d-%H%M%S)"
  destination="${archive:-$backup_root/ai-training-single-node-$stamp.tar.gz}"
  destination="$(realpath -m "$destination")"
  [[ ! -e "$destination" ]] || die "备份文件已存在，拒绝覆盖：$destination"
  mkdir -p -- "$(dirname "$destination")"
  staging="$(assert_project_child "$runtime_root/backup-$stamp" '备份临时目录')"
  cleanup_backup() {
    if [[ "$cleanup_required" == 'true' ]]; then
      set +e
      [[ -d "$staging" ]] && safe_remove_runtime "$staging"
      [[ "$was_running" == 'true' ]] && start_all
    fi
  }
  trap cleanup_backup EXIT
  mkdir -p -- "$staging"
  export_database "$staging/database.json"
  cp -a -- "$data_root" "$staging/data"
  version="$(platform_version)"
  "$runtime_node" -e 'const fs=require("node:fs");fs.writeFileSync(process.argv[1],JSON.stringify({version:process.argv[2],database:"postgresql",createdAt:new Date().toISOString()},null,2)+"\n")' \
    "$staging/manifest.json" "$version"
  tar -C "$staging" -czf "$destination" database.json data manifest.json
  safe_remove_runtime "$staging"
  cleanup_required='false'
  trap - EXIT
  [[ "$was_running" == 'false' ]] || start_all
  printf '备份已生成：%s\n' "$destination"
}

extract_backup() {
  local source="$1" target="$2"
  "$runtime_python" - "$source" "$target" <<'PY'
from pathlib import Path
import sys
import tarfile

source, target = Path(sys.argv[1]), Path(sys.argv[2]).resolve()
with tarfile.open(source, "r:gz") as archive:
    members = archive.getmembers()
    for member in members:
        destination = (target / member.name).resolve()
        if destination != target and target not in destination.parents:
            raise SystemExit(f"备份包含越界路径：{member.name}")
        if member.issym() or member.islnk():
            raise SystemExit(f"备份包含链接：{member.name}")
        if not (member.isfile() or member.isdir()):
            raise SystemExit(f"备份包含不支持的条目：{member.name}")
    for member in members:
        archive.extract(member, target)
PY
}

restore_backup() {
  [[ -n "$archive" ]] || die 'Restore 必须通过 --archive 指定备份 tar.gz'
  local source stamp staging previous_data failed_data previous_uploads failed_uploads cleanup_required='true'
  source="$(realpath -m "$archive")"
  [[ -f "$source" ]] || die "备份不存在：$source"
  ensure_layout
  assert_preflight
  stop_all
  stamp="$(date +%Y%m%d-%H%M%S)"
  staging="$(assert_project_child "$runtime_root/restore-$stamp" '恢复临时目录')"
  previous_data="$(assert_project_child "${data_root}.before-restore-$stamp" '恢复前数据目录')"
  failed_data="$(assert_project_child "${data_root}.failed-restore-$stamp" '失败恢复数据目录')"
  previous_uploads="$(assert_project_child "$runtime_root/artifact-uploads.before-restore-$stamp" '恢复前上传临时目录')"
  failed_uploads="$(assert_project_child "$runtime_root/artifact-uploads.failed-restore-$stamp" '失败恢复上传临时目录')"
  cleanup_restore() {
    if [[ "$cleanup_required" == 'true' ]]; then
      set +e
      [[ -d "$staging" ]] && safe_remove_runtime "$staging"
    fi
  }
  trap cleanup_restore EXIT
  mkdir -p -- "$staging"
  extract_backup "$source" "$staging"
  [[ -f "$staging/manifest.json" && -f "$staging/database.json" && -d "$staging/data" ]] || die '备份结构无效'
  deploy_database
  [[ ! -e "$data_root" ]] || mv -- "$data_root" "$previous_data"
  mv -- "$staging/data" "$data_root"
  [[ ! -e "$artifact_upload_root" ]] || mv -- "$artifact_upload_root" "$previous_uploads"
  mkdir -p -- "$artifact_upload_root"
  if ! import_database "$staging/database.json"; then
    [[ ! -e "$previous_uploads" ]] || { mv -- "$artifact_upload_root" "$failed_uploads"; mv -- "$previous_uploads" "$artifact_upload_root"; }
    [[ ! -e "$previous_data" ]] || { mv -- "$data_root" "$failed_data"; mv -- "$previous_data" "$data_root"; }
    die '数据库恢复失败，已还原恢复前的数据目录'
  fi
  safe_remove_runtime "$staging"
  cleanup_required='false'
  trap - EXIT
  printf '恢复完成。原数据保留在：%s；未完成上传保留在：%s\n' "$previous_data" "$previous_uploads"
}

doctor() {
  ensure_layout
  assert_preflight
  new_nginx_config
  check_database
  printf '部署检查通过：%s / Linux x64\n' "$runtime_mode"
}

case "$action" in
  Prepare) ensure_layout; assert_preflight; deploy_database; new_nginx_config; printf '%s\n' '单服务器部署检查通过' ;;
  Start) start_all ;;
  Stop) stop_all ;;
  Status) show_status ;;
  Backup) new_backup ;;
  Restore) restore_backup ;;
  Doctor) doctor ;;
esac
