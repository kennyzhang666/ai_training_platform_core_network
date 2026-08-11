# 运维日志脱敏工具输入输出用例

## 1. 运行约定

工具处理 UTF-8 行式日志文件，每一行独立处理。单行内容可以是普通文本、JSON 对象或 JSON 数组。

```text
python src/log_redactor.py \
  --input input.log \
  --output output.log \
  --policy policy/redaction_policy.json
```

关联字段 `user_id`、`device_id` 使用 HMAC-SHA256 生成稳定别名。只有输入包含关联字段时才需要提供 `LOG_REDACTION_KEY`。平台评测时由评测环境注入密钥，交付件中不得包含真实密钥。

以下需要关联别名的用例统一使用测试密钥：

```text
training-example-key-2026
```

Linux：

```bash
export LOG_REDACTION_KEY="training-example-key-2026"
```

Windows PowerShell：

```powershell
$env:LOG_REDACTION_KEY="training-example-key-2026"
```

## 2. 策略样例

`policy/redaction_policy.json`：

```json
{
  "version": "2.0",
  "maxLineChars": 4096,
  "keyEnv": "LOG_REDACTION_KEY",
  "secretFields": [
    "authorization",
    "password",
    "token",
    "access_token",
    "api_key",
    "secret"
  ],
  "correlationFields": [
    "user_id",
    "device_id"
  ],
  "textRulePriority": [
    "authorization",
    "url_query_secret",
    "key_value_secret",
    "correlation_identifier",
    "identity_number",
    "mobile",
    "email",
    "ipv4",
    "mac"
  ]
}
```

## 3. 完整输入文件

`input.log`：

```text
2026-08-11T10:30:00+08:00 service=payment level=INFO message=health-check-ok
告警 mobile=13800138000 id=11010519491231002X email=alice@example.com client_ip=10.24.8.16 mac=AA:BB:CC:DD:EE:FF
login password=Passw0rd! token=tok_demo_123 api_key=key_demo_456 status=failed
Authorization: Bearer token-abc GET https://ops.example.com/query?access_token=secret123&api_key=key456&mode=full
user_id=E10001 device_id=DEVICE-008 action=login
{"event":"login","user_id":"u-1001","device_id":"dev-8","password":"P@ssw0rd","profile":{"phone":"13800138000","email":"alice@example.com"},"retry":2,"success":true,"trace":null}
[{"Authorization":"Bearer abc","User-Id":"u-1001","count":3},{"TOKEN":12345,"enabled":false}]
服务=支付中心 联系人邮箱=zhangsan@example.cn 手机=13912345678 结果=处理完成
mobile=138****8000 email=a***@example.com user_id=hmac:7551cfce828d23f70aa8c659 token=***
{"token":"abc123",bad-json}
```

## 4. 完整输出文件

使用上述策略与测试密钥时，`output.log` 应为：

```text
2026-08-11T10:30:00+08:00 service=payment level=INFO message=health-check-ok
告警 mobile=138****8000 id=110105********002X email=a***@example.com client_ip=10.24.*.* mac=AA:BB:**:**:**:**
login password=*** token=*** api_key=*** status=failed
Authorization: *** GET https://ops.example.com/query?access_token=***&api_key=***&mode=full
user_id=hmac:7551cfce828d23f70aa8c659 device_id=hmac:847ef0930c758ed5cf03486b action=login
{"device_id":"hmac:bd71fa057c379b76790c1df7","event":"login","password":"***","profile":{"email":"a***@example.com","phone":"138****8000"},"retry":2,"success":true,"trace":null,"user_id":"hmac:3af787ad5956176c25a3e759"}
[{"Authorization":"***","User-Id":"hmac:3af787ad5956176c25a3e759","count":3},{"TOKEN":"***","enabled":false}]
服务=支付中心 联系人邮箱=z***@example.cn 手机=139****5678 结果=处理完成
mobile=138****8000 email=a***@example.com user_id=hmac:7551cfce828d23f70aa8c659 token=***
[REDACTION_ERROR:MALFORMED_JSON]
```

## 5. 普通文本用例

### 用例 01：无敏感信息

输入：

```text
2026-08-11T10:30:00+08:00 service=payment level=INFO message=health-check-ok
```

输出：

```text
2026-08-11T10:30:00+08:00 service=payment level=INFO message=health-check-ok
```

非敏感内容保持不变。

### 用例 02：手机号、身份证、邮箱、IPv4 和 MAC

输入：

```text
告警 mobile=13800138000 id=11010519491231002X email=alice@example.com client_ip=10.24.8.16 mac=AA:BB:CC:DD:EE:FF
```

输出：

```text
告警 mobile=138****8000 id=110105********002X email=a***@example.com client_ip=10.24.*.* mac=AA:BB:**:**:**:**
```

处理规则：

