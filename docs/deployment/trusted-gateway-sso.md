# TRUSTED_GATEWAY 统一认证接入手册

本文给内网网络、统一认证和平台部署团队使用。平台不负责实现登录页；统一认证网关负责登录，平台 API 只接收网关验证后转发的签名身份。

## 1. 推荐部署拓扑

```text
浏览器
  |
  v
内网统一认证网关
  |-- 校验 SSO 会话
  |-- 读取工号、姓名、部门
  |-- 生成 HMAC 身份签名
  |-- /       -> Web 静态资源
  `-- /api/   -> Platform API
                  |
                  `-- PostgreSQL / 对象存储 / Evaluation Worker
```

Web 和 API 尽量使用同一个域名，例如：

```text
https://ai-platform.intra/
https://ai-platform.intra/api/v1
```

API 只允许统一认证网关访问，不要把 API 端口直接暴露给普通用户。现有平台代码已经实现 `TRUSTED_GATEWAY` 校验，接入侧主要是网关配置和生产环境变量。

## 2. 网关到 API 的身份协议

网关对每个转发到 API 的请求加入以下请求头：

| 请求头 | 内容 |
| --- | --- |
| `X-Trusted-Employee-No` | SSO 返回的固定工号 |
| `X-Trusted-Name` | SSO 返回的真实姓名 |
| `X-Trusted-Department` | SSO 返回的部门名称、部门 ID 或组织路径 |
| `X-Trusted-Issued-At` | UTC ISO-8601 时间，例如 `2026-08-05T03:00:00.000Z` |
| `X-Trusted-Identity-Signature` | HMAC-SHA256 签名，小写十六进制 |

签名原文必须严格按照下面格式拼接，字段之间是单个换行：

```text
employeeNo\nissuedAt\nname\ndepartment
```

签名算法：

```text
HMAC-SHA256(TRUSTED_GATEWAY_HMAC_SECRET, canonicalText)
```

姓名或部门为空时仍保留空字段和换行，不能省略字段。平台默认只接受 90 秒内的签名，可通过 `TRUSTED_GATEWAY_MAX_AGE_SECONDS` 调整。

## 3. 网关必须做的安全处理

1. 先完成 SSO 会话校验，再读取员工字段。
2. 删除浏览器原始请求里的 `X-Employee-Id`、`X-Trusted-*` 和其他同名身份头，防止用户伪造。
3. 只由网关重新生成并写入签名身份头。
4. 网关与 API 之间使用内网 ACL、TLS 或服务网格策略限制来源。
5. 共享密钥只存放在网关和 API 的密钥管理系统中，不写入前端、Git、日志或浏览器 Cookie。
6. 不要把姓名、工号、部门和签名写入普通访问日志；如必须审计，按公司隐私要求脱敏。

`X-Trusted-*` 不是给浏览器使用的登录协议。浏览器只携带网关的登录会话，身份头只存在于网关到 API 的内网请求段。

## 4. 平台 API 配置

生产 API 的环境变量至少包括：

```env
NODE_ENV=production
PLATFORM_IDENTITY_MODE=TRUSTED_GATEWAY
TRUSTED_GATEWAY_HMAC_SECRET=替换为密钥管理系统注入的随机密钥
TRUSTED_GATEWAY_MAX_AGE_SECONDS=90

# 生产存储，不要使用 file 适配器
PLATFORM_REPOSITORY=postgres
DATABASE_URL=postgresql://platform:***@postgres.internal:5432/ai_training_platform

# Web 与 API 同域时使用相对地址
# Web 构建阶段：VITE_API_BASE=/api/v1
CORS_ORIGINS=https://ai-platform.intra
```

不要在生产环境设置 `PLATFORM_IDENTITY_MODE=LOCAL`，也不要启用 `ALLOW_ANONYMOUS_LOCAL=true`。

## 5. 网关适配器伪代码

下面是语言无关的流程，不能把密钥硬编码到配置仓库：

