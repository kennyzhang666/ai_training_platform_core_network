# Windows 个人电脑生产模式验收手册

> 这是一套“生产模式本地验收”方案，不等于正式生产部署。它让 Windows 电脑上的 API 使用生产约束（PostgreSQL、S3 兼容对象存储、`TRUSTED_GATEWAY`），再通过 Nginx HTTPS 接入 LDAP3 网关。正式内网部署仍建议使用 Linux 服务器、独立 Worker、密钥管理和备份策略。

## 0. 完成后的访问链路

浏览器只打开一个地址：

~~~text
https://localhost/
        |
        +-- Nginx 443
             +-- /             -> apps/web/dist 静态文件
             +-- /auth/login   -> LDAP3 网关 127.0.0.1:8081
             +-- /api/         -> auth_request -> LDAP3 /auth/verify -> API 127.0.0.1:3000
             +-- /login-logo.png -> LDAP3 网关
             +-- /brand-logo.png  -> Web 静态文件
~~~

API 只监听 `127.0.0.1:3000`，LDAP3 网关只监听 `127.0.0.1:8081`，用户不能直接访问这两个端口。Nginx 从 LDAP3 网关取得签名身份头，再转发给 API；API 不接收 LDAP 密码。

## 1. 先确认是否具备真实 LDAP 条件

在 Windows 电脑上连接公司内网或 VPN，然后在 PowerShell 执行：

~~~powershell
Test-NetConnection china.huawei.com -Port 389
Test-NetConnection china.huawei.com -Port 636
~~~

如果 389/636 都失败，不能做真实 LDAP 登录，只能先做假 LDAP 单元测试或开发模式验收。不要为了绕过网络问题把 `PLATFORM_IDENTITY_MODE` 改回 `LOCAL` 后声称已经完成生产验收。

LDAP 使用 StartTLS 时，需要企业 LDAP CA 的 PEM 文件；使用 LDAPS 时，也需要 CA 文件（除非企业明确提供了可信系统证书链）。向内网管理员取得例如：

~~~text
C:\certs\company-ldap-ca.pem
~~~

## 2. 安装依赖

建议安装以下软件：

- Git for Windows；
- Node.js 20 或更高版本；
- pnpm 11.8.0；
- Python 3.11 或更高版本；
- Nginx for Windows；
- Docker Desktop（只用来运行 PostgreSQL 和 MinIO，最省事）；
- OpenSSL（Git for Windows 通常已带有 `usr\bin\openssl.exe`）。

检查版本：

~~~powershell
node --version
corepack --version
python --version
git --version
docker version
~~~

如果 Node.js 小于 20，或 Docker Desktop 没有运行，先停止，不要继续执行后面的启动命令。

## 3. 获取代码和安装依赖

下面假设代码目录为 `D:\ai-training-platform`，可以换成自己的目录，但后面的路径必须保持一致：

~~~powershell
git clone <内网 Git 地址> D:\ai-training-platform
Set-Location D:\ai-training-platform

corepack enable
corepack prepare pnpm@11.8.0 --activate
pnpm install --frozen-lockfile

py -3.11 -m venv services\ldap3-gateway\.venv
.\services\ldap3-gateway\.venv\Scripts\python.exe -m pip install --upgrade pip
.\services\ldap3-gateway\.venv\Scripts\pip.exe install -r services\ldap3-gateway\requirements.txt
~~~

## 4. 用 Docker Desktop 准备 PostgreSQL 和 MinIO

生产模式禁止使用 `tmp/platform-data.json` 和本地对象目录。个人电脑上最简单的等价替身是本机 Docker 容器：

~~~powershell
docker run -d --name ai-platform-postgres `
  -e POSTGRES_USER=platform `
  -e POSTGRES_PASSWORD=change-this-local-password `
  -e POSTGRES_DB=ai_training_platform `
  -p 127.0.0.1:5432:5432 `
  postgres:16

docker run -d --name ai-platform-minio `
  -e MINIO_ROOT_USER=platformminio `
  -e MINIO_ROOT_PASSWORD=change-this-minio-password `
  -p 127.0.0.1:9000:9000 `
  -p 127.0.0.1:9001:9001 `
  quay.io/minio/minio server /data --console-address ":9001"