- 手机号保留前三位和后四位；
- 身份证号保留前六位和后四位；
- 邮箱保留本地部分首字符和完整域名；
- IPv4 保留前两段；
- MAC 保留前两段。

### 用例 03：键值形式的凭据

输入：

```text
login password=Passw0rd! token=tok_demo_123 api_key=key_demo_456 status=failed
```

输出：

```text
login password=*** token=*** api_key=*** status=failed
```

凭据不保留长度、前缀或后缀。

### 用例 04：Authorization 请求头和 URL 查询参数

输入：

```text
Authorization: Bearer token-abc GET https://ops.example.com/query?access_token=secret123&api_key=key456&mode=full
```

输出：

```text
Authorization: *** GET https://ops.example.com/query?access_token=***&api_key=***&mode=full
```

非敏感查询参数 `mode=full` 保持不变。

### 用例 05：关联标识

输入：

```text
user_id=E10001 device_id=DEVICE-008 action=login
```

输出：

```text
user_id=hmac:7551cfce828d23f70aa8c659 device_id=hmac:847ef0930c758ed5cf03486b action=login
```

相同原值与相同密钥必须产生相同别名。更换原值或密钥后，别名必须变化。

### 用例 06：Unicode 保真

输入：

```text
服务=支付中心 联系人邮箱=zhangsan@example.cn 手机=13912345678 结果=处理完成
```

输出：

```text
服务=支付中心 联系人邮箱=z***@example.cn 手机=139****5678 结果=处理完成
```

中文和其他非敏感 Unicode 内容不得转义或丢失。

## 6. JSON 用例

### 用例 07：嵌套 JSON 对象

输入：

```json
{"event":"login","user_id":"u-1001","device_id":"dev-8","password":"P@ssw0rd","profile":{"phone":"13800138000","email":"alice@example.com"},"retry":2,"success":true,"trace":null}
```

输出：

```json
{"device_id":"hmac:bd71fa057c379b76790c1df7","event":"login","password":"***","profile":{"email":"a***@example.com","phone":"138****8000"},"retry":2,"success":true,"trace":null,"user_id":"hmac:3af787ad5956176c25a3e759"}
```

要求：

- 递归处理嵌套对象；
- JSON 键按稳定顺序输出；
- 数值 `2`、布尔值 `true` 和空值 `null` 保持原数据类型；
- 输出使用紧凑 JSON，不插入无意义空格；
- 非 ASCII 内容使用 UTF-8 原文输出。

### 用例 08：JSON 数组、字段名大小写和连字符

输入：

```json
[{"Authorization":"Bearer abc","User-Id":"u-1001","count":3},{"TOKEN":12345,"enabled":false}]
```

输出：

```json
[{"Authorization":"***","User-Id":"hmac:3af787ad5956176c25a3e759","count":3},{"TOKEN":"***","enabled":false}]
```

字段名比较不区分大小写，连字符按下划线处理。敏感字段无论原值是字符串、数值、布尔值还是空值，均输出字符串 `***`。

### 用例 09：结构化输入解析失败

输入：

```text
{"token":"abc123",bad-json}
```

输出：

```text
[REDACTION_ERROR:MALFORMED_JSON]
```

以 `{` 或 `[` 开头的内容视为结构化输入。JSON 解析失败时不得降级为普通文本处理，也不得回显原始内容。

## 7. 稳定性与安全用例

### 用例 10：重复脱敏保持幂等

输入：

```text
mobile=138****8000 email=a***@example.com user_id=hmac:7551cfce828d23f70aa8c659 token=***
```

输出：

```text
mobile=138****8000 email=a***@example.com user_id=hmac:7551cfce828d23f70aa8c659 token=***
```

同一策略和密钥下，对已脱敏结果再次执行处理，输出必须逐字相同。

### 用例 11：输入超过最大行长

当输入行字符数超过策略中的 `maxLineChars` 时，输出：

```text
[REDACTION_ERROR:LINE_TOO_LONG]
```

不得截断后继续处理，也不得输出超长原文的任何片段。

可使用以下命令构造 4097 字符输入：

```bash
python -c "print('A' * 4097)" > long-line.log
```

### 用例 12：缺少 HMAC 密钥但不存在关联字段

输入：

```text
mobile=13800138000 token=tok_demo_123
```

未设置 `LOG_REDACTION_KEY` 时仍可正常输出：

```text
mobile=138****8000 token=***
```

### 用例 13：缺少 HMAC 密钥且存在关联字段

输入：

```text
user_id=E10001 action=login
```

未设置 `LOG_REDACTION_KEY` 时，公开函数应抛出稳定错误码：

```text
KEY_UNAVAILABLE
```

命令行应满足：

```text
退出码：2
标准错误：ERROR KEY_UNAVAILABLE
```

标准错误不得包含 `E10001` 或原始日志内容。

