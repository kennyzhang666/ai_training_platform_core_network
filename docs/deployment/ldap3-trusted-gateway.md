# LDAP3 统一认证接入平台

这份文档把内网提供的 LDAP3 示例接入现有平台登录链路。平台不直接接收 LDAP 密码，也不在平台数据库保存 LDAP 凭据；LDAP3 运行在内网认证网关或同一安全域的身份适配器中。

## 1. 登录链路

```text
浏览器
  |
  | 访问平台，未登录
  v
LDAP3 网关 /auth/login
  |-- ldap3.Connection(auto_bind=True, user="China\\" + 工号, password=密码)
  |-- 查询 sAMAccountName
  |-- 从 title 解析 工号,姓名,部门
  |-- department 作为部门兜底
  `-- 设置 HttpOnly 会话 Cookie
          |
          | /auth/verify 供反向代理校验
          v
反向代理
  |-- 生成五个 X-Trusted-* 请求头
  `-- /api/ 转发 Platform API
          |
          `-- TRUSTED_GATEWAY Guard 验签并按工号幂等建档
```

平台 Web 和 API 建议使用同一个内网域名，例如 `https://ai-platform.intra/` 和 `https://ai-platform.intra/api/v1`。API 端口只允许反向代理或网关访问。

## 2. LDAP 配置映射

示例代码对应的默认配置如下：

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `LDAP_SERVER` | `china.huawei.com` | LDAP/AD 主机名 |
| `LDAP_PORT` | `389` | 生产建议改为 LDAPS 的 `636`，或由网关启用 StartTLS |
| `LDAP_USE_SSL` | `false` | 使用 LDAPS 时设为 `true`，通常配合端口 `636` |
| `LDAP_START_TLS` | `false` | 使用 LDAP StartTLS 时设为 `true`，与 `LDAP_USE_SSL` 不能同时开启 |
| `LDAP_BASE_DN` | `dc=china,dc=huawei,dc=com` | 搜索根 DN |
| `LDAP_BIND_PREFIX` | `China\` | 与示例的 `China\` + 工号一致 |
| `LDAP_ACCOUNT_ATTRIBUTE` | `sAMAccountName` | 工号搜索字段 |
| `LDAP_TITLE_ATTRIBUTE` | `title` | 按 `工号,姓名,部门` 解析 |
| `LDAP_DEPARTMENT_ATTRIBUTE` | `department` | `title` 没有部门时的兜底字段 |
| `LDAP_NAME_ATTRIBUTE` | `displayName` | `title` 没有姓名时的兜底字段 |
| `LDAP_CA_CERT_FILE` | 空 | LDAPS/StartTLS 的企业 CA 证书文件；启用 TLS 时按网关证书策略配置 |

代码对 LDAP 搜索值做 RFC 4515 转义，避免把工号直接拼入过滤器造成 LDAP 注入；只请求上述三个属性，不使用 `ALL_ATTRIBUTES`。

## 3. 网关配置

在网关环境中注入：

```env
LDAP_SERVER=china.huawei.com
LDAP_PORT=389
LDAP_USE_SSL=false
LDAP_START_TLS=true
LDAP_BASE_DN=dc=china,dc=huawei,dc=com
LDAP_CA_CERT_FILE=/etc/ssl/certs/company-ldap-ca.pem
LDAP_BIND_PREFIX=China\
LDAP_ACCOUNT_ATTRIBUTE=sAMAccountName
LDAP_TITLE_ATTRIBUTE=title
LDAP_DEPARTMENT_ATTRIBUTE=department
LDAP_NAME_ATTRIBUTE=displayName
LDAP_TIMEOUT_SECONDS=5

# 两个用途不同的密钥，均由密钥管理系统注入，不要复用或提交 Git
LDAP_GATEWAY_SESSION_SECRET=<至少 32 字符随机值>
TRUSTED_GATEWAY_HMAC_SECRET=<至少 32 字符随机值>
LDAP_GATEWAY_SESSION_TTL_SECONDS=28800
TRUSTED_GATEWAY_MAX_AGE_SECONDS=90
LDAP_GATEWAY_COOKIE_SECURE=true
```

启动参考实现：

```bash
cd services/ldap3-gateway
python -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python ldap3_gateway.py
```

参考实现默认监听 `127.0.0.1:8081`，生产应由 HTTPS 反向代理承载，不要直接暴露给办公网。

## 4. 反向代理契约

反向代理对每一个发往 Platform API 的请求都要：

1. 删除浏览器传入的 `X-Employee-Id`、`X-Trusted-*` 等身份头；
2. 以当前会话调用网关 `GET /auth/verify`；
3. 将验证响应中的五个 `X-Trusted-*` 头复制到 API 请求；
4. API 请求只转发到内网 Platform API 地址。

Nginx `auth_request` 适配示意：

```nginx
location = /_ldap_verify {
    internal;
    proxy_pass http://ldap-gateway:8081/auth/verify;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header Cookie $http_cookie;
}