~~~

打开 `http://127.0.0.1:9001`，使用上面的 MinIO 用户和密码登录，创建一个名为 `ai-training-platform` 的 bucket。不要勾选公开访问，平台使用 S3 API 访问。

检查容器：

~~~powershell
docker ps --filter "name=ai-platform-postgres"
docker ps --filter "name=ai-platform-minio"
~~~

这两个容器停止后，生产模式 API 会因为数据库或对象存储不可用而启动失败，这是预期行为。

## 5. 生成两条独立密钥

打开一个 PowerShell 窗口，执行：

~~~powershell
function New-RandomSecret {
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  [Convert]::ToHexString($bytes).ToLowerInvariant()
}

$trustedGatewaySecret = New-RandomSecret
$ldapSessionSecret = New-RandomSecret
$trustedGatewaySecret
$ldapSessionSecret
~~~

把两条结果临时保存到密码管理器：

- `trustedGatewaySecret`：API 和 LDAP3 网关必须使用同一条；
- `ldapSessionSecret`：只给 LDAP3 网关使用，不能与第一条复用。

不要把真实密钥写进 Git、截图、聊天记录、前端代码或 Nginx 配置。下面示例中的 `REPLACE_ME` 必须替换成真实值。

## 6. 启动 API 的生产环境变量

为 API 单独打开 PowerShell 窗口，在仓库根目录执行。变量只对这个窗口及其子进程生效，不会写入系统环境变量：

~~~powershell
Set-Location D:\ai-training-platform

$env:NODE_ENV = 'production'
$env:HOST = '127.0.0.1'
$env:PORT = '3000'

$env:PLATFORM_IDENTITY_MODE = 'TRUSTED_GATEWAY'
$env:TRUSTED_GATEWAY_HMAC_SECRET = 'REPLACE_WITH_trustedGatewaySecret'
$env:TRUSTED_GATEWAY_MAX_AGE_SECONDS = '90'

$env:PLATFORM_REPOSITORY = 'postgres'
$env:DATABASE_URL = 'postgresql://platform:change-this-local-password@127.0.0.1:5432/ai_training_platform'

$env:OBJECT_STORAGE_MODE = 's3'
$env:OBJECT_STORAGE_BUCKET = 'ai-training-platform'
$env:OBJECT_STORAGE_REGION = 'us-east-1'
$env:OBJECT_STORAGE_ENDPOINT = 'http://127.0.0.1:9000'
$env:OBJECT_STORAGE_ACCESS_KEY_ID = 'platformminio'
$env:OBJECT_STORAGE_SECRET_ACCESS_KEY = 'change-this-minio-password'
$env:OBJECT_STORAGE_FORCE_PATH_STYLE = 'true'
$env:OBJECT_STORAGE_PREFIX = 'platform'

$env:PROJECT_ROOT = 'D:\ai-training-platform'
$env:ARTIFACT_ROOT = 'D:\ai-training-platform\tmp\artifacts'
$env:ENGINE_PACKAGE_ROOT = 'D:\ai-training-platform\tmp\engine-packages'
$env:LOCAL_WORKSPACE_ROOT = 'D:\ai-training-platform'
$env:EMBEDDED_EVALUATION_WORKER = 'false'
$env:CORS_ORIGINS = 'https://localhost'
~~~

注意：不要设置 `PLATFORM_DATA_FILE`、`PLATFORM_REPOSITORY=file`、`OBJECT_STORAGE_MODE=local`、`PLATFORM_IDENTITY_MODE=LOCAL` 或 `ALLOW_ANONYMOUS_LOCAL=true`。

## 7. 执行 PostgreSQL 迁移并构建生产前端

仍在 API PowerShell 窗口执行：

~~~powershell
pnpm --filter @ai-training/platform-api prisma:migrate:deploy

$env:VITE_API_BASE = '/api/v1'
$env:VITE_AUTH_LOGIN_PATH = '/auth/login'
pnpm build
~~~

