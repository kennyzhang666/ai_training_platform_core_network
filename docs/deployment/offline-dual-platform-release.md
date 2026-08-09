# Windows / Linux 单服务器离线发布

平台分别生成 `win32-x64` 和 `linux-x64` 两个发布包。两个包使用同一套业务契约、PostgreSQL Schema、数据库迁移、Web/API 构建产物和 Worker 协议，仅运行时及管理入口不同。

## 发布边界

- 目标服务器不需要 Git、pnpm、前端构建工具或互联网；
- 发布包携带 Node、Python、Nginx、LDAP Python 依赖、生产 Node 依赖、迁移、Worker、契约和离线 wheelhouse；Windows 包同时携带 PowerShell 7；
- 目标服务器仍需提供同机 PostgreSQL、可访问的企业 LDAP，以及管理员选定的 Code Agent；
- Windows 和 Linux 必须分别在相同系统与 x64 架构的发布机上构建。Prisma 引擎、Python 扩展和 Nginx 不能跨系统复用；Linux 发布机还应与目标服务器保持兼容的发行版和 glibc 基线。

## 运行时输入目录

Windows 发布机准备以下目录：

```text
win32-x64/
├─ node/node.exe
├─ powershell/pwsh.exe
├─ python/python.exe
├─ nginx/nginx.exe
├─ nginx/conf/mime.types
└─ service/winsw.exe
```

Linux 发布机准备以下目录：

```text
linux-x64/
├─ node/bin/node
├─ python/bin/python3
├─ nginx/sbin/nginx
└─ nginx/conf/mime.types
```

目录中必须保留各运行时正常工作所需的其余文件。Python 运行时必须支持 `venv`、pip 的 `--python` 参数，并已安装 `ldap3`；Linux 目录内的符号链接不得指向目录外。发布任务会实际启动 Node、Python、Nginx，并在 Windows 上启动 PowerShell 做版本检查。

每个平台还要准备独立 wheelhouse。除平台固定依赖外，应覆盖所有已发布赛题引擎的 `requirements.txt`；目标机不会回退到公网下载。

## 生成发布包

Windows x64：

```powershell
pnpm release:build -- --target win32-x64 `
  --runtime-root D:\release-inputs\win32-x64 `
  --wheelhouse D:\release-inputs\wheelhouse-win32-x64 `
  --version 0.9.5 `
  --source-date-epoch 1786320000
```

Linux x64：

```bash
pnpm release:build -- --target linux-x64 \
  --runtime-root /opt/release-inputs/linux-x64 \
  --wheelhouse /opt/release-inputs/wheelhouse-linux-x64 \
  --version 0.9.5 \
  --source-date-epoch 1786320000
```

默认输出：

- Windows：`release/ai-training-platform-<版本>-win32-x64.zip`；
- Linux：`release/ai-training-platform-<版本>-linux-x64.tar.gz`；
- 两个平台都会生成同名 `.sha256` 文件和包内 `release-manifest.json`。

`SOURCE_DATE_EPOCH`、源码、依赖和运行时输入相同时，归档字节应保持一致。构建会拒绝旧输出目录、错误平台、缺失运行时、空 wheelhouse、越界符号链接、平台源码/测试和真实 `.env`。

Windows 生产依赖采用实体化目录，不要求目标服务器开启开发者模式或符号链接权限。为兼容 Windows 路径限制，发布包应解压到短路径，例如 `C:\AITraining`。

## 发布门禁

```powershell
pnpm release:test
pnpm deployment:test
pnpm build
```

发布前还需在两台断网目标机分别完成：校验 SHA-256、复制正式配置、`Prepare`、`Doctor`、`Start`、SSO 登录、提交、批次评测、`Backup`、`Restore`。Windows 与 Linux 的结果必须使用同一评测契约回传，不能针对平台复制评分逻辑。
