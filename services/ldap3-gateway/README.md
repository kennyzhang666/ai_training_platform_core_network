# LDAP3 统一认证网关适配器

这个目录把内网提供的 LDAP3 登录逻辑接到平台已经实现的 `TRUSTED_GATEWAY` 身份协议。LDAP 密码只在网关的 `/auth/login` 请求中短暂存在，不会进入 Platform API、浏览器 Cookie、日志或平台数据库。

## 运行

```powershell
cd services/ldap3-gateway
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt

$env:LDAP_SERVER = 'china.huawei.com'
$env:LDAP_PORT = '389'
$env:LDAP_USE_SSL = 'false'
$env:LDAP_START_TLS = 'true'
$env:LDAP_CA_CERT_FILE = 'C:\certs\company-ldap-ca.pem'
$env:LDAP_BASE_DN = 'dc=china,dc=huawei,dc=com'
$env:LDAP_BIND_PREFIX = 'China\'
$env:LDAP_GATEWAY_SESSION_SECRET = '<随机生成的至少 32 字符会话密钥>'
$env:TRUSTED_GATEWAY_HMAC_SECRET = '<与 Platform API 相同的密钥>'
$env:INTRANET_HTTP_ONLY = 'false'
$env:LDAP_GATEWAY_COOKIE_SECURE = 'true'
python ldap3_gateway.py
```

生产环境应使用 LDAPS 或 StartTLS，并通过进程环境注入密钥；不要把真实密钥、账号或员工信息写入仓库。浏览器到 Nginx 的链路默认使用 HTTPS；如果是隔离内网的纯 HTTP 部署，请使用上面的 `INTRANET_HTTP_ONLY=true` 开关和配套 Nginx 配置，不要只手工改 Cookie 参数。

### 直接 clone 后用 Docker 部署

仓库已经包含登录页、依赖和 Dockerfile，不需要再单独开发登录前端：

```bash
cd services/ldap3-gateway
cp .env.example .env
# 编辑 .env，至少替换两个密钥，并填写 LDAP CA 证书路径
docker build -t platform-ldap-gateway:local .
docker run --rm --name platform-ldap-gateway \
  --env-file .env \
  -p 127.0.0.1:8081:8081 \
  platform-ldap-gateway:local
```

如果启用了 `LDAP_CA_CERT_FILE`，还要把宿主机证书以只读方式挂载到容器内同一路径，例如：

```bash
docker run --rm --name platform-ldap-gateway \
  --env-file .env \
  -v /etc/company/certs/ldap-ca.pem:/etc/ssl/certs/company-ldap-ca.pem:ro \
  -p 127.0.0.1:8081:8081 \
  platform-ldap-gateway:local
```

登录页面地址是 `/auth/login`，登录成功后由反向代理调用 `/auth/verify`，再把可信身份头转发给 Platform API。完整的 Nginx 配置和验收清单见仓库的 LDAP3 接入指南。

## 网关接入方式

- `GET /auth/login`：返回登录页；`POST /auth/login` 接收 `userId`、`password`，LDAP 绑定成功后设置 HttpOnly 会话 Cookie。
- `GET /auth/verify`：供 Nginx、Ingress 或现有统一认证网关的 `auth_request` 调用。成功时返回五个 `X-Trusted-*` 响应头，反向代理必须把它们复制到发往 Platform API 的请求头。
- `GET /auth/session`：返回不含签名的当前会话信息，仅用于登录页调试。
- `POST /auth/logout`：清理会话 Cookie。
- `GET /brand-logo.png`：提供与主站一致的品牌 Logo，不需要登录。
- `GET /login-logo.png`：提供登录页使用的云图标，不需要登录。
- `GET /healthz`：健康检查，不需要登录。

平台 API 配置仍然是：

```env
NODE_ENV=production
PLATFORM_IDENTITY_MODE=TRUSTED_GATEWAY
TRUSTED_GATEWAY_HMAC_SECRET=<与网关相同的密钥>
TRUSTED_GATEWAY_MAX_AGE_SECONDS=90
```

反向代理必须先删除浏览器传入的 `X-Employee-Id` 和 `X-Trusted-*`，再从 `/auth/verify` 的响应头重新写入。具体 HMAC 字段、Nginx `auth_request` 示例和上线验收请阅读 [`docs/deployment/ldap3-trusted-gateway.md`](../../docs/deployment/ldap3-trusted-gateway.md) 和 [`docs/deployment/trusted-gateway-sso.md`](../../docs/deployment/trusted-gateway-sso.md)。

## 测试

测试使用假的 LDAP 连接，不会连接真实内网目录：

```powershell
python services/ldap3-gateway/test_ldap3_gateway.py
```

## 内网纯 HTTP 模式

默认仍使用 HTTPS。只有在网络边界已经由内网 ACL、专用网络或其他等价措施保护时，才在网关环境中设置：

```env
INTRANET_HTTP_ONLY=true
```

该开关会自动关闭会话 Cookie 的 `Secure` 标志；即使遗留配置中仍有
`LDAP_GATEWAY_COOKIE_SECURE=true`，也以 HTTP-only 开关为准。然后按
`docs/deployment/ldap3-nginx-intranet-deployment.md` 中的 HTTP Nginx 配置监听
80 端口，并删除 HTTP 到 HTTPS 的重定向。LDAP 到目录服务器的链路仍应使用
LDAPS 或 StartTLS；HTTP-only 只描述浏览器到内网 Nginx 的这一段。