```text
claims = sso.authenticate(request)
employeeNo = claims.employeeNo
name = claims.name
department = claims.department
issuedAt = utcNowIso()
canonical = employeeNo + "\\n" + issuedAt + "\\n" + name + "\\n" + department
signature = hmacSha256Hex(secretFromKeyStore, canonical)

removeRequestHeader("X-Employee-Id")
removeRequestHeaders("X-Trusted-*")
proxyRequest.headers["X-Trusted-Employee-No"] = employeeNo
proxyRequest.headers["X-Trusted-Name"] = name
proxyRequest.headers["X-Trusted-Department"] = department
proxyRequest.headers["X-Trusted-Issued-At"] = issuedAt
proxyRequest.headers["X-Trusted-Identity-Signature"] = signature
forward(proxyRequest)
```

如果现有网关不能执行 HMAC，可以在网关同一内网增加一个很小的身份适配器服务；适配器只负责“验证 SSO 会话 + 生成签名头”，不承载平台业务权限。

## 6. 身份同步和权限规则

平台第一次收到某工号的可信请求时，会按工号幂等登记员工，并同步 SSO 姓名和部门提示。

- 工号是平台身份主键，员工不能在平台修改。
- 姓名是统一认证主数据，员工不能在平台修改。
- 部门会尝试匹配平台组织树；匹配不到时保留 SSO 部门提示，由全局管理员处理。
- 昵称和头像是平台个人资料，可以由员工自行维护。
- 管理员角色、角色范围和部门管理员权限仍由平台管理，不建议直接由 SSO 部门字段授予管理员权限。

生产环境不要调用 `POST /api/v1/auth/sso` 来伪造登录身份；该接口只保留给本地适配器和测试，生产请求身份以 Guard 校验后的网关头为准。

## 7. 前端和反向代理配置

前端构建时使用同域 API：

```env
VITE_API_BASE=/api/v1
```

网关需要把 `/api/` 转发到 Platform API，把其他路径转发到 Web 静态服务，并正确传递：

- `GET`、`POST`、`PUT`、`PATCH`、`DELETE`、`OPTIONS`；
- `Content-Type`、上传请求体和响应状态码；
- 平台返回的 `X-Request-Id`，方便问题追踪。

不要让浏览器跨域直连 API；同域部署可以减少 CORS、Cookie 和身份头泄露风险。

## 8. 上线前验收

### 认证正向用例

- 未登录访问平台会跳转统一认证。
- 登录后 `/api/v1/me` 返回对应工号的员工资料。
- 新工号首次访问自动建档，重复访问不会产生重复员工。
- SSO 姓名变化会同步；平台昵称不被覆盖。
- 部门能匹配组织树时自动归属，不能匹配时显示待管理员处理。

### 安全反向用例

- 浏览器直接伪造 `X-Employee-Id` 不能冒充其他员工。
- 修改任意 `X-Trusted-*` 字段但不改签名时返回 401。
- 签名超过有效时间返回 401。
- 直接访问 API（绕过网关）被网络策略拒绝。
- 网关和 API 日志中不出现密钥、Cookie、SSO Token 或完整身份断言。

### 管理权限用例

- 普通员工不能访问管理接口。
- 部门管理员只能访问授权组织范围。
- 全局管理员才能配置组织、角色和评测环境。
- SSO 部门字段变化不会自动扩大管理员权限范围。

## 9. 故障排查

| 现象 | 优先检查 |
| --- | --- |
| 401 `trusted gateway identity is missing` | 网关是否向 API 转发了五个 `X-Trusted-*` 请求头 |
| 401 `trusted gateway identity is invalid` | 两端密钥、签名原文、换行、字段顺序和大小写 |
| 401 `trusted gateway identity is expired` | 网关服务器时钟、`X-Trusted-Issued-At` 和最大年龄 |
| 登录成功但员工不存在 | API 是否运行在 `TRUSTED_GATEWAY`，数据库是否可写，工号字段映射是否正确 |
| 员工显示未配置部门 | SSO 部门没有匹配平台组织树，需要全局管理员处理 |
| 页面能打开但 API 失败 | `VITE_API_BASE`、网关 `/api/` 路由和 API 来源 ACL |

## 10. 相关实现文件

- `services/platform-api/src/identity.ts`：模式配置、HMAC 验证和 OIDC 验证。
- `services/platform-api/src/identity-guard.ts`：请求级身份校验和 SSO 首次建档。
- `services/platform-api/src/user-directory.ts`：工号幂等同步、部门匹配和用户资料。
- `.env.example`：本地和生产身份环境变量示例。
- `docs/architecture/security-boundary.md`：平台整体安全边界。
