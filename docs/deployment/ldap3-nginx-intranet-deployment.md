# 内网单服务器部署手册：Nginx + LDAP3 + AI 能力提升平台

> 给内网部署 AI 使用。请严格按顺序执行，不要自行替换认证方案、删除身份头或把 API 端口暴露给用户。

## 0. 目标结果

部署完成后，用户只访问一个地址：

~~~text
https://ai-platform.intra.example/
~~~

请求流向固定为：

~~~text
浏览器
  ├─ /                 → Nginx → Web 静态文件
  ├─ /auth/login      → Nginx → LDAP3 网关
  ├─ /login-logo.png  → Nginx → LDAP3 网关
  └─ /api/v1/*        → Nginx → LDAP3 /auth/verify → Platform API
~~~

LDAP3 网关使用内网 LDAP 域账号校验登录，成功后保存 HttpOnly 会话 Cookie。Nginx 每次转发 API 前调用 /auth/verify，把网关返回的签名身份头写入 API 请求。Platform API 只信任签名身份头。

## 1. 不能违反的规则

1. PLATFORM_IDENTITY_MODE 必须是 TRUSTED_GATEWAY。
2. Platform API 的 3000 端口和 LDAP3 网关的 8081 端口只监听 127.0.0.1，不允许办公网直接访问。
3. TRUSTED_GATEWAY_HMAC_SECRET 必须在 API 和 LDAP3 网关中完全相同。
4. LDAP_GATEWAY_SESSION_SECRET 只能放在 LDAP3 网关，不能和 HMAC 密钥复用。
5. LDAP 密码不能写入 Git、日志、数据库、Nginx 配置或前端代码。
6. 默认使用 HTTPS，并设置 LDAP_GATEWAY_COOKIE_SECURE=true；只有隔离内网才能启用 `INTRANET_HTTP_ONLY=true`，并改用 `docs/deployment/intranet-http-only.md` 中的 HTTP Nginx 配置。
7. 不要设置 PLATFORM_IDENTITY_MODE=LOCAL，不要设置 ALLOW_ANONYMOUS_LOCAL=true。

## 2. 服务器准备

以下命令适用于 Ubuntu/Debian 类 Linux。若内网系统不同，请让系统管理员提供等价的软件包，不要让 AI 自行更换部署方式。

需要的软件：

- Node.js 20 或更高版本；
- pnpm 11.8.0；
- Python 3.11 或更高版本；
- Nginx；
- Git；
- OpenSSL；
- PostgreSQL 和生产对象存储（平台生产模式要求）。

检查版本：

~~~bash
node --version
pnpm --version
python3 --version
nginx -v
git --version
~~~

如果 Node.js 低于 20，先停止部署并升级 Node.js。

创建运行用户和目录：

~~~bash
sudo useradd --system --home-dir /opt/ai-training-platform --shell /usr/sbin/nologin ai-platform
sudo mkdir -p /opt/ai-training-platform/deploy
sudo mkdir -p /etc/nginx/tls
sudo chown -R ai-platform:ai-platform /opt/ai-training-platform
~~~

## 3. 获取代码和安装依赖

把 <内网 Git 地址> 替换为实际仓库地址：

~~~bash
sudo git clone <内网 Git 地址> /opt/ai-training-platform
sudo chown -R ai-platform:ai-platform /opt/ai-training-platform
cd /opt/ai-training-platform

sudo -u ai-platform corepack enable
sudo -u ai-platform corepack prepare pnpm@11.8.0 --activate
sudo -u ai-platform pnpm install --frozen-lockfile

sudo -u ai-platform python3 -m venv services/ldap3-gateway/.venv
sudo -u ai-platform services/ldap3-gateway/.venv/bin/python -m pip install --upgrade pip
sudo -u ai-platform services/ldap3-gateway/.venv/bin/pip install -r services/ldap3-gateway/requirements.txt
~~~

## 4. 创建 API 环境变量

创建文件：

~~~bash
sudo install -o ai-platform -g ai-platform -m 600 /dev/null /opt/ai-training-platform/deploy/platform-api.env
sudo nano /opt/ai-training-platform/deploy/platform-api.env
~~~

写入下面内容，并替换尖括号中的值：

platform-api.env 会被 systemd 和迁移命令读取；含有空格、# 或 $ 的值必须使用单引号包住。数据库密码中的特殊字符必须先按 URL 规则编码后再放入 DATABASE_URL。

~~~env
NODE_ENV=production
HOST=127.0.0.1
PORT=3000

PLATFORM_IDENTITY_MODE=TRUSTED_GATEWAY
TRUSTED_GATEWAY_HMAC_SECRET=<复制同一条随机密钥到 LDAP3 网关>
TRUSTED_GATEWAY_MAX_AGE_SECONDS=90

PLATFORM_REPOSITORY=postgres
DATABASE_URL=postgresql://<数据库用户>:<数据库密码>@<数据库地址>:5432/<数据库名>

OBJECT_STORAGE_MODE=s3
OBJECT_STORAGE_BUCKET=<对象存储桶>
OBJECT_STORAGE_REGION=<对象存储区域>
OBJECT_STORAGE_ENDPOINT=<内网对象存储地址>
OBJECT_STORAGE_ACCESS_KEY_ID=<对象存储访问密钥>
OBJECT_STORAGE_SECRET_ACCESS_KEY=<对象存储私钥>
OBJECT_STORAGE_FORCE_PATH_STYLE=true
OBJECT_STORAGE_PREFIX=platform

PROJECT_ROOT=/opt/ai-training-platform
ARTIFACT_ROOT=/opt/ai-training-platform/tmp/artifacts
ENGINE_PACKAGE_ROOT=/opt/ai-training-platform/tmp/engine-packages
LOCAL_WORKSPACE_ROOT=/opt/ai-training-platform
EMBEDDED_EVALUATION_WORKER=false
CORS_ORIGINS=https://ai-platform.intra.example
~~~

生成 HMAC 密钥的方法：

~~~bash
openssl rand -hex 32
~~~

执行一次，把输出复制到 TRUSTED_GATEWAY_HMAC_SECRET。再执行一次，把输出作为 LDAP_GATEWAY_SESSION_SECRET。不要把生成结果发给 AI 或写入聊天记录。

## 5. 创建 LDAP3 网关环境变量

创建文件：

~~~bash
sudo install -o ai-platform -g ai-platform -m 600 /dev/null /opt/ai-training-platform/deploy/ldap3-gateway.env
sudo nano /opt/ai-training-platform/deploy/ldap3-gateway.env
~~~

写入下面内容：

~~~env
LDAP_GATEWAY_HOST=127.0.0.1
LDAP_GATEWAY_PORT=8081

LDAP_SERVER=china.huawei.com
LDAP_PORT=389
LDAP_USE_SSL=false
LDAP_START_TLS=true
LDAP_CA_CERT_FILE=/etc/ssl/certs/company-ldap-ca.pem
LDAP_BASE_DN=dc=china,dc=huawei,dc=com
# systemd 环境文件中写两个反斜杠，进程最终收到一个反斜杠。
LDAP_BIND_PREFIX=China\\
LDAP_ACCOUNT_ATTRIBUTE=sAMAccountName
LDAP_TITLE_ATTRIBUTE=title
LDAP_DEPARTMENT_ATTRIBUTE=department
LDAP_NAME_ATTRIBUTE=displayName
LDAP_TIMEOUT_SECONDS=5

LDAP_GATEWAY_SESSION_SECRET=<第二条独立随机密钥>
TRUSTED_GATEWAY_HMAC_SECRET=<必须与 platform-api.env 完全相同>
LDAP_GATEWAY_SESSION_TTL_SECONDS=28800
TRUSTED_GATEWAY_MAX_AGE_SECONDS=90
# HTTPS is the default. Set true only for an isolated internal HTTP network;
# use docs/deployment/intranet-http-only.md for the matching Nginx server block.
INTRANET_HTTP_ONLY=false
LDAP_GATEWAY_COOKIE_SECURE=true
~~~

将企业 LDAP CA 证书复制到配置中的路径：

~~~bash
sudo install -o ai-platform -g ai-platform -m 644 <企业 LDAP CA 证书> /etc/ssl/certs/company-ldap-ca.pem
~~~

如果内网 LDAP 只提供 LDAPS，将配置改为：

~~~env
LDAP_PORT=636
LDAP_USE_SSL=true
LDAP_START_TLS=false
~~~

LDAP_USE_SSL 和 LDAP_START_TLS 不能同时为 true。

## 6. 构建 Web 和 API

构建前必须设置同域 API 地址，否则浏览器会错误访问用户电脑自己的 127.0.0.1：

~~~bash
cd /opt/ai-training-platform
export VITE_API_BASE=/api/v1
export VITE_AUTH_LOGIN_PATH=/auth/login
sudo -u ai-platform env VITE_API_BASE="$VITE_API_BASE" VITE_AUTH_LOGIN_PATH="$VITE_AUTH_LOGIN_PATH" pnpm build
~~~

构建成功后必须存在：

~~~text
/opt/ai-training-platform/apps/web/dist/index.html
/opt/ai-training-platform/apps/web/dist/brand-logo.png
/opt/ai-training-platform/services/platform-api/dist/main.js
~~~

首次使用 PostgreSQL 时，在启动 API 前执行迁移：

~~~bash
cd /opt/ai-training-platform
sudo -u ai-platform bash -lc 'set -a; source /opt/ai-training-platform/deploy/platform-api.env; set +a; cd /opt/ai-training-platform; pnpm --filter @ai-training/platform-api prisma:migrate:deploy'
~~~

如果这条命令报错，不要删除迁移目录；先检查 DATABASE_URL、数据库网络和数据库权限。

## 7. 创建 systemd 服务

### 7.1 Platform API

~~~bash
sudo tee /etc/systemd/system/ai-platform-api.service > /dev/null <<'EOF'
[Unit]
Description=AI Training Platform API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ai-platform
Group=ai-platform
WorkingDirectory=/opt/ai-training-platform
EnvironmentFile=/opt/ai-training-platform/deploy/platform-api.env
ExecStart=/usr/bin/node /opt/ai-training-platform/services/platform-api/dist/main.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
~~~

### 7.2 LDAP3 网关

~~~bash
sudo tee /etc/systemd/system/ai-platform-ldap3.service > /dev/null <<'EOF'
[Unit]
Description=AI Training Platform LDAP3 Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ai-platform
Group=ai-platform
WorkingDirectory=/opt/ai-training-platform/services/ldap3-gateway
EnvironmentFile=/opt/ai-training-platform/deploy/ldap3-gateway.env
ExecStart=/opt/ai-training-platform/services/ldap3-gateway/.venv/bin/python /opt/ai-training-platform/services/ldap3-gateway/ldap3_gateway.py
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
~~~

启动服务：

~~~bash
sudo systemctl daemon-reload
sudo systemctl enable --now ai-platform-api.service
sudo systemctl enable --now ai-platform-ldap3.service
sudo systemctl status ai-platform-api.service --no-pager
sudo systemctl status ai-platform-ldap3.service --no-pager
~~~

## 8. 配置 Nginx

先把平台 HTTPS 证书放到：

~~~text
/etc/nginx/tls/ai-platform.crt
/etc/nginx/tls/ai-platform.key
~~~

创建 Nginx 配置：

~~~bash
sudo nano /etc/nginx/sites-available/ai-platform
~~~

完整内容如下。只需要替换 server_name、证书路径和项目路径；不要删除 auth_request、X-Trusted-* 或清理浏览器身份头的配置。

~~~nginx
server {
    listen 80;
    server_name ai-platform.intra.example;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name ai-platform.intra.example;

    ssl_certificate     /etc/nginx/tls/ai-platform.crt;
    ssl_certificate_key /etc/nginx/tls/ai-platform.key;

    client_max_body_size 75m;

    # 只允许 Nginx 内部子请求调用，浏览器不能直接访问。
    location = /_ldap_verify {
        internal;
        proxy_pass http://127.0.0.1:8081/auth/verify;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header Host $host;
        proxy_set_header Cookie $http_cookie;
    }

    # 登录页和登录页图标不需要先登录。
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

    # 主站 Logo 也是公共静态资源。
    location = /brand-logo.png {
        root /opt/ai-training-platform/apps/web/dist;
    }

    # API 必须先通过 LDAP3 会话校验。
    location /api/ {
        auth_request /_ldap_verify;
        auth_request_set $trusted_employee_no $upstream_http_x_trusted_employee_no;
        auth_request_set $trusted_name $upstream_http_x_trusted_name;
        auth_request_set $trusted_department $upstream_http_x_trusted_department;
        auth_request_set $trusted_issued_at $upstream_http_x_trusted_issued_at;
        auth_request_set $trusted_signature $upstream_http_x_trusted_identity_signature;

        # 删除浏览器可能伪造的身份头，再写入网关签名头。
        proxy_set_header X-Employee-Id "";
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

    # 未登录打开主站时跳转 LDAP3 登录页。
    location / {
        auth_request /_ldap_verify;
        error_page 401 =302 /auth/login?returnTo=$request_uri;
        root /opt/ai-training-platform/apps/web/dist;
        try_files $uri $uri/ /index.html;
    }
}
~~~

启用并检查配置：

~~~bash
sudo ln -s /etc/nginx/sites-available/ai-platform /etc/nginx/sites-enabled/ai-platform
sudo nginx -t
sudo systemctl reload nginx
~~~

如果 ln 报“文件已存在”，不要重复创建；先检查：

~~~bash
ls -l /etc/nginx/sites-enabled/ai-platform
~~~

## 9. 按顺序验收

### 9.1 检查本机服务

~~~bash
curl -fsS http://127.0.0.1:3000/api/v1/health
curl -fsS http://127.0.0.1:8081/healthz
curl -I https://ai-platform.intra.example/login-logo.png
~~~

三个命令都应成功。LDAP3 网关健康检查只代表进程存活，不代表 LDAP 网络已连通。

### 9.2 检查未登录跳转

~~~bash
curl -k -I https://ai-platform.intra.example/
~~~

响应应为 302，并且 Location 包含：

~~~text
/auth/login?returnTo=/
~~~

### 9.3 检查浏览器登录

1. 使用浏览器打开 https://ai-platform.intra.example/。
2. 应自动跳转到登录页。
3. 页面显示云图标、登录、工号、密码。
4. 输入真实 LDAP 工号和密码。
5. 登录成功后回到原页面。
6. 打开“个人中心”，确认工号、姓名、部门正确。

### 9.4 检查安全边界

~~~bash
curl -i http://127.0.0.1:3000/api/v1/me
~~~

此请求只能在服务器本机看到；不要把 3000 端口配置为 0.0.0.0，不要把它加入防火墙入站白名单。

## 10. 常见故障：只按表格排查

| 现象 | 检查顺序 |
| --- | --- |
| 打开主站没有跳登录页 | nginx -t；location / 是否有 auth_request；/_ldap_verify 是否 internal |
| 登录页能打开但 Logo 不显示 | systemctl status ai-platform-ldap3；curl -I http://127.0.0.1:8081/login-logo.png；Nginx 是否配置 /login-logo.png |
| 登录后马上又回到登录页 | HTTPS 是否启用；LDAP_GATEWAY_COOKIE_SECURE 是否为 true；浏览器是否保存 Cookie |
| LDAP 登录失败 | LDAP 主机、端口、CA 证书、LDAP_START_TLS/LDAP_USE_SSL、LDAP_BIND_PREFIX |
| 页面能打开但 API 返回 401 | API 和网关的 HMAC 密钥是否完全相同；Nginx 是否复制五个 X-Trusted-* 头 |
| API 返回 trusted gateway identity is expired | 两个服务的系统时间；NTP；TRUSTED_GATEWAY_MAX_AGE_SECONDS |
| 员工姓名或部门为空 | 检查 AD title 格式是否为 工号,姓名,部门，以及 department、displayName 字段 |
| Nginx 返回 413 | 增大 client_max_body_size，当前平台示例为 75m |
| API 服务启动失败 | journalctl -u ai-platform-api -n 100 --no-pager；重点检查数据库和对象存储变量 |

查看日志：

~~~bash
sudo journalctl -u ai-platform-api -f
sudo journalctl -u ai-platform-ldap3 -f
sudo tail -f /var/log/nginx/error.log
~~~

日志中不得出现 LDAP 密码、会话 Cookie、HMAC 密钥或完整 SSO 断言。发现后立即停止服务并清理日志。

## 11. 更新版本

更新前先备份数据库、对象存储和 deploy/*.env：

~~~bash
cd /opt/ai-training-platform
sudo systemctl stop ai-platform-api.service ai-platform-ldap3.service
sudo -u ai-platform git pull --ff-only
sudo -u ai-platform pnpm install --frozen-lockfile
sudo -u ai-platform services/ldap3-gateway/.venv/bin/pip install -r services/ldap3-gateway/requirements.txt
export VITE_API_BASE=/api/v1
export VITE_AUTH_LOGIN_PATH=/auth/login
sudo -u ai-platform env VITE_API_BASE="$VITE_API_BASE" VITE_AUTH_LOGIN_PATH="$VITE_AUTH_LOGIN_PATH" pnpm build
sudo systemctl start ai-platform-api.service ai-platform-ldap3.service
sudo nginx -t && sudo systemctl reload nginx
~~~

如果数据库迁移失败，停止后续操作，恢复备份并联系平台开发人员。不要删除 prisma/migrations。

## 12. 部署完成回报模板

弱模型完成后只回报下面信息，不要回报密钥、密码、Cookie 或完整日志：

~~~text
部署结果：
- 代码目录：
- 平台域名：
- API health：通过 / 失败
- LDAP3 health：通过 / 失败
- 未登录跳转：通过 / 失败
- 浏览器 LDAP 登录：通过 / 失败
- /api/v1/me 返回员工信息：通过 / 失败
- 未解决问题：
~~~

相关详细协议：

- ldap3-trusted-gateway.md：LDAP3 网关实现和 HMAC 细节；
- trusted-gateway-sso.md：平台可信网关身份协议；
- windows-production-smoke-test.md：Windows 个人电脑上的生产模式端到端验收步骤。
