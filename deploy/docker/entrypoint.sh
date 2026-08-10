#!/usr/bin/env bash
set -Eeuo pipefail

role="${1:-web}"
if (($#)); then shift; fi

platform_home="${PLATFORM_HOME:-/opt/ai-training}"
state_root="/var/lib/ai-training"

require_value() {
  local name="$1"
  [[ -n "${!name:-}" ]] || { printf '缺少容器配置：%s\n' "$name" >&2; exit 1; }
}

case "$role" in
  init)
    [[ "$(id -u)" == '0' ]] || { printf '%s\n' '初始化容器必须以 root 运行' >&2; exit 1; }
    mkdir -p \
      "$state_root/artifacts" \
      "$state_root/artifact-uploads" \
      "$state_root/engine-packages" \
      "$state_root/evaluation-batches" \
      "$state_root/evaluation-logs" \
      "$state_root/pip-cache" \
      "$state_root/worker-engines"
    chown -R 10001:10001 "$state_root"
    chmod 0750 "$state_root"
    ;;

  api)
    require_value DATABASE_URL
    require_value TRUSTED_GATEWAY_HMAC_SECRET
    cd "$platform_home/services/platform-api"
    node node_modules/prisma/build/index.js migrate deploy --schema prisma/schema.prisma
    exec node dist/main.js "$@"
    ;;

  worker)
    require_value PLATFORM_API
    require_value EVALUATION_WORKER_EMPLOYEE_NO
    require_value EVALUATION_WORKER_NAME
    require_value EVALUATION_WORKER_TRUSTED_GATEWAY_SECRET
    require_value CODE_AGENT_COMMAND
    node "$platform_home/scripts/evaluation-worker.mjs" --check-config
    exec node "$platform_home/scripts/evaluation-worker.mjs" \
      --api "$PLATFORM_API" \
      --employee "$EVALUATION_WORKER_EMPLOYEE_NO" \
      --worker "${EVALUATION_WORKER_ID:-docker-worker-01}" \
      --batch-root "${EVALUATION_BATCH_ROOT:-$state_root/evaluation-batches}" \
      --log-root "${EVALUATION_LOG_ROOT:-$state_root/evaluation-logs}" \
      --cache "${ENGINE_CACHE_ROOT:-$state_root/worker-engines}" \
      "$@"
    ;;

  gateway)
    require_value TRUSTED_GATEWAY_HMAC_SECRET
    require_value LDAP_GATEWAY_SESSION_SECRET
    require_value LDAP_SERVER
    require_value LDAP_BASE_DN
    cd "$platform_home/services/ldap3-gateway"
    exec python3 ldap3_gateway.py "$@"
    ;;

  web)
    mkdir -p /tmp/nginx/client /tmp/nginx/proxy /tmp/nginx/fastcgi /tmp/nginx/uwsgi /tmp/nginx/scgi
    exec nginx -c "$platform_home/deploy/docker/nginx.conf" -g 'daemon off;' "$@"
    ;;

  *)
    printf '不支持的容器角色：%s\n' "$role" >&2
    exit 2
    ;;
esac

