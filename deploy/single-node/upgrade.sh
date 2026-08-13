#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
用法：upgrade.sh --install-root PATH [--environment PATH] [--recovery-root PATH] [--drain-timeout SEC] [--check-only]

从已经解压并校验过的 Linux x64 完整离线包升级现有单服务器部署。
EOF
  exit 2
}

die() {
  printf '离线升级失败：%s\n' "$*" >&2
  return 1
}

install_root_input=''
environment_input=''
recovery_root_input=''
drain_timeout='900'
check_only='false'
while (($#)); do
  case "$1" in
    --install-root)
      [[ $# -ge 2 ]] || usage
      install_root_input="$2"
      shift 2
      ;;
    --environment)
      [[ $# -ge 2 ]] || usage
      environment_input="$2"
      shift 2
      ;;
    --recovery-root)
      [[ $# -ge 2 ]] || usage
      recovery_root_input="$2"
      shift 2
      ;;
    --drain-timeout)
      [[ $# -ge 2 ]] || usage
      drain_timeout="$2"
      shift 2
      ;;
    --check-only)
      check_only='true'
      shift
      ;;
    -h|--help) usage ;;
    *) printf '未知参数：%s\n' "$1" >&2; usage ;;
  esac
done

[[ -n "$install_root_input" ]] || usage
[[ "$drain_timeout" =~ ^[0-9]+$ ]] && ((10#$drain_timeout >= 1 && 10#$drain_timeout <= 86400)) \
  || die '--drain-timeout 必须是 1–86400 之间的秒数'
[[ "$(uname -s)" == 'Linux' ]] || die '只支持 Linux 单服务器离线包'
case "$(uname -m)" in
  x86_64|amd64) ;;
  *) die "只支持 Linux x64，当前架构为 $(uname -m)" ;;
esac
((EUID == 0)) || die '请使用 sudo 或 root 执行全自动升级'

for command in realpath flock stat cp mv mkdir chmod chown find du df awk; do
  command -v "$command" >/dev/null 2>&1 || die "缺少系统命令：$command"
done

deploy_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
release_root="$(cd "$deploy_root/../.." && pwd -P)"
helper="$release_root/scripts/offline-upgrade-helper.py"
package_python="$release_root/runtime/python/bin/python3"
export PYTHONDONTWRITEBYTECODE=1
[[ -f "$helper" ]] || die "完整离线包缺少升级辅助工具：$helper"
[[ -x "$package_python" ]] || die "完整离线包缺少可执行 Python：$package_python"

[[ ! -L "$install_root_input" ]] || die '现有安装根目录不能是符号链接'
install_root="$(realpath -e "$install_root_input" 2>/dev/null || true)"
[[ -n "$install_root" && -d "$install_root" ]] || die "现有安装根目录不存在：$install_root_input"
case "$install_root" in
  /|/bin|/boot|/dev|/etc|/home|/opt|/proc|/root|/run|/srv|/sys|/tmp|/usr|/var) die "拒绝使用过宽的安装根目录：$install_root" ;;
esac

install_parent="$(dirname "$install_root")"
install_name="$(basename "$install_root")"
environment_file="${environment_input:-$install_root/deploy/single-node/.env}"
environment_file="$(realpath -e "$environment_file" 2>/dev/null || true)"
[[ -n "$environment_file" && -f "$environment_file" ]] || die '现有环境配置不存在'
case "$environment_file" in
  "$install_root"/*) ;;
  *) die '环境配置必须位于现有安装根目录内' ;;
esac
environment_relative="${environment_file#"$install_root"/}"

layout="$($package_python "$helper" environment-layout --environment-file "$environment_file" --install-root "$install_root")"
mapfile -t layout_values < <(
  "$package_python" -c 'import json,sys; v=json.loads(sys.argv[1]); print(v["dataRelative"]); print(v["backupRelative"]); print(v["runtimeRelative"]); print(v["apiHost"]); print(v["apiPort"]); print(v["ldapHost"]); print(v["ldapPort"]); print(v["listenPort"])' "$layout"
)
[[ ${#layout_values[@]} -eq 8 ]] || die '无法解析现有环境目录布局'
data_relative="${layout_values[0]}"
backup_relative="${layout_values[1]}"
runtime_relative="${layout_values[2]}"
api_host="${layout_values[3]}"
api_port="${layout_values[4]}"
ldap_host="${layout_values[5]}"
ldap_port="${layout_values[6]}"
listen_port="${layout_values[7]}"
data_root="$install_root/$data_relative"
history_backup_root="$install_root/$backup_relative"
runtime_root="$install_root/$runtime_relative"
[[ -d "$data_root" && ! -L "$data_root" ]] || die "现有持久数据目录不存在或是符号链接：$data_root"
[[ -d "$history_backup_root" && ! -L "$history_backup_root" ]] || die "现有历史备份目录不存在或是符号链接：$history_backup_root"
[[ -d "$runtime_root" && ! -L "$runtime_root" ]] || die "现有运行状态目录不存在或是符号链接：$runtime_root"

old_manager="$install_root/deploy/single-node/manage.sh"
[[ -f "$old_manager" && -x "$old_manager" ]] || die "现有部署管理器不存在或不可执行：$old_manager"
[[ -f "$install_root/VERSION" ]] || die '现有安装缺少 VERSION'

paths_overlap() {
  local left="$1" right="$2"
  [[ "$left" == "$right" || "$left" == "$right"/* || "$right" == "$left"/* ]]
}

paths_overlap "$release_root" "$install_root" && die '新版本包与现有安装根目录不能重叠'

recovery_root="${recovery_root_input:-$install_parent/${install_name}-upgrade-recovery}"
recovery_root="$(realpath -m "$recovery_root")"
case "$recovery_root" in
  /|/bin|/boot|/dev|/etc|/home|/opt|/proc|/root|/run|/srv|/sys|/tmp|/usr|/var) die "拒绝使用过宽的恢复目录：$recovery_root" ;;
esac
paths_overlap "$recovery_root" "$install_root" && die '恢复目录不能位于现有安装目录内，也不能包含现有安装目录'
paths_overlap "$recovery_root" "$release_root" && die '恢复目录不能与新版本包重叠'

lock_file="$install_parent/.${install_name}.upgrade.lock"
exec 9>"$lock_file"
flock -n 9 || die '另一个平台升级正在进行'

printf '%s\n' '[1/8] 校验新版本完整包、来源版本和数据库恢复工具……'
verification="$($package_python "$helper" verify-release --release-root "$release_root" --source-root "$install_root")"
read -r release_target source_version target_version < <(
  "$package_python" -c 'import json,sys; v=json.loads(sys.argv[1]); print(v["target"],v["sourceVersion"],v["targetVersion"])' "$verification"
)
[[ "$release_target" == 'linux-x64' ]] || die "升级包目标平台不是 linux-x64：$release_target"
"$package_python" "$helper" database-check --environment-file "$environment_file" >/dev/null

install_device="$(stat -c '%d' "$install_parent")"

service_name='ai-training-platform.service'
systemd_available='false'
old_systemd_active='false'
old_systemd_enabled='false'
old_systemd_failed='false'
systemd_fallback_used='false'
if command -v systemctl >/dev/null 2>&1 && systemctl cat "$service_name" >/dev/null 2>&1; then
  systemd_available='true'
  systemctl is-active --quiet "$service_name" && old_systemd_active='true'
  systemctl is-enabled --quiet "$service_name" && old_systemd_enabled='true'
  systemctl is-failed --quiet "$service_name" && old_systemd_failed='true'
else
  printf '%s\n' '警告：systemd 或平台单元不可用；升级器将在需要时以 root 直接管理业务进程。' >&2
fi
service_user="root"
service_group="root"
if [[ "$systemd_available" == 'true' ]]; then
  service_user="$(systemctl show "$service_name" --property User --value 2>/dev/null || true)"
  service_group="$(systemctl show "$service_name" --property Group --value 2>/dev/null || true)"
fi
service_user="${service_user:-root}"
service_group="${service_group:-$(id -gn "$service_user")}"
id "$service_user" >/dev/null 2>&1 || die "systemd 服务账号不存在：$service_user"
old_status="$($old_manager Status --environment "$environment_file" 2>/dev/null || true)"
running_count="$(printf '%s\n' "$old_status" | awk '$2 == "运行中" { count += 1 } END { print count + 0 }')"
old_processes_running='false'
[[ "$running_count" == '4' ]] && old_processes_running='true'
if [[ "$running_count" != '0' && "$running_count" != '4' ]]; then
  if [[ "$old_systemd_active" == 'true' || "$old_systemd_failed" == 'true' ]]; then
    printf '%s\n' '警告：systemd 单元异常且平台进程不完整；将由 root 清理残留并在升级后直接恢复业务进程。' >&2
    old_processes_running='true'
    systemd_fallback_used='true'
  else
    die '现有平台处于部分运行状态，请先恢复为全部运行或全部停止'
  fi
elif [[ "$old_processes_running" == 'false' && ( "$old_systemd_active" == 'true' || "$old_systemd_failed" == 'true' ) ]]; then
  printf '%s\n' '警告：systemd 单元异常且没有完整业务进程；升级后将由 root 直接恢复业务进程。' >&2
  old_processes_running='true'
  systemd_fallback_used='true'
fi

active_evaluations="$($package_python "$helper" database-active-evaluations --environment-file "$environment_file")"
[[ "$active_evaluations" =~ ^[0-9]+$ ]] || die '无法确认运行中评测数量'
database_bytes="$($package_python "$helper" database-size --environment-file "$environment_file")"
[[ "$database_bytes" =~ ^[0-9]+$ ]] || die '无法确认数据库占用空间'
package_bytes="$(du -sb -- "$release_root" | awk '{print $1}')"
data_bytes="$(du -sb -- "$data_root" | awk '{print $1}')"
[[ "$package_bytes" =~ ^[0-9]+$ && "$data_bytes" =~ ^[0-9]+$ ]] || die '无法确认升级所需磁盘空间'
recovery_probe="$recovery_root"
while [[ ! -e "$recovery_probe" ]]; do recovery_probe="$(dirname "$recovery_probe")"; done
install_available="$(df -PB1 -- "$install_parent" | awk 'NR == 2 {print $4}')"
recovery_available="$(df -PB1 -- "$recovery_probe" | awk 'NR == 2 {print $4}')"
reserve_bytes=$((1024 * 1024 * 1024))
stage_required=$((10#$package_bytes + reserve_bytes))
recovery_required=$((10#$data_bytes + 2 * 10#$database_bytes + reserve_bytes))
if [[ "$(stat -c '%d' "$install_parent")" == "$(stat -c '%d' "$recovery_probe")" ]]; then
  ((10#$install_available >= stage_required + recovery_required)) || die '安装卷空间不足，无法同时暂存新版本和升级恢复点'
else
  ((10#$install_available >= stage_required)) || die '安装卷空间不足，无法暂存新版本'
  ((10#$recovery_available >= recovery_required)) || die '恢复卷空间不足，无法创建完整升级恢复点'
fi

if [[ "$check_only" == 'true' ]]; then
  printf '升级预检通过：v%s -> v%s；当前运行中评测 %s 个（不会修改服务、配置、数据库或数据目录）\n' "$source_version" "$target_version" "$active_evaluations"
  exit 0
fi

stamp="$(date +%Y%m%d-%H%M%S)-$$"
stage_root="$install_parent/.${install_name}.upgrade-stage-v${target_version}-$stamp"
previous_root="$install_parent/${install_name}.previous-v${source_version}-$stamp"
failed_root="$install_parent/${install_name}.failed-v${target_version}-$stamp"
transaction_root="$recovery_root/v${source_version}-to-v${target_version}-$stamp"
platform_backup="$transaction_root/platform-backup.tar.gz"
database_backup="$transaction_root/database-before-upgrade.dump"
state_file="$transaction_root/upgrade-state.json"

for path in "$stage_root" "$previous_root" "$failed_root" "$transaction_root"; do
  [[ ! -e "$path" ]] || die "升级事务路径已经存在，拒绝覆盖：$path"
done
[[ "$(stat -c '%d' "$install_parent")" == "$install_device" ]] || die '无法确认安装父目录所在文件系统'

mkdir -p -- "$transaction_root"
chmod 700 -- "$recovery_root" "$transaction_root"

phase='CHECKED'
switched='false'
database_backup_ready='false'
database_mutated='false'
rollback_running='false'

write_state() {
  local temporary="$state_file.tmp"
  "$package_python" - "$temporary" "$phase" "$source_version" "$target_version" \
    "$install_root" "$stage_root" "$previous_root" "$failed_root" "$old_systemd_active" "$old_systemd_enabled" <<'PY'
import json
from pathlib import Path
import sys

target = Path(sys.argv[1])
payload = {
    "phase": sys.argv[2],
    "sourceVersion": sys.argv[3],
    "targetVersion": sys.argv[4],
    "installRoot": sys.argv[5],
    "stageRoot": sys.argv[6],
    "previousRoot": sys.argv[7],
    "failedRoot": sys.argv[8],
    "systemdWasActive": sys.argv[9] == "true",
    "systemdWasEnabled": sys.argv[10] == "true",
}
target.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY
  mv -- "$temporary" "$state_file"
  chmod 600 -- "$state_file"
}

restore_enabled_state() {
  [[ "$systemd_available" == 'true' ]] || return 0
  if [[ "$old_systemd_enabled" == 'true' ]]; then
    systemctl enable "$service_name" >/dev/null 2>&1 || {
      printf '%s\n' '警告：无法恢复 systemd 启用状态；业务进程仍可由 root 兜底启动。' >&2
      systemd_fallback_used='true'
    }
  else
    systemctl disable "$service_name" >/dev/null 2>&1 || {
      printf '%s\n' '警告：无法恢复 systemd 禁用状态；业务进程仍可由 root 兜底启动。' >&2
      systemd_fallback_used='true'
    }
  fi
}

managed_running_count() {
  local manager="$1" environment="$2" output
  output="$($manager Status --environment "$environment" 2>/dev/null || true)"
  printf '%s\n' "$output" | awk '$2 == "运行中" { count += 1 } END { print count + 0 }'
}

stop_platform() {
  local manager="$1" environment="$2"
  if [[ "$systemd_available" == 'true' ]] && ! systemctl stop "$service_name"; then
    printf '%s\n' '警告：systemd 停止失败，改由 root 直接清理受管业务进程。' >&2
    systemd_fallback_used='true'
  fi
  "$manager" Stop --environment "$environment"
}

start_platform() {
  local manager="$1" environment="$2" attempt count
  if [[ "$systemd_available" == 'true' ]] && systemctl start "$service_name"; then
    for attempt in {1..20}; do
      count="$(managed_running_count "$manager" "$environment")"
      [[ "$count" == '4' ]] && return 0
      sleep 0.5
    done
    printf '%s\n' '警告：systemd 返回成功但平台未完整启动，改由 root 直接拉起业务进程。' >&2
  else
    printf '%s\n' '警告：systemd 启动失败或不可用，改由 root 直接拉起业务进程。' >&2
  fi
  systemd_fallback_used='true'
  "$manager" Stop --environment "$environment" >/dev/null 2>&1 || true
  "$manager" Start --environment "$environment"
  [[ "$(managed_running_count "$manager" "$environment")" == '4' ]] \
    || die 'root 兜底启动后仍未完整拉起四个业务进程'
  chown -R -- "$service_user:$service_group" \
    "$install_root/$data_relative" "$install_root/$backup_relative" "$install_root/$runtime_relative"
}

restore_running_state() {
  local manager="$install_root/deploy/single-node/manage.sh"
  local restored_environment="$install_root/$environment_relative"
  if [[ "$old_processes_running" == 'true' ]]; then
    start_platform "$manager" "$restored_environment"
  else
    stop_platform "$manager" "$restored_environment"
  fi
}

move_persistent_back_from() {
  local source_root="$1"
  local relative
  for relative in "$data_relative" "$backup_relative"; do
    if [[ -e "$source_root/$relative" && ! -e "$install_root/$relative" ]]; then
      mkdir -p -- "$(dirname "$install_root/$relative")"
      mv -- "$source_root/$relative" "$install_root/$relative"
    fi
  done
}

remove_package_placeholder() {
  local path="$1" entry
  [[ -e "$path" ]] || return 0
  [[ -d "$path" && ! -L "$path" ]] || die "新版本持久目录占位路径不是普通目录：$path"
  while IFS= read -r -d '' entry; do
    if [[ -d "$entry" && ! -L "$entry" ]]; then
      continue
    fi
    if [[ -f "$entry" && ! -L "$entry" && "$(basename "$entry")" == '.keep' ]]; then
      continue
    fi
    die "新版本持久目录占位路径包含非占位内容：$path"
  done < <(find "$path" -mindepth 1 -print0)
  rm -rf -- "$path"
}

wait_for_evaluations() {
  local deadline count now
  deadline=$(( $(date +%s) + 10#$drain_timeout ))
  while true; do
    count="$($package_python "$helper" database-active-evaluations --environment-file "$environment_file")"
    [[ "$count" =~ ^[0-9]+$ ]] || die '无法确认运行中评测数量'
    if ((10#$count == 0)); then
      return 0
    fi
    now="$(date +%s)"
    ((now < deadline)) || die "等待运行中评测结束超时，仍有 $count 个运行任务"
    printf '仍有 %s 个评测运行中，等待完成后再停服……\n' "$count"
    sleep 5
  done
}

rollback_upgrade() {
  local original_exit="${1:-1}" rollback_failed='false' candidate_manager
  [[ "$rollback_running" == 'false' ]] || exit "$original_exit"
  rollback_running='true'
  trap - ERR INT TERM
  set +e
  phase='ROLLING_BACK'
  write_state || rollback_failed='true'
  printf '%s\n' '升级未完成，正在恢复旧版本……' >&2

  if [[ -d "$install_root" && -x "$install_root/deploy/single-node/manage.sh" ]]; then
    stop_platform "$install_root/deploy/single-node/manage.sh" "$install_root/$environment_relative" >/dev/null 2>&1 || true
  fi

  if [[ "$switched" == 'true' ]]; then
    if [[ -e "$failed_root" ]]; then
      printf '无法保留失败版本，目标已存在：%s\n' "$failed_root" >&2
      rollback_failed='true'
    elif [[ -d "$install_root" ]]; then
      mv -- "$install_root" "$failed_root" || rollback_failed='true'
    fi
    if [[ ! -d "$install_root" && -d "$previous_root" ]]; then
      mv -- "$previous_root" "$install_root" || rollback_failed='true'
    fi
    [[ -d "$install_root" && -d "$failed_root" ]] && move_persistent_back_from "$failed_root" || true
  else
    if [[ ! -d "$install_root" && -d "$previous_root" ]]; then
      mv -- "$previous_root" "$install_root" || rollback_failed='true'
    fi
    [[ -d "$install_root" && -d "$stage_root" ]] && move_persistent_back_from "$stage_root" || true
  fi

  if [[ "$database_backup_ready" == 'true' && "$database_mutated" == 'true' && -f "$database_backup" && -f "$install_root/$environment_relative" ]]; then
    "$package_python" "$helper" database-restore \
      --environment-file "$install_root/$environment_relative" --source "$database_backup" --confirm \
      || rollback_failed='true'
  fi

  if [[ -d "$install_root" && -x "$install_root/deploy/single-node/manage.sh" ]]; then
    restore_enabled_state || rollback_failed='true'
    restore_running_state || rollback_failed='true'
  else
    rollback_failed='true'
  fi

  if [[ "$rollback_failed" == 'true' ]]; then
    phase='ROLLBACK_FAILED'
    write_state || true
    printf '自动回滚未完整完成。请保留并检查：%s\n' "$transaction_root" >&2
    exit 70
  fi
  phase='ROLLED_BACK'
  write_state || true
  printf '旧版本已恢复。恢复材料：%s\n' "$transaction_root" >&2
  exit "$original_exit"
}

trap 'rollback_upgrade $?' ERR
trap 'rollback_upgrade 130' INT
trap 'rollback_upgrade 143' TERM

write_state

printf '%s\n' '[2/8] 将新完整包复制到安装目录同一文件系统的事务目录……'
mkdir -- "$stage_root"
cp -a -- "$release_root/." "$stage_root/"
[[ "$(stat -c '%d' "$stage_root")" == "$install_device" ]] || die '新版本事务目录与现有安装不在同一文件系统'
"$package_python" "$helper" verify-release --release-root "$stage_root" --source-root "$install_root" >/dev/null
phase='STAGED'
write_state

printf '%s\n' '[3/8] 停止旧服务并创建平台一致性备份……'
wait_for_evaluations
stop_platform "$old_manager" "$environment_file"
remaining="$($package_python "$helper" database-active-evaluations --environment-file "$environment_file")"
if [[ "$remaining" != '0' ]]; then
  printf '%s\n' '停服竞态中出现新的运行任务，恢复旧服务并再次排空……'
  start_platform "$old_manager" "$environment_file"
  wait_for_evaluations
  stop_platform "$old_manager" "$environment_file"
  remaining="$($package_python "$helper" database-active-evaluations --environment-file "$environment_file")"
  [[ "$remaining" == '0' ]] || die '停服后仍存在运行中评测，拒绝继续升级'
fi
"$old_manager" Backup --environment "$environment_file" --archive "$platform_backup"
[[ -s "$platform_backup" ]] || die '平台一致性备份没有生成'
phase='PLATFORM_BACKED_UP'
write_state

printf '%s\n' '[4/8] 保留原配置并创建 PostgreSQL 原生恢复点……'
mkdir -p -- "$(dirname "$stage_root/$environment_relative")"
cp -a -- "$environment_file" "$stage_root/$environment_relative"
[[ "$(stat -c '%u:%g:%a' "$environment_file")" == "$(stat -c '%u:%g:%a' "$stage_root/$environment_relative")" ]] \
  || die '复制后的环境配置权限或属主发生变化'
"$package_python" "$helper" database-backup --environment-file "$environment_file" --output "$database_backup"
[[ -s "$database_backup" && -s "$database_backup.sha256" ]] || die 'PostgreSQL 原生恢复点没有生成'
database_backup_ready='true'
phase='DATABASE_BACKED_UP'
write_state

printf '%s\n' '[5/8] 转移持久数据并切换到新版本……'
for relative in "$data_relative" "$backup_relative"; do
  [[ -d "$install_root/$relative" && ! -L "$install_root/$relative" ]] || die "现有安装缺少普通持久目录：$relative"
  case "$stage_root/$relative" in "$stage_root"/*) ;; *) die '内部路径校验失败' ;; esac
  remove_package_placeholder "$stage_root/$relative"
  mkdir -p -- "$(dirname "$stage_root/$relative")"
  mv -- "$install_root/$relative" "$stage_root/$relative"
done
phase='PERSISTENT_MOVED'
write_state

mv -- "$install_root" "$previous_root"
mv -- "$stage_root" "$install_root"
switched='true'
phase='SWITCHED'
write_state

new_manager="$install_root/deploy/single-node/manage.sh"
new_environment="$install_root/$environment_relative"
[[ -x "$new_manager" && -f "$new_environment" ]] || die '切换后的新版本缺少部署管理器或环境配置'

printf '%s\n' '[6/8] 部署数据库迁移并启动新版本……'
database_mutated='true'
"$new_manager" Prepare --environment "$new_environment"
phase='MIGRATED'
write_state
chown -R -- "$service_user:$service_group" \
  "$install_root/$data_relative" "$install_root/$backup_relative" "$install_root/$runtime_relative"
start_platform "$new_manager" "$new_environment"
phase='STARTED'
write_state

printf '%s\n' '[7/8] 执行部署检查和三层健康检查……'
"$new_manager" Doctor --environment "$new_environment"

node_executable="$install_root/runtime/node/bin/node"
[[ -x "$node_executable" ]] || die '切换后的 Node.js 运行时不可执行'

wait_http() {
  local label="$1" uri="$2" mode="$3" attempt
  for attempt in {1..40}; do
    if "$node_executable" -e '
const [uri, mode] = process.argv.slice(1);
fetch(uri, { redirect: "manual" })
  .then((response) => process.exit(mode === "entry" ? (response.status >= 200 && response.status < 400 ? 0 : 1) : (response.ok ? 0 : 1)))
  .catch(() => process.exit(1));
' "$uri" "$mode"; then
      return 0
    fi
    sleep 0.5
  done
  die "$label 健康检查失败：$uri"
}

wait_http '平台 API' "http://$api_host:$api_port/api/v1/health" service
wait_http 'LDAP 网关' "http://$ldap_host:$ldap_port/healthz" service
wait_http '平台入口' "http://127.0.0.1:$listen_port/" entry

if [[ "$old_processes_running" == 'false' ]]; then
  stop_platform "$new_manager" "$new_environment"
fi
restore_enabled_state

phase='COMPLETED'
write_state
trap - ERR INT TERM

printf '%s\n' '[8/8] 离线升级完成。'
printf '平台版本：v%s -> v%s\n' "$source_version" "$target_version"
printf '旧版本目录：%s\n' "$previous_root"
printf '恢复材料目录：%s\n' "$transaction_root"
if [[ "$systemd_fallback_used" == 'true' ]]; then
  printf '%s\n' '启动方式：systemd 异常，当前业务进程由 root 直接拉起；请后续修复 systemd 单元。'
else
  printf '%s\n' '启动方式：systemd'
fi
printf '%s\n' '旧版本与恢复材料均已保留，请在完成业务验收后按运维流程人工归档。'
