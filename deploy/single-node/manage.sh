#!/usr/bin/env bash
set -Eeuo pipefail

action="${1:-}"
case "$action" in
  Install|Uninstall|Prepare|Start|Stop|Status|Backup|Restore|Doctor) ;;
  *) printf '用法：%s {Install|Uninstall|Prepare|Start|Stop|Status|Backup|Restore|Doctor} [--archive PATH] [--environment PATH]\n' "$0" >&2; exit 2 ;;
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

bootstrap_node() {
  local bundled="$project_root/runtime/node/bin/node"
  if [[ -f "$bundled" && -x "$bundled" ]]; then printf '%s' "$bundled"; return; fi
  command -v node 2>/dev/null || die '无法生成配置：发布包缺少 Node.js 运行时'
}

new_environment_file() {
  local template="$deploy_root/.env.example" generator="$project_root/scripts/prepare-single-node-environment.mjs" node
  [[ -f "$template" ]] || die "配置模板不存在：$template"
  [[ -f "$generator" ]] || die "配置生成器不存在：$generator"
  node="$(bootstrap_node)"
  "$node" "$generator" --template "$template" --output "$environment_file"
  chmod 600 -- "$environment_file"
}

edit_environment_file() {
  if [[ ! -t 0 || ! -t 1 ]]; then
    die "已生成配置文件：$environment_file。请填写配置后重新执行 install.sh。"
  fi
  local editor="${VISUAL:-${EDITOR:-vi}}"
  command -v "$editor" >/dev/null 2>&1 || die "找不到配置编辑器：$editor。请设置 EDITOR 后重试。"
  printf '%s\n' '请填写 PostgreSQL、首位管理员和 Worker 身份；保存并退出编辑器后将继续安装。LDAP 与公司 Code Agent 已使用内网默认参数。'
  "$editor" "$environment_file"
}

