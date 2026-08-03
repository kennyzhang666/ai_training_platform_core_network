# 赛题交付目录规范

每个赛题版本可以冻结一份 `submissionContractDefinition`。员工上传 ZIP 或平台固定 Git 版本时，会先校验目录结构；未通过的交付不会创建提交记录，也不会进入评测队列。

管理后台「赛题库 → 赛题版本 → 交付目录规范」提供源码项目和 Skills 交付模板，也可逐条配置必需文件、目录、扩展名、数量、禁止路径、额外文件策略和压缩包根目录。

## 1.1 字段

| 字段 | 作用 |
|---|---|
| `root.mode` | `ARCHIVE_ROOT`：文件直接位于 ZIP 根目录；`SINGLE_DIRECTORY`：只允许一个顶层目录 |
| `root.directoryName` | `SINGLE_DIRECTORY` 模式下约束顶层目录名称 |
| `required` | 必需文件、目录或 glob 匹配规则 |
| `optional` | 可选文件、目录或 glob 匹配规则 |
| `forbidden` | 禁止出现的路径规则 |
| `allowedPaths` | `allowAdditionalPaths=false` 时的路径白名单 |
| `allowAdditionalPaths` | 是否允许规则之外的文件 |
| `maxFiles` | 最大文件数 |
| `maxDepth` | 最大目录层级 |
| `languageEntry` | 不同语言必须存在的入口文件 |

规则类型支持 `directory`、`markdown`、`source`、`text`、`json` 和 `yaml`。`minFiles` 可约束目录内文件数或 glob 的最少匹配数；`allowedExtensions` 会校验匹配文件以及目录内的所有后代文件。

路径使用 `/`，支持 `*`、`**` 和 `?`，禁止绝对路径、盘符、反斜杠和 `..`。

## Skills 交付示例

```json
{
  "schemaVersion": "1.1",
  "root": { "mode": "ARCHIVE_ROOT" },
  "required": [
    { "path": "skills", "type": "directory", "minFiles": 1 },
    { "path": "skills/*/SKILL.md", "type": "markdown" }
  ],
  "optional": [
    { "path": "README.md", "type": "markdown" },
    { "path": "skills/**", "type": "text" }
  ],
  "forbidden": [
    "**/.env",
    "**/.git/**",
    "**/__pycache__/**",
    "**/*.pyc"
  ],
  "allowedPaths": ["README.md", "skills/**"],
  "allowAdditionalPaths": false,
  "maxDepth": 8,
  "maxFiles": 500
}
```

完整 Schema：`contracts/submission-contract-v1.1.schema.json`。可直接复用的模板：`contracts/examples/submission-contract.skills.valid.json`。

## 校验边界

平台接收提交时做结构预检：归档安全、根目录、路径、文件数、目录深度、必需项、禁止项、白名单、类型和扩展名。`minChars`、`minSections`、`mustExport`、函数签名等内容语义由该赛题的评测引擎继续校验，并写入详细评测报告。

校验失败返回 `DELIVERY_STRUCTURE_INVALID`，具体问题位于 `details.issues`。员工端会直接展示缺少的文件或不允许的路径，不显示内部路径和开发者说明。