构建完成后检查：

~~~powershell
Test-Path .\apps\web\dist\index.html
Test-Path .\apps\web\dist\brand-logo.png
Test-Path .\services\platform-api\dist\main.js
~~~

三个结果都必须是 `True`。生产构建默认不会显示右上角的本地多用户切换器。

## 8. 启动 LDAP3 网关

在第二个 PowerShell 窗口执行。把 `trustedGatewaySecret` 填成第 5 节的第一条密钥：

~~~powershell
Set-Location D:\ai-training-platform

$env:LDAP_GATEWAY_HOST = '127.0.0.1'
$env:LDAP_GATEWAY_PORT = '8081'
$env:LDAP_SERVER = 'china.huawei.com'
$env:LDAP_PORT = '389'
$env:LDAP_USE_SSL = 'false'
$env:LDAP_START_TLS = 'true'
$env:LDAP_CA_CERT_FILE = 'C:\certs\company-ldap-ca.pem'
$env:LDAP_BASE_DN = 'dc=china,dc=huawei,dc=com'
$env:LDAP_BIND_PREFIX = 'China\'
$env:LDAP_ACCOUNT_ATTRIBUTE = 'sAMAccountName'
$env:LDAP_TITLE_ATTRIBUTE = 'title'
$env:LDAP_DEPARTMENT_ATTRIBUTE = 'department'
$env:LDAP_NAME_ATTRIBUTE = 'displayName'
$env:LDAP_TIMEOUT_SECONDS = '5'

$env:LDAP_GATEWAY_SESSION_SECRET = 'REPLACE_WITH_ldapSessionSecret'
$env:TRUSTED_GATEWAY_HMAC_SECRET = 'REPLACE_WITH_trustedGatewaySecret'
$env:LDAP_GATEWAY_SESSION_TTL_SECONDS = '28800'
$env:TRUSTED_GATEWAY_MAX_AGE_SECONDS = '90'
$env:INTRANET_HTTP_ONLY = 'false'
$env:LDAP_GATEWAY_COOKIE_SECURE = 'true'

.\services\ldap3-gateway\.venv\Scripts\python.exe .\services\ldap3-gateway\ldap3_gateway.py
~~~

如果企业目录只开放 LDAPS，改为：

~~~powershell
$env:LDAP_PORT = '636'
$env:LDAP_USE_SSL = 'true'
$env:LDAP_START_TLS = 'false'
~~~

`LDAP_USE_SSL` 和 `LDAP_START_TLS` 不能同时为 `true`。登录网关启动后会监听 `127.0.0.1:8081`；`/healthz` 成功只表示进程存活，不表示 LDAP 登录已经验证成功。

## 9. 启动生产 API

回到第 6 节的 API PowerShell 窗口执行：

~~~powershell
pnpm --filter @ai-training/platform-api start
~~~

保持这个窗口打开。另开窗口检查：

~~~powershell
Invoke-WebRequest http://127.0.0.1:3000/api/v1/health | Select-Object -ExpandProperty Content
Invoke-WebRequest http://127.0.0.1:8081/healthz | Select-Object -ExpandProperty Content
~~~

两个服务都应返回 JSON。不要把 3000 或 8081 端口直接发给同事访问；必须经过 Nginx。

## 10. 安装并配置 Windows Nginx

1. 从 Nginx 官方 Windows 压缩包解压到 `C:\nginx`；
2. 创建 `C:\nginx\conf\tls`；
3. 使用 OpenSSL 生成本机 HTTPS 证书：