### 用例 14：无效策略

以下任一情况均视为无效策略：

- 缺少必需字段；
- `version` 不是 `2.0`；
- `maxLineChars` 不是整数或超出允许范围；
- `keyEnv` 名称不合法；
- 字段集合类型错误；
- `textRulePriority` 缺项、顺序改变或包含未知规则。

命令行应满足：

```text
退出码：2
标准错误：ERROR POLICY_INVALID
```

### 用例 15：输入输出文件失败

输入文件不存在、目标目录不可写或原子替换失败时，命令行应满足：

```text
退出码：2
标准错误：ERROR IO_ERROR
```

不得留下部分输出文件或包含原始日志的异常堆栈。

## 8. Python 接口用例

### `load_policy`

```python
from src.log_redactor import load_policy

policy = load_policy("policy/redaction_policy.json")
assert policy["version"] == "2.0"
assert policy["maxLineChars"] == 4096
```

### `redact_line`

```python
from src.log_redactor import redact_line

output = redact_line(
    "mobile=13800138000 token=tok_demo_123",
    key="training-example-key-2026",
)

assert output == "mobile=138****8000 token=***"
```

### `redact_stream`

输入：

```text
2026-08-11T10:30:00+08:00 service=payment level=INFO message=health-check-ok
告警 mobile=13800138000 id=11010519491231002X email=alice@example.com client_ip=10.24.8.16 mac=AA:BB:CC:DD:EE:FF
{"token":"abc123",bad-json}
```

输出：

```text
2026-08-11T10:30:00+08:00 service=payment level=INFO message=health-check-ok
告警 mobile=138****8000 id=110105********002X email=a***@example.com client_ip=10.24.*.* mac=AA:BB:**:**:**:**
[REDACTION_ERROR:MALFORMED_JSON]
```

返回统计：

```json
{
  "lines": 3,
  "redacted": 2,
  "errors": 1
}
```

接口调用：

```python
from io import StringIO
from src.log_redactor import redact_stream

reader = StringIO(
    "2026-08-11T10:30:00+08:00 service=payment level=INFO message=health-check-ok\n"
    "告警 mobile=13800138000 id=11010519491231002X "
    "email=alice@example.com client_ip=10.24.8.16 "
    "mac=AA:BB:CC:DD:EE:FF\n"
    '{"token":"abc123",bad-json}\n'
)
writer = StringIO()

stats = redact_stream(
    reader,
    writer,
    key="training-example-key-2026",
)

assert stats == {"lines": 3, "redacted": 2, "errors": 1}
```

## 9. 命令行用例

### Linux

```bash
LOG_REDACTION_KEY="training-example-key-2026" \
python src/log_redactor.py \
  --input input.log \
  --output output.log \
  --policy policy/redaction_policy.json

echo $?
```

成功时退出码为 `0`。

### Windows PowerShell

```powershell
$env:LOG_REDACTION_KEY="training-example-key-2026"
python src/log_redactor.py `
  --input input.log `
  --output output.log `
  --policy policy/redaction_policy.json

$LASTEXITCODE
```

成功时 `$LASTEXITCODE` 为 `0`。

## 10. 批处理要求

- 输入必须逐行迭代，禁止使用 `read()` 或 `readlines()` 一次性加载完整文件；
- 每个输入元素只能处理一次；
- 每个输出元素以一个换行符结束；
- 普通文本保持非敏感字符顺序；
- JSON 保持对象、数组、数值、布尔值和空值语义；
- 单行错误只输出稳定错误标记，并继续处理下一行；
- 策略、密钥和文件错误终止整个命令；
- 输出先写入目标目录中的临时文件，全部成功后原子替换正式结果；
- 执行失败时删除临时文件，不留下半成品；
- 终端输出不得包含日志原文、密钥、测试凭据或异常堆栈。

## 11. 验收检查

- [ ] 普通文本中的手机号、身份证号、邮箱、IPv4 和 MAC 均按规则脱敏；
- [ ] Authorization、password、token、access_token、api_key 和 secret 不保留原值；
- [ ] URL 中的非敏感参数保持不变；
- [ ] JSON 对象和数组支持任意层级递归；
- [ ] JSON 非敏感数值、布尔值和空值类型保持不变；
- [ ] 字段名比较不区分大小写，连字符和下划线按统一字段名处理；
- [ ] 同一原值和密钥产生相同 HMAC 别名；
- [ ] 不同原值或不同密钥产生不同 HMAC 别名；
- [ ] 已脱敏内容再次处理后保持不变；
- [ ] 畸形 JSON 和超长行不回显原文；
- [ ] 缺少密钥、策略无效和文件错误只返回稳定错误码；
- [ ] 处理大文件时保持逐行读取；
- [ ] 命令成功后原子生成完整输出；
- [ ] 命令失败后不保留部分结果。