import_environment() {
  if [[ ! -f "$environment_file" ]]; then
    if [[ "$action" == 'Prepare' || "$action" == 'Install' ]]; then
      new_environment_file
      if [[ "$action" == 'Prepare' ]]; then
        printf '%s\n' '请填写 PostgreSQL、首位管理员和 Worker 身份后重新执行 Prepare。LDAP 与公司 Code Agent 已使用内网默认参数。'
        exit 0
      fi
      edit_environment_file
    else
      die "配置文件不存在：$environment_file。请先执行 Install 或 Prepare。"
    fi
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

assert_tcp_port() {
  local name="$1" value="$2"
  [[ "$value" =~ ^[0-9]+$ ]] && ((10#$value >= 1 && 10#$value <= 65535)) || die "$name 必须是 1–65535 之间的端口"
  printf '%s' "$((10#$value))"
}

assert_loopback_host() {
  local name="$1" value="$2"
  [[ "$value" == '127.0.0.1' ]] || die "$name 在单服务器模式下必须是 127.0.0.1"
  printf '%s' "$value"
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
api_host="$(env_value HOST 127.0.0.1)"
api_port="$(env_value PORT 3000)"
ldap_host="$(env_value LDAP_GATEWAY_HOST 127.0.0.1)"
ldap_port="$(env_value LDAP_GATEWAY_PORT 8081)"
listen_port="$(env_value SINGLE_NODE_LISTEN_PORT 8080)"
api_health_uri="http://$api_host:$api_port/api/v1/health"
ldap_health_uri="http://$ldap_host:$ldap_port/healthz"

for state_path in "$artifact_root" "$engine_package_root" "$engine_cache_root" "$pip_cache_root"; do
  inside_path "$data_root" "$state_path" || die "持久数据路径必须位于 SINGLE_NODE_DATA_ROOT 内：$state_path"
done
inside_path "$runtime_root" "$artifact_upload_root" || die "上传临时目录必须位于 SINGLE_NODE_RUNTIME_ROOT 内：$artifact_upload_root"

pid_root="$runtime_root/pids"
log_root="$runtime_root/process-logs"
nginx_runtime_config="$runtime_root/nginx.conf"
systemd_service_name='ai-training-platform.service'
systemd_service_file="/etc/systemd/system/$systemd_service_name"
runtime_node=""
runtime_python=""
runtime_gateway_python=""
runtime_nginx=""
runtime_mode=""
# Set by assert_preflight; start_all skips the evaluation Worker when false.
code_agent_ready=""

ensure_layout() {
  mkdir -p -- "$data_root" "$artifact_root" "$engine_package_root" "$engine_cache_root" "$pip_cache_root" \
    "$wheelhouse" "$runtime_root" "$pid_root" "$log_root" "$artifact_upload_root" "$batch_root" \
    "$evaluation_log_root" "$backup_root"
}

assert_preflight() {
  local pair name expected actual pip_help validated_api_port validated_ldap_port validated_listen_port expected_platform_api
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
    [[ "${actual,,}" == "${expected,,}" ]] || die "$name 必须是 $expected"
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
  assert_loopback_host HOST "$api_host" >/dev/null
  assert_loopback_host LDAP_GATEWAY_HOST "$ldap_host" >/dev/null
  validated_api_port="$(assert_tcp_port PORT "$api_port")"
  validated_ldap_port="$(assert_tcp_port LDAP_GATEWAY_PORT "$ldap_port")"
  validated_listen_port="$(assert_tcp_port SINGLE_NODE_LISTEN_PORT "$listen_port")"
  [[ "$validated_api_port" != "$validated_ldap_port" && "$validated_api_port" != "$validated_listen_port" && "$validated_ldap_port" != "$validated_listen_port" ]] || \
    die 'PORT、LDAP_GATEWAY_PORT 和 SINGLE_NODE_LISTEN_PORT 不能重复'
  expected_platform_api="http://$api_host:$api_port/api/v1"
  [[ "${PLATFORM_API:-$expected_platform_api}" == "$expected_platform_api" || "${PLATFORM_API:-}" == "$expected_platform_api/" ]] || \
    die "PLATFORM_API 必须与本机 API 端口一致：$expected_platform_api"

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
  "$runtime_python" -c 'import jsonschema, yaml' >/dev/null 2>&1 || die '平台 Python 缺少 jsonschema 或 PyYAML'
  "$runtime_gateway_python" -c 'import ldap3' >/dev/null 2>&1 || die 'LDAP 网关 Python 缺少 ldap3'
  # Only the evaluation Worker needs a Code Agent. Treating it as a hard
  # precondition meant an unresolvable CODE_AGENT_COMMAND also stopped the API,
  # the web tier and the LDAP gateway, so a Code Agent problem became a total
  # platform outage. Degrade instead: report it, skip the Worker in start_all,
  # and leave evaluation work queued until an operator fixes the command.
  code_agent_ready='true'
  if ! "$runtime_node" "$project_root/scripts/evaluation-worker.mjs" --check-config >/dev/null 2>&1; then
    code_agent_ready='false'
    printf '警告：Code Agent 配置不可用，评测 Worker 不会启动；平台 API、网页和 LDAP 网关照常运行。\n' >&2
    printf '      评测任务会留在队列中。修好 CODE_AGENT_COMMAND 后重新执行 Start 即可拉起 Worker。\n' >&2
  fi
  assert_port_available '平台 API' "$api_port" api
  assert_port_available 'LDAP 网关' "$ldap_port" ldap3
  assert_port_available '平台入口' "$listen_port" nginx
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

invoke_bundled_prisma() {
  local prisma_cli="$project_root/services/platform-api/node_modules/prisma/build/index.js"
  local query_engine="$project_root/services/platform-api/node_modules/@prisma/engines/libquery_engine-debian-openssl-3.0.x.so.node"
  local schema_engine="$project_root/services/platform-api/node_modules/@prisma/engines/schema-engine-debian-openssl-3.0.x"
  [[ -f "$prisma_cli" ]] || die 'Prisma 迁移工具不存在'
  [[ -f "$query_engine" ]] || die '离线发布包缺少 Prisma 查询引擎，请获取完整发布包'
  [[ -f "$schema_engine" ]] || die '离线发布包缺少 Prisma 迁移引擎，请获取完整发布包'
  PRISMA_QUERY_ENGINE_LIBRARY="$query_engine" \
    PRISMA_SCHEMA_ENGINE_BINARY="$schema_engine" \
    invoke_platform_node "$prisma_cli" "$@"
}

use_bundled_runtime() {
  [[ "$(env_value PLATFORM_RUNTIME_MODE workspace | tr '[:upper:]' '[:lower:]')" == 'bundled' ]]
}

check_database_compatibility() {
  if use_bundled_runtime; then
    invoke_platform_node "$project_root/services/platform-api/scripts/check-postgres-version.mjs"
  else
    invoke_platform_package check:postgres
  fi
}

test_packaged_prisma_client() {
  (cd "$project_root/services/platform-api" &&
    "$runtime_node" -e "const { PrismaClient } = require('@prisma/client'); const client = new PrismaClient(); client.\$disconnect().catch(() => process.exitCode = 1);") \
    || die '离线发布包内置 Prisma Client 无法加载，请重新校验并获取完整发布包'
}

initialize_prisma_client() {
  if use_bundled_runtime; then
    test_packaged_prisma_client
    return
  fi
  invoke_platform_package prisma:generate
  test_packaged_prisma_client
}

deploy_database() {
  initialize_prisma_client
  check_database_compatibility
  if use_bundled_runtime; then
    invoke_bundled_prisma 'migrate' 'deploy' \
      '--schema' "$project_root/services/platform-api/prisma/schema.prisma"
  else
    invoke_platform_package prisma:migrate:deploy
  fi
}

check_database() {
  check_database_compatibility
  if use_bundled_runtime; then
    invoke_bundled_prisma migrate status \
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
    "$listen_port" "$(env_value SINGLE_NODE_SERVER_NAME _)" "$project_root/apps/web/dist" \
    "$api_host" "$api_port" "$ldap_host" "$ldap_port" <<'PY'
from pathlib import Path
import sys

template, target, pid, error_log, access_log, mime_types, port, server_name, web_root, api_host, api_port, ldap_host, ldap_port = sys.argv[1:]
text = Path(template).read_text(encoding="utf-8")
values = {
    "__NGINX_PID__": pid,
    "__NGINX_ERROR_LOG__": error_log,
    "__NGINX_ACCESS_LOG__": access_log,
    "__NGINX_MIME_TYPES__": mime_types,
    "__LISTEN_PORT__": port,
    "__SERVER_NAME__": server_name,
    "__WEB_ROOT__": web_root,
    "__API_HOST__": api_host,
    "__API_PORT__": api_port,
    "__LDAP_GATEWAY_HOST__": ldap_host,
    "__LDAP_GATEWAY_PORT__": ldap_port,
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

assert_port_available() {
  local label="$1" port="$2" managed_name="$3"
  managed_pid "$managed_name" >/dev/null 2>&1 && return
  "$runtime_python" - "$port" <<'PY' >/dev/null 2>&1 || die "$label 端口已被其他程序占用：127.0.0.1:$port"
import socket
import sys

with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as handle:
    handle.bind(("127.0.0.1", int(sys.argv[1])))
PY
}

start_managed() {
  local name="$1" working_directory="$2" executable="$3" stdout stderr pid
  shift 3
  started_process='false'
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
  started_process='true'
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
  local -a started=()
  local start_complete='false' index
  rollback_start() {
    if [[ "$start_complete" == 'false' ]]; then
      set +e
      for ((index=${#started[@]}-1; index>=0; index--)); do stop_managed "${started[$index]}"; done
    fi
  }
  trap rollback_start EXIT
  start_managed api "$project_root" "$runtime_node" "$project_root/services/platform-api/dist/main.js"
  [[ "$started_process" == 'false' ]] || started+=(api)
  start_managed ldap3 "$project_root/services/ldap3-gateway" "$runtime_gateway_python" \
    "$project_root/services/ldap3-gateway/ldap3_gateway.py"
  [[ "$started_process" == 'false' ]] || started+=(ldap3)
  wait_health '平台 API' "$api_health_uri"
  wait_health 'LDAP 网关' "$ldap_health_uri"
  if [[ "$code_agent_ready" == 'true' ]]; then
    start_managed worker "$project_root" "$runtime_node" "$project_root/scripts/evaluation-worker.mjs" \
      --api "$(env_value PLATFORM_API "http://$api_host:$api_port/api/v1")" \
      --employee "$(env_value EVALUATION_WORKER_EMPLOYEE_NO)" \
      --worker "$(env_value EVALUATION_WORKER_ID single-node-worker)" \
      --batch-root "$batch_root" --cache "$engine_cache_root"
    [[ "$started_process" == 'false' ]] || started+=(worker)
  else
    printf '%s\n' '已跳过评测 Worker：Code Agent 配置不可用，评测任务将留在队列中等待。' >&2
  fi
  local nginx_home
  nginx_home="$(cd "$(dirname "$runtime_nginx")/.." && pwd -P)"
  start_managed nginx "$nginx_home" "$runtime_nginx" -p "$nginx_home/" -c "$nginx_runtime_config"
  [[ "$started_process" == 'false' ]] || started+=(nginx)
  start_complete='true'
  trap - EXIT
  printf '单服务器平台已启动：http://127.0.0.1:%s/\n' "$listen_port"
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
  if command -v systemctl >/dev/null 2>&1 && systemctl is-enabled "$systemd_service_name" >/dev/null 2>&1; then
    printf '%s\n' '开机自启：已启用'
  else
    printf '%s\n' '开机自启：未安装'
  fi
}

run_privileged() {
  if ((EUID == 0)); then
    "$@"
  else
    command -v sudo >/dev/null 2>&1 || die '安装开机自启需要 sudo 权限'
    sudo "$@"
  fi
}

systemd_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//%/%%}"
  printf '%s' "$value"
}

register_system_service() {
  command -v systemctl >/dev/null 2>&1 || die '当前系统没有 systemd，无法安装开机自启'
  local service_user service_group service_home service_path environment_path project_path manager_path service_runtime path_value
  service_user="${SUDO_USER:-$(id -un)}"
  id "$service_user" >/dev/null 2>&1 || die "部署账号不存在：$service_user"
  service_group="$(id -gn "$service_user")"
  service_home="$(getent passwd "$service_user" | cut -d: -f6)"
  [[ -n "$service_home" ]] || service_home="$project_root"
  service_path="$(systemd_escape "$PATH")"
  environment_path="$(systemd_escape "$environment_file")"
  project_path="$(systemd_escape "$project_root")"
  manager_path="$(systemd_escape "$deploy_root/manage.sh")"
  service_runtime="$runtime_root/$systemd_service_name"

  {
    printf '%s\n' '[Unit]'
    printf '%s\n' 'Description=AI Training Platform'
    printf '%s\n' 'Wants=network-online.target'
    printf '%s\n' 'After=network-online.target postgresql.service'
    printf '\n%s\n' '[Service]'
    printf '%s\n' 'Type=oneshot'
    printf 'User=%s\n' "$service_user"
    printf 'Group=%s\n' "$service_group"
    printf 'WorkingDirectory="%s"\n' "$project_path"
    printf 'Environment="HOME=%s"\n' "$(systemd_escape "$service_home")"
    printf 'Environment="PATH=%s"\n' "$service_path"
    printf 'ExecStart="%s" Start --environment "%s"\n' "$manager_path" "$environment_path"
    printf 'ExecStop="%s" Stop --environment "%s"\n' "$manager_path" "$environment_path"
    printf '%s\n' 'RemainAfterExit=yes'
    printf '%s\n' 'TimeoutStartSec=180'
    printf '%s\n' 'TimeoutStopSec=60'
    printf '\n%s\n' '[Install]'
    printf '%s\n' 'WantedBy=multi-user.target'
  } >"$service_runtime"
  run_privileged chown -R "$service_user:$service_group" "$data_root" "$runtime_root" "$backup_root"
  run_privileged chown "$service_user:$service_group" "$environment_file"
  run_privileged install -m 0644 "$service_runtime" "$systemd_service_file"
  run_privileged systemctl daemon-reload
  run_privileged systemctl enable "$systemd_service_name"
  if ! run_privileged systemctl restart "$systemd_service_name"; then
    run_privileged systemctl disable --now "$systemd_service_name" >/dev/null 2>&1 || true
    die '平台服务启动失败，请执行 systemctl status ai-training-platform.service 查看原因'
  fi
}

unregister_system_service() {
  if command -v systemctl >/dev/null 2>&1; then
    run_privileged systemctl disable --now "$systemd_service_name" >/dev/null 2>&1 || true
    run_privileged rm -f -- "$systemd_service_file"
    run_privileged systemctl daemon-reload
    run_privileged systemctl reset-failed "$systemd_service_name" >/dev/null 2>&1 || true
  fi
}

install_platform() {
  ensure_layout
  assert_preflight
  stop_all
  deploy_database
  new_nginx_config
  register_system_service
  printf '安装完成，已启用开机自启：http://127.0.0.1:%s/\n' "$listen_port"
}

uninstall_platform() {
  unregister_system_service
  stop_all
  printf '%s\n' '平台服务已卸载；配置、数据库、交付件和备份均已保留。'
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
  Install) install_platform ;;
  Uninstall) uninstall_platform ;;
  Prepare) ensure_layout; assert_preflight; deploy_database; new_nginx_config; printf '%s\n' '单服务器部署检查通过' ;;
  Start) start_all ;;
  Stop) stop_all ;;
  Status) show_status ;;
  Backup) new_backup ;;
  Restore) restore_backup ;;
  Doctor) doctor ;;
esac