~~~powershell
New-Item -ItemType Directory -Force C:\nginx\conf\tls | Out-Null
& 'C:\Program Files\Git\usr\bin\openssl.exe' req -x509 -nodes -newkey rsa:2048 `
  -keyout C:/nginx/conf/tls/localhost.key `
  -out C:/nginx/conf/tls/localhost.crt `
  -days 365 -subj '/CN=localhost'
~~~

如果 OpenSSL 不在该路径，使用 `Get-Command openssl` 找到实际路径。个人电脑测试可以接受浏览器的自签名证书提示；如果希望不再提示，可把 `localhost.crt` 导入当前用户的“受信任的根证书颁发机构”。

把 `C:\nginx\conf\nginx.conf` 替换为下面的内容：

~~~nginx
worker_processes 1;

events {
    worker_connections 1024;
}

http {
    include       mime.types;
    default_type  application/octet-stream;
    sendfile      on;
    client_max_body_size 75m;

    server {
        listen 80;
        server_name localhost;
        return 301 https://$host$request_uri;
    }

    server {
        listen 443 ssl;
        server_name localhost;

        ssl_certificate     C:/nginx/conf/tls/localhost.crt;
        ssl_certificate_key C:/nginx/conf/tls/localhost.key;

        # 只允许 Nginx 内部 auth_request 调用。
        location = /_ldap_verify {
            internal;
            proxy_pass http://127.0.0.1:8081/auth/verify;
            proxy_pass_request_body off;
            proxy_set_header Content-Length '';
            proxy_set_header Host $host;
            proxy_set_header Cookie $http_cookie;
        }

        # 登录、退出和登录页图标不需要先登录。
        location = /auth/login {
            proxy_pass http://127.0.0.1:8081;
            proxy_set_header Host $host;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_set_header Cookie $http_cookie;
        }

        location = /auth/logout {
            proxy_pass http://127.0.0.1:8081;
            proxy_set_header Host $host;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_set_header Cookie $http_cookie;
        }

        location = /login-logo.png {
            proxy_pass http://127.0.0.1:8081;
            proxy_set_header Host $host;
        }

        location = /brand-logo.png {
            root D:/ai-training-platform/apps/web/dist;
        }

        # API 请求必须先校验 LDAP3 会话，再写入网关签名身份头。
        location /api/ {
            auth_request /_ldap_verify;
            auth_request_set $trusted_employee_no $upstream_http_x_trusted_employee_no;
            auth_request_set $trusted_name $upstream_http_x_trusted_name;
            auth_request_set $trusted_department $upstream_http_x_trusted_department;
            auth_request_set $trusted_issued_at $upstream_http_x_trusted_issued_at;
            auth_request_set $trusted_signature $upstream_http_x_trusted_identity_signature;

            proxy_set_header X-Employee-Id '';
            proxy_set_header X-Trusted-Employee-No $trusted_employee_no;
            proxy_set_header X-Trusted-Name $trusted_name;
            proxy_set_header X-Trusted-Department $trusted_department;
            proxy_set_header X-Trusted-Issued-At $trusted_issued_at;
            proxy_set_header X-Trusted-Identity-Signature $trusted_signature;
            proxy_set_header Host $host;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_pass http://127.0.0.1:3000;
            proxy_read_timeout 300s;
        }

        # 未登录访问主站时跳转到 LDAP3 登录页。
        location / {
            auth_request /_ldap_verify;
            error_page 401 =302 /auth/login?returnTo=$request_uri;
            root D:/ai-training-platform/apps/web/dist;
            try_files $uri $uri/ /index.html;
        }
    }
}
~~~

检查并启动 Nginx：

~~~powershell
Set-Location C:\nginx
.\nginx.exe -t -p C:/nginx/ -c conf/nginx.conf
Start-Process .\nginx.exe
~~~

后续修改配置使用：

~~~powershell
.\nginx.exe -t -p C:/nginx/ -c conf/nginx.conf
.\nginx.exe -s reload
~~~

## 11. 按顺序做真实端到端验收

### 11.1 未登录跳转

~~~powershell
curl.exe -k -I https://localhost/
~~~

应返回 `302`，并跳转到 `/auth/login?returnTo=/`。如果直接显示前端页面，说明 Nginx 的 `auth_request` 没有生效。

### 11.2 LDAP3 登录

1. 浏览器打开 `https://localhost/`；
2. 接受本机自签名证书提示；
3. 页面应显示“登录”、工号、密码和“LDAP3域账号统一认证”；
4. 输入真实 LDAP3 域账号和密码；
5. 登录成功后回到首页；
6. 打开个人中心，检查工号、姓名、部门是否来自 LDAP；
7. 打开管理后台，确认权限来自平台数据库中的角色，而不是浏览器自带身份头。

