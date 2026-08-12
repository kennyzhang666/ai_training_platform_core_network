#!/usr/bin/env bash
set -Eeuo pipefail

hotfix_version='@@VERSION@@'
script_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
project_root="$(realpath -m "${1:-/opt/ai-training}")"
environment_file="$(realpath -m "${2:-$project_root/deploy/single-node/.env}")"
payload_root="$script_root/payload"
manager="$project_root/deploy/single-node/manage.sh"

fail() { printf '热补丁失败：%s\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == 'Linux' ]] || fail '仅支持 Linux 单服务器部署'
[[ -f "$manager" && -x "$manager" ]] || fail "未找到部署管理脚本：$manager"
[[ -f "$environment_file" ]] || fail "未找到环境配置：$environment_file"
[[ -f "$script_root/SHA256SUMS" ]] || fail '热补丁校验清单缺失'
[[ -d "$payload_root/services/platform-api/dist" && -d "$payload_root/apps/web/dist" ]] || fail '热补丁构建产物不完整'

case "$project_root" in
  /|/opt|/usr|/var|/home) fail "拒绝使用过宽的平台目录：$project_root" ;;
esac
case "$environment_file" in
  "$project_root"/*) ;;
  *) fail '环境配置必须位于平台目录内' ;;
esac

(cd "$script_root" && sha256sum --check SHA256SUMS) || fail '文件校验失败，请重新下载热补丁'

installed_version="$($project_root/runtime/node/bin/node -p "require('$project_root/package.json').version" 2>/dev/null || true)"
case "$installed_version" in
  1.1.0|1.1.1|1.1.2|1.1.3) ;;
  *) fail "当前版本 $installed_version 不在本热补丁支持范围（1.1.0–1.1.3）" ;;
esac

stamp="$(date +%Y%m%d-%H%M%S)"
backup_root="$project_root/runtime-state/hotfix-backups/v${hotfix_version}-$stamp"
mkdir -p -- "$backup_root"
tar -C "$project_root" -czf "$backup_root/application-dist-before.tar.gz" \
  services/platform-api/dist apps/web/dist
cp -- "$project_root/package.json" "$backup_root/package.json.before"

rollback_required='false'
rollback() {
  local exit_code=$?
  if [[ "$rollback_required" == 'true' ]]; then
    set +e
    printf '%s\n' '应用失败，正在恢复原构建产物……' >&2
    "$manager" Stop --environment "$environment_file" >/dev/null 2>&1 || true
    rm -rf -- "$project_root/services/platform-api/dist" "$project_root/apps/web/dist"
    tar -C "$project_root" -xzf "$backup_root/application-dist-before.tar.gz"
    "$manager" Start --environment "$environment_file" || true
  fi
  exit "$exit_code"
}
trap rollback ERR

"$manager" Stop --environment "$environment_file"
rollback_required='true'
rm -rf -- "$project_root/services/platform-api/dist" "$project_root/apps/web/dist"
mkdir -p -- "$project_root/services/platform-api" "$project_root/apps/web"
cp -a -- "$payload_root/services/platform-api/dist" "$project_root/services/platform-api/dist"
cp -a -- "$payload_root/apps/web/dist" "$project_root/apps/web/dist"

mkdir -p -- "$project_root/runtime-state"
printf '{"version":"%s","appliedAt":"%s","previousVersion":"%s","backup":"%s"}\n' \
  "$hotfix_version" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$installed_version" "$backup_root" \
  >"$project_root/runtime-state/hotfix-version.json"

"$manager" Start --environment "$environment_file"
rollback_required='false'
trap - ERR

printf '\n热补丁 v%s 已应用。\n' "$hotfix_version"
printf '备份目录：%s\n' "$backup_root"
printf '状态文件：%s\n' "$project_root/runtime-state/hotfix-version.json"

