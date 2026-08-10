#!/usr/bin/env bash
set -Eeuo pipefail

action="${1:-}"
case "$action" in
  Prepare|Doctor|Start|Stop|Status|Logs) ;;
  *) printf '用法：%s {Prepare|Doctor|Start|Stop|Status|Logs}\n' "$0" >&2; exit 2 ;;
esac

deploy_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
compose_file="$deploy_root/compose.yaml"
environment_file="$deploy_root/.env"
image_bundle="$deploy_root/docker-images.tar.gz"

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

compose() {
  docker compose --project-directory "$deploy_root" --env-file "$environment_file" -f "$compose_file" "$@"
}

read_env() {
  local name="$1" line value
  line="$(grep -m1 -E "^${name}=" "$environment_file" 2>/dev/null || true)"
  value="${line#*=}"
  value="${value%$'\r'}"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then value="${value:1:${#value}-2}"; fi
  if [[ "$value" == \'*\' && "$value" == *\' ]]; then value="${value:1:${#value}-2}"; fi
  printf '%s' "$value"
}

random_hex_32() {
  od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
}

replace_token() {
  local token="$1" value="$2"
  sed -i "s|$token|$value|g" "$environment_file"
}

prepare() {
  mkdir -p "$deploy_root/code-agent/bin" "$deploy_root/certs" "$deploy_root/backups" "$deploy_root/wheelhouse"
  if [[ -f "$environment_file" ]]; then
    chmod 600 "$environment_file"
    printf '配置文件已存在，未覆盖：%s\n' "$environment_file"
    return
  fi
  cp -- "$deploy_root/.env.example" "$environment_file"
  replace_token '__GENERATE_POSTGRES_PASSWORD__' "$(random_hex_32)"
  replace_token '__GENERATE_TRUSTED_SECRET__' "$(random_hex_32)"
  replace_token '__GENERATE_SESSION_SECRET__' "$(random_hex_32)"
  chmod 600 "$environment_file"
  printf '已生成配置：%s\n' "$environment_file"
  printf '%s\n' '请填写管理员、LDAP 和 Code Agent 项，再执行 ./manage.sh Doctor。'
}

assert_tools() {
  command -v docker >/dev/null 2>&1 || die '找不到 Docker，请先安装 Docker Engine。'
  docker compose version >/dev/null 2>&1 || die '找不到 Docker Compose v2 插件。'
  docker info >/dev/null 2>&1 || die 'Docker 服务不可用，或当前账号没有访问权限。'
}

assert_configuration() {
  [[ -f "$environment_file" ]] || die '配置文件不存在，请先执行 ./manage.sh Prepare。'
  if grep -nE '__GENERATE_[A-Z_]+__|=<[^>]+>' "$environment_file" >/dev/null; then
    die "配置仍有未填写项：$environment_file"
  fi
  local name value trusted_secret session_secret postgres_password platform_port
  for name in \
    AI_TRAINING_IMAGE POSTGRES_IMAGE POSTGRES_PASSWORD \
    TRUSTED_GATEWAY_HMAC_SECRET LDAP_GATEWAY_SESSION_SECRET \
    PLATFORM_BOOTSTRAP_GLOBAL_ADMIN_EMPLOYEE_NO LDAP_SERVER LDAP_BASE_DN \
    EVALUATION_WORKER_EMPLOYEE_NO EVALUATION_WORKER_NAME \
    CODE_AGENT_BUNDLE_PATH CODE_AGENT_COMMAND CODE_AGENT_ARGS_JSON CODE_AGENT_ALLOWED_EXECUTABLES ENGINE_WHEELHOUSE_PATH; do
    value="$(read_env "$name")"
    [[ -n "$value" ]] || die "缺少配置：$name"
  done
  trusted_secret="$(read_env TRUSTED_GATEWAY_HMAC_SECRET)"
  session_secret="$(read_env LDAP_GATEWAY_SESSION_SECRET)"
  postgres_password="$(read_env POSTGRES_PASSWORD)"
  platform_port="$(read_env PLATFORM_PORT)"
  [[ ${#trusted_secret} -ge 32 ]] || die 'TRUSTED_GATEWAY_HMAC_SECRET 至少需要 32 个字符。'
  [[ ${#session_secret} -ge 32 ]] || die 'LDAP_GATEWAY_SESSION_SECRET 至少需要 32 个字符。'
  [[ "$trusted_secret" != "$session_secret" ]] || die '两条平台密钥不能相同。'
  [[ ${#postgres_password} -ge 16 ]] || die 'POSTGRES_PASSWORD 至少需要 16 个字符。'
  [[ "$platform_port" =~ ^[0-9]+$ ]] && ((10#$platform_port >= 1 && 10#$platform_port <= 65535)) \
    || die 'PLATFORM_PORT 必须是 1–65535 之间的端口。'
}

assert_code_agent() {
  local bundle command relative bundle_path executable
  bundle="$(read_env CODE_AGENT_BUNDLE_PATH)"
  command="$(read_env CODE_AGENT_COMMAND)"
  [[ "$command" == /opt/code-agent/* ]] || die 'CODE_AGENT_COMMAND 必须位于容器内 /opt/code-agent/。'
  if [[ "$bundle" == /* ]]; then bundle_path="$(realpath -m "$bundle")"; else bundle_path="$(realpath -m "$deploy_root/$bundle")"; fi
  case "$bundle_path" in
    "$deploy_root"/*) ;;
    *) die 'CODE_AGENT_BUNDLE_PATH 必须位于 Docker 部署目录内。' ;;
  esac
  relative="${command#/opt/code-agent/}"
  executable="$(realpath -m "$bundle_path/$relative")"
  case "$executable" in
    "$bundle_path"/*) ;;
    *) die 'CODE_AGENT_COMMAND 超出 Code Agent 只读目录。' ;;
  esac
  [[ -f "$executable" && -x "$executable" ]] || die "Code Agent 不存在或不可执行：$executable"
}

assert_wheelhouse() {
  local configured wheelhouse_path
  configured="$(read_env ENGINE_WHEELHOUSE_PATH)"
  if [[ "$configured" == /* ]]; then wheelhouse_path="$(realpath -m "$configured")"; else wheelhouse_path="$(realpath -m "$deploy_root/$configured")"; fi
  case "$wheelhouse_path" in
    "$deploy_root"/*) ;;
    *) die 'ENGINE_WHEELHOUSE_PATH 必须位于 Docker 部署目录内。' ;;
  esac
  [[ -d "$wheelhouse_path" ]] || die "赛题引擎离线依赖目录不存在：$wheelhouse_path"
}

doctor() {
  assert_tools
  assert_configuration
  assert_code_agent
  assert_wheelhouse
  compose config --quiet
  printf '%s\n' 'Docker 部署检查通过'
}

load_or_pull_images() {
  local app_image postgres_image
  app_image="$(read_env AI_TRAINING_IMAGE)"
  postgres_image="$(read_env POSTGRES_IMAGE)"
  if [[ -f "$image_bundle" ]] \
    && { ! docker image inspect "$app_image" >/dev/null 2>&1 || ! docker image inspect "$postgres_image" >/dev/null 2>&1; }; then
    printf '%s\n' '正在载入离线镜像……'
    gzip -dc "$image_bundle" | docker load >/dev/null
  fi
  if ! docker image inspect "$app_image" >/dev/null 2>&1 || ! docker image inspect "$postgres_image" >/dev/null 2>&1; then
    printf '%s\n' '本机缺少镜像，正在从镜像仓库拉取……'
    compose pull
  fi
}

start() {
  doctor
  load_or_pull_images
  compose up -d --wait --wait-timeout 240
  printf '平台已启动：http://127.0.0.1:%s/\n' "$(read_env PLATFORM_PORT)"
}

case "$action" in
  Prepare) prepare ;;
  Doctor) doctor ;;
  Start) start ;;
  Stop)
    [[ -f "$environment_file" ]] || die '配置文件不存在。'
    compose down
    ;;
  Status)
    [[ -f "$environment_file" ]] || die '配置文件不存在。'
    compose ps
    ;;
  Logs)
    [[ -f "$environment_file" ]] || die '配置文件不存在。'
    compose logs --tail 200 -f
    ;;
esac