### 11.3 API 和上传验收

浏览器登录后，至少验证：

- 查看训战、赛题和个人中心；
- 创建或编辑一个仅用于测试的赛题；
- 在开放时间窗口内提交一个小 ZIP；
- 查看对象存储 bucket 中出现对象；
- 查看 PostgreSQL 中出现提交、上传会话和审计记录；
- 退出登录后重新打开 `/api/v1/me`，应回到登录页而不是继续返回用户数据。

### 11.4 评测验收边界

生产模式 API 不允许在 API 进程中启动 Code Agent，也不允许使用右上角本地多身份切换。真实评测还需要单独启动 Evaluation Worker，并配置受控的 Code Agent 可执行文件；个人 Windows 只建议先验证登录、训战、提交、对象存储和权限链路。

## 12. 常见故障

| 现象 | 检查 |
| --- | --- |
| API 启动报 `file repository is not allowed in production` | `PLATFORM_REPOSITORY=postgres`、`DATABASE_URL` 是否在同一 PowerShell 窗口设置 |
| API 启动报 `local object storage is not allowed in production` | `OBJECT_STORAGE_MODE=s3`、bucket、MinIO 地址和密钥是否正确 |
| 首页不跳登录 | `nginx -t`、`location /` 是否包含 `auth_request` 和 401 跳转 |
| 登录页能打开但登录失败 | `Test-NetConnection`、LDAP CA、389/636、StartTLS/LDAPS 配置和 LDAP 属性映射 |
| 登录成功但 API 返回 401 | API 与网关的 HMAC 必须完全相同；检查系统时间和 Nginx 的五个 `X-Trusted-*` 头 |
| 登录后反复跳转登录页 | 必须使用 `https://localhost`，并保持 `LDAP_GATEWAY_COOKIE_SECURE=true`；不要用 `http://localhost` |
| Nginx 502 | API/LDAP3 网关进程是否仍在运行，3000/8081 是否只监听本机 |
| 页面有前端但 API 请求到了用户电脑的 127.0.0.1 | 构建时必须设置 `$env:VITE_API_BASE='/api/v1'`，不能使用默认开发地址 |

查看进程日志：

~~~powershell
Get-Process node,python,nginx -ErrorAction SilentlyContinue
Get-Content C:\nginx\logs\error.log -Wait
~~~

不要把 LDAP 密码、Cookie、HMAC、完整请求头或员工敏感信息贴到日志和聊天窗口。

## 13. 停止和清理

停止 Nginx：

~~~powershell
Set-Location C:\nginx
.\nginx.exe -s quit
~~~

API 和 LDAP3 网关在各自 PowerShell 窗口按 `Ctrl+C` 停止。停止测试依赖容器：

~~~powershell
docker stop ai-platform-postgres ai-platform-minio
~~~

如果要彻底清空本次测试数据，确认不再需要后再删除容器和对应 volume；这会不可恢复地删除本地 PostgreSQL/MinIO 数据。

## 14. 给弱模型 AI 的执行顺序

弱模型只需要按以下顺序执行，不要自行替换组件：

1. 确认 Windows 已连接内网/VPN，LDAP 端口可达；
2. 安装 Node、pnpm、Python、Docker Desktop、Nginx、OpenSSL；
3. clone 仓库并安装依赖；
4. 启动 PostgreSQL 和 MinIO，创建私有 bucket；
5. 生成两条独立密钥；
6. 设置 API 生产环境变量并执行迁移；
7. 设置 LDAP3 网关环境变量并启动网关；
8. 构建 Web/API；
9. 启动 API；
10. 配置 HTTPS Nginx，执行 `nginx -t` 后启动；
11. 按“未登录跳转 → LDAP 登录 → `/api/v1/me` → 提交 → 对象存储 → 退出登录”验收；
12. 失败时只按第 12 节排查，不要改成 `LOCAL`、匿名身份或绕过 Nginx。
