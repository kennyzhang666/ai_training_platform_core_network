# AI 能力训战平台单服务器离线包

本目录是已经构建完成的运行包，不需要 Git、pnpm、前端构建或互联网。正式业务数据使用同机 PostgreSQL，交付件和评测引擎保存在本地 `data/`；评测由独立 Worker 与管理员配置的 Code Agent 完成。

首次使用：

1. 将 `deploy/single-node/.env.example` 复制为同目录 `.env`；
2. 填写 PostgreSQL、LDAP、首位管理员、Worker 身份、平台地址和 Code Agent；
3. Windows 运行 `deploy\single-node\manage.cmd Prepare`，Linux 运行 `./deploy/single-node/manage.sh Prepare`；
4. 执行 `Doctor`，检查通过后执行 `Start`。

日常操作在两个平台上均为 `Start`、`Stop`、`Status`、`Backup`、`Restore`、`Doctor`。Windows 通过 `manage.cmd` 使用包内 PowerShell，Linux 通过 `manage.sh` 使用包内 Node、Python 和 Nginx；不要改用系统 Node 或手工启动子进程。

发布包不包含数据库密码、LDAP 凭据、真实员工数据、证书或 Code Agent 令牌。`release-manifest.json` 记录包内每个文件的 SHA-256；同目录的压缩包 `.sha256` 文件用于传输后校验。

PostgreSQL、Code Agent 和企业 LDAP 必须由目标环境提供。Node、Python、Nginx、LDAP Python 依赖、评测 wheelhouse 随对应平台包提供；Windows 包另含 PowerShell 和后续服务化使用的包装器。
