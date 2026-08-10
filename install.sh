#!/usr/bin/env bash
set -Eeuo pipefail

release_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
exec "$release_root/deploy/single-node/manage.sh" Install "$@"