location /api/ {
    auth_request /_ldap_verify;
    auth_request_set $trusted_employee_no $upstream_http_x_trusted_employee_no;
    auth_request_set $trusted_name $upstream_http_x_trusted_name;
    auth_request_set $trusted_department $upstream_http_x_trusted_department;
    auth_request_set $trusted_issued_at $upstream_http_x_trusted_issued_at;
    auth_request_set $trusted_signature $upstream_http_x_trusted_identity_signature;

    proxy_set_header X-Employee-Id "";
    proxy_set_header X-Trusted-Employee-No $trusted_employee_no;
    proxy_set_header X-Trusted-Name $trusted_name;
    proxy_set_header X-Trusted-Department $trusted_department;
    proxy_set_header X-Trusted-Issued-At $trusted_issued_at;
    proxy_set_header X-Trusted-Identity-Signature $trusted_signature;
    proxy_pass http://platform-api:3000;
}

location = /auth/login {
    proxy_pass http://ldap-gateway:8081;
    proxy_set_header Host $host;
    proxy_set_header Cookie $http_cookie;
}

location = /auth/logout {
    proxy_pass http://ldap-gateway:8081;
    proxy_set_header Host $host;
    proxy_set_header Cookie $http_cookie;
}

# 品牌资源要允许未登录访问，否则浏览器加载登录页时会被
# auth_request 再次重定向。
location = /brand-logo.png {
    proxy_pass http://platform-web:5173/brand-logo.png;
    proxy_set_header Host $host;
}

location = /login-logo.png {
    proxy_pass http://ldap-gateway:8081/login-logo.png;
    proxy_set_header Host $host;
}

location / {
    auth_request /_ldap_verify;
    error_page 401 =302 /auth/login?returnTo=$request_uri;
    proxy_pass http://platform-web:5173;
}
```

实际网关若不是 Nginx，必须实现同样的“会话校验—重新生成签名头—转发”语义。不要把 `/auth/verify` 响应头直接暴露给浏览器作为登录凭据。

## 5. 平台配置和首次登录

Platform API：

```env
NODE_ENV=production
PLATFORM_IDENTITY_MODE=TRUSTED_GATEWAY
TRUSTED_GATEWAY_HMAC_SECRET=<与网关一致>
TRUSTED_GATEWAY_MAX_AGE_SECONDS=90
VITE_API_BASE=/api/v1
```

用户登录成功后，平台第一次收到该工号的可信请求时会自动登记员工，并同步姓名和部门提示：

- 工号、姓名来自 LDAP，平台员工和管理员不能修改；
- 部门匹配组织树时自动归属，匹配不到时由全局管理员处理；
- 昵称和头像仍由员工在平台个人资料中维护；
- LDAP 部门字段不会自动赋予管理员权限。

## 6. 安全验收

- LDAP 只使用 LDAPS/StartTLS 或等价的内网加密通道；
- 登录失败只返回统一错误，不区分用户不存在、密码错误和 LDAP 细节；
- 工号搜索值经过 LDAP filter 转义；
- 密码、会话 Cookie、LDAP 断言和身份头不写入日志；
- 浏览器伪造 `X-Employee-Id` 或修改任意 `X-Trusted-*` 但不改签名时返回 401；
- 签名超过 `TRUSTED_GATEWAY_MAX_AGE_SECONDS` 时返回 401；
- Platform API 端口不能绕过网关直连；
- 网关会话过期后 `/auth/verify` 返回 401，并由前端跳转 `/auth/login`。

## 7. 相关文件

- `services/ldap3-gateway/ldap3_gateway.py`：LDAP3 绑定、属性解析、会话和网关验签头；
- `services/ldap3-gateway/requirements.txt`：网关运行依赖；
- `services/ldap3-gateway/test_ldap3_gateway.py`：不连接真实 LDAP 的回归测试；
- `docs/deployment/trusted-gateway-sso.md`：平台 HMAC 身份协议总说明。
