# 内网纯 HTTP 部署开关

平台默认按 HTTPS 部署。只有在浏览器到 Nginx 的链路完全处于隔离内网、并且已经有网络 ACL 或专用网络边界时，才启用本模式。

## 1. 开关

在 LDAP3 网关的环境文件中设置：

```env
INTRANET_HTTP_ONLY=true
```

这个开关会让网关自动关闭登录 Cookie 的 `Secure` 标志，因此 HTTP 浏览器可以继续携带会话 Cookie。它的默认值是 `false`；默认 HTTPS 部署不需要修改 `LDAP_GATEWAY_COOKIE_SECURE=true`。

Platform API 仍然使用同样的配置，不需要切换认证模式：

```env
NODE_ENV=production
PLATFORM_IDENTITY_MODE=TRUSTED_GATEWAY
TRUSTED_GATEWAY_HMAC_SECRET=<与 LDAP3 网关相同的密钥>
```

## 2. HTTP Nginx 配置

把 HTTPS 版本的 Nginx server 块替换为下面的 HTTP 版本。不要同时保留“80 端口跳转 HTTPS”的 server 块，否则浏览器仍会被重定向到 HTTPS。

```nginx
server {
    listen 80;
    server_name ai-platform.intra.example;

    client_max_body_size 75m;

    location = /_ldap_verify {
        internal;
        proxy_pass http://127.0.0.1:8081/auth/verify;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header Host $host;
        proxy_set_header Cookie $http_cookie;
    }

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
        root /opt/ai-training-platform/apps/web/dist;
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
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_pass http://127.0.0.1:3000;
        proxy_read_timeout 300s;
    }

    location / {
        auth_request /_ldap_verify;
        error_page 401 =302 /auth/login?returnTo=$request_uri;
        root /opt/ai-training-platform/apps/web/dist;
        try_files $uri $uri/ /index.html;
    }
}
```

检查并重载：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## 3. 验收

```bash
curl -I http://ai-platform.intra.example/
curl -I http://ai-platform.intra.example/login-logo.png
curl http://127.0.0.1:3000/api/v1/health
curl http://127.0.0.1:8081/healthz
```

浏览器访问 `http://ai-platform.intra.example/`，登录后进入个人中心确认工号、姓名和部门来自 LDAP3。不要把 API 的 3000 端口或网关的 8081 端口暴露给用户网络。

## 4. 仍然必须保持的边界

- LDAP 到目录服务器的链路仍使用 LDAPS 或 StartTLS；HTTP-only 只描述浏览器到 Nginx 的链路。
- API 继续使用 `TRUSTED_GATEWAY`，并继续校验 HMAC 签名身份头。
- API 和 LDAP3 网关继续只监听 `127.0.0.1`，不直接暴露到办公网。
- 一旦网络不再完全隔离，立即将 `INTRANET_HTTP_ONLY` 改回 `false`，恢复 HTTPS Nginx 配置，并保持 `LDAP_GATEWAY_COOKIE_SECURE=true`。
