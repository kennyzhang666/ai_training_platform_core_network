#!/usr/bin/env bash
set -euo pipefail

NODE_VERSION='22.23.2'
NODE_SHA256='d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307'
PYTHON_VERSION='3.11.15'
PYTHON_BUILD='20260718'
PYTHON_SHA256='23ccae6f1ff73e8aa8378436f869da003b8eb7d6c95f2bc706f494115ba1447d'
NGINX_VERSION='1.30.4'
NGINX_SHA256='4261dc90e9e47c1c4041276e9aaa3d48ebe2e664f728e14fa95ae6c67d57a08b'

runtime_root=''
wheelhouse_root=''
source_root=''

usage() {
  cat <<'EOF'
Usage: prepare-linux-release-runtime.sh \
  --runtime-root <empty-output-directory> \
  --wheelhouse <empty-output-directory> \
  --source-root <tagged-source-directory>
EOF
}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

while (($#)); do
  case "$1" in
    --runtime-root)
      (($# >= 2)) || fail '--runtime-root requires a value'
      runtime_root=$2
      shift 2
      ;;
    --wheelhouse)
      (($# >= 2)) || fail '--wheelhouse requires a value'
      wheelhouse_root=$2
      shift 2
      ;;
    --source-root)
      (($# >= 2)) || fail '--source-root requires a value'
      source_root=$2
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *) fail "unknown argument: $1" ;;
  esac
done

[[ -n "$runtime_root" ]] || fail '--runtime-root is required'
[[ -n "$wheelhouse_root" ]] || fail '--wheelhouse is required'
[[ -n "$source_root" ]] || fail '--source-root is required'
[[ -d "$source_root" ]] || fail "source root does not exist: $source_root"
[[ ! -e "$runtime_root" ]] || fail "runtime output already exists: $runtime_root"
[[ ! -e "$wheelhouse_root" ]] || fail "wheelhouse output already exists: $wheelhouse_root"
[[ -n "${SOURCE_DATE_EPOCH:-}" && "$SOURCE_DATE_EPOCH" =~ ^[0-9]+$ ]] || fail 'SOURCE_DATE_EPOCH must be set to the release commit timestamp'

[[ -r /etc/os-release ]] || fail '/etc/os-release is unavailable'
# shellcheck disable=SC1091
source /etc/os-release
[[ "${ID:-}" == 'ubuntu' && "${VERSION_ID:-}" == '22.04' ]] || fail "Ubuntu 22.04 is required; received ${PRETTY_NAME:-unknown Linux}"
[[ "$(uname -m)" == 'x86_64' ]] || fail "x86_64 is required; received $(uname -m)"

for command_name in curl tar sha256sum make cc find sort ldd; do
  command -v "$command_name" >/dev/null 2>&1 || fail "required build command is unavailable: $command_name"
done

work_root=$(mktemp -d)
trap 'rm -rf -- "$work_root"' EXIT

download_checked() {
  local url=$1
  local destination=$2
  local expected_sha256=$3
  curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
    --retry 4 --retry-all-errors --connect-timeout 20 \
    --output "$destination" "$url"
  printf '%s  %s\n' "$expected_sha256" "$destination" | sha256sum --check --status \
    || fail "SHA-256 verification failed: $url"
}

mkdir -p "$runtime_root/node" "$wheelhouse_root"

node_archive="$work_root/node-v${NODE_VERSION}-linux-x64.tar.xz"
download_checked \
  "https://nodejs.org/download/release/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
  "$node_archive" "$NODE_SHA256"
tar -xJf "$node_archive" --directory "$runtime_root/node" --strip-components=1

python_archive="$work_root/cpython-${PYTHON_VERSION}+${PYTHON_BUILD}-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz"
download_checked \
  "https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_BUILD}/cpython-${PYTHON_VERSION}%2B${PYTHON_BUILD}-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz" \
  "$python_archive" "$PYTHON_SHA256"
tar -xzf "$python_archive" --directory "$runtime_root"

nginx_archive="$work_root/nginx-${NGINX_VERSION}.tar.gz"
download_checked "https://nginx.org/download/nginx-${NGINX_VERSION}.tar.gz" "$nginx_archive" "$NGINX_SHA256"
tar -xzf "$nginx_archive" --directory "$work_root"
nginx_source="$work_root/nginx-${NGINX_VERSION}"
(
  cd "$nginx_source"
  ./configure \
    --prefix=/opt/ai-training/runtime/nginx \
    --sbin-path=sbin/nginx \
    --conf-path=conf/nginx.conf \
    --pid-path=logs/nginx.pid \
    --error-log-path=logs/error.log \
    --http-log-path=logs/access.log \
    --with-http_auth_request_module \
    --without-http_rewrite_module \
    --without-http_gzip_module
  make -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf '2')"
)
mkdir -p "$runtime_root/nginx/sbin" "$runtime_root/nginx/conf" "$runtime_root/nginx/logs"
install -m 0755 "$nginx_source/objs/nginx" "$runtime_root/nginx/sbin/nginx"
install -m 0644 "$nginx_source/conf/mime.types" "$runtime_root/nginx/conf/mime.types"
install -m 0644 "$nginx_source/LICENSE" "$runtime_root/nginx/LICENSE"

runtime_python="$runtime_root/python/bin/python3"
runtime_node="$runtime_root/node/bin/node"
runtime_nginx="$runtime_root/nginx/sbin/nginx"
[[ -x "$runtime_python" ]] || fail 'portable Python executable is missing'
[[ -x "$runtime_node" ]] || fail 'Node.js executable is missing'
[[ -x "$runtime_nginx" ]] || fail 'Nginx executable is missing'

mapfile -t requirement_files < <(
  {
    printf '%s\n' \
      "$source_root/grader/requirements.txt" \
      "$source_root/services/ldap3-gateway/requirements.txt" \
      "$source_root/tools/engine-dev-kit/requirements.txt"
    find "$source_root/challenges" -type f -path '*/engine/requirements.txt' -print
  } | sort -u
)
for requirement_file in "${requirement_files[@]}"; do
  [[ -f "$requirement_file" ]] || fail "release requirement file is missing: $requirement_file"
done

combined_requirements="$work_root/release-requirements.txt"
for requirement_file in "${requirement_files[@]}"; do
  printf '\n# source: %s\n' "${requirement_file#"$source_root"/}" >> "$combined_requirements"
  cat "$requirement_file" >> "$combined_requirements"
done

"$runtime_python" -m pip download \
  --disable-pip-version-check \
  --only-binary=:all: \
  --dest "$wheelhouse_root" \
  --requirement "$combined_requirements"

"$runtime_python" -m pip install \
  --disable-pip-version-check \
  --no-index \
  --find-links "$wheelhouse_root" \
  --requirement "$source_root/grader/requirements.txt" \
  --requirement "$source_root/services/ldap3-gateway/requirements.txt"

materialized_symlinks=$("$runtime_python" - "$runtime_root" <<'PY'
import os
import pathlib
import shutil
import sys

root = pathlib.Path(sys.argv[1]).resolve()
links = []
for directory, directories, files in os.walk(root, followlinks=False):
    base = pathlib.Path(directory)
    for name in [*directories, *files]:
        path = base / name
        if path.is_symlink():
            links.append(path)

for path in sorted(links, key=lambda item: len(item.parts), reverse=True):
    target = path.resolve(strict=True)
    try:
        target.relative_to(root)
    except ValueError as error:
        raise SystemExit(f'runtime symlink escapes the runtime root: {path}') from error
    if not target.is_file():
        raise SystemExit(f'runtime directory symlinks are not supported: {path}')
    path.unlink()
    shutil.copy2(target, path)

print(len(links))
PY
)
[[ "$materialized_symlinks" =~ ^[0-9]+$ ]] || fail 'runtime symlink materialization did not return a count'

find "$wheelhouse_root" -maxdepth 1 -type f -name '*.whl' -print -quit | grep -q . \
  || fail 'offline wheelhouse contains no wheel files'
"$runtime_node" -e 'const [major] = process.versions.node.split(".").map(Number); if (major < 20 || process.platform !== "linux" || process.arch !== "x64") process.exit(1)'
"$runtime_python" -c 'import ldap3, jsonschema, yaml; import platform; assert platform.system() == "Linux" and platform.machine() in {"x86_64", "amd64"}'
"$runtime_python" -m pip --help | grep -q -- '--python <python>' || fail 'portable Python pip does not support --python'
"$runtime_python" -m venv --help >/dev/null
"$runtime_nginx" -v >/dev/null 2>&1
if ldd "$runtime_nginx" | grep -q 'not found'; then
  ldd "$runtime_nginx" >&2
  fail 'Nginx has unresolved shared libraries'
fi

requirements_json="$work_root/requirements.json"
"$runtime_python" - "$source_root" "$requirements_json" "${requirement_files[@]}" <<'PY'
import hashlib
import json
import pathlib
import sys

source_root = pathlib.Path(sys.argv[1]).resolve()
output = pathlib.Path(sys.argv[2])
items = []
for value in sys.argv[3:]:
    path = pathlib.Path(value).resolve()
    items.append({
        "path": path.relative_to(source_root).as_posix(),
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    })
output.write_text(json.dumps(items, ensure_ascii=False), encoding="utf-8")
PY

build_os=${PRETTY_NAME:-Ubuntu 22.04}
glibc_version=$(ldd --version 2>&1 | sed -n '1p')
node_runtime_version=$($runtime_node --version)
python_runtime_version=$($runtime_python --version | awk '{print $2}')
nginx_runtime_version=$($runtime_nginx -v 2>&1 | sed 's|^nginx version: nginx/||')

"$runtime_python" - \
  "$runtime_root/runtime-provenance.json" \
  "$SOURCE_DATE_EPOCH" \
  "$build_os" \
  "$glibc_version" \
  "$node_runtime_version" \
  "$python_runtime_version" \
  "$nginx_runtime_version" \
  "$materialized_symlinks" \
  "$requirements_json" <<PY
import datetime
import json
import pathlib
import sys

output, epoch, build_os, glibc, node, python, nginx, materialized_symlinks, requirements_path = sys.argv[1:]
created_at = datetime.datetime.fromtimestamp(int(epoch), datetime.timezone.utc).isoformat().replace('+00:00', 'Z')
requirements = json.loads(pathlib.Path(requirements_path).read_text(encoding='utf-8'))
payload = {
    'schemaVersion': '1.0',
    'target': 'linux-x64',
    'compatibleOs': 'Ubuntu 22.04 x86_64',
    'buildOs': build_os,
    'glibc': glibc,
    'createdAt': created_at,
    'materializedSymlinks': int(materialized_symlinks),
    'components': {
        'node': {'version': node, 'sourceSha256': '$NODE_SHA256'},
        'python': {'version': python, 'build': '$PYTHON_BUILD', 'sourceSha256': '$PYTHON_SHA256'},
        'nginx': {'version': nginx, 'sourceSha256': '$NGINX_SHA256'},
    },
    'requirements': requirements,
}
pathlib.Path(output).write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
PY

printf 'Prepared Ubuntu 22.04 x64 runtime: %s\n' "$runtime_root"
printf 'Prepared offline wheelhouse: %s\n' "$wheelhouse_root"
