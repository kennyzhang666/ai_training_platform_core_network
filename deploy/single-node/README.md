# 单服务器部署

该模式同时支持 Windows x64 与 Linux x64 内网服务器，面向单场 50–100 人。PostgreSQL、平台 API、Web、认证网关和评测 Worker 均运行在同一台服务器；交付件与评测引擎保存在本地磁盘。API 不执行学员代码，评测由同机独立 Worker 和 Code Agent 完成。

## 目标服务器

- PostgreSQL 16 或 17；
- Code Agent（例如 OpenCode）；
- 企业 LDAP/SSO 可访问。

离线发布包已携带 Node、Python、Nginx、LDAP Python 依赖、生产 Node 依赖和评测 wheelhouse；Windows 包同时携带 PowerShell。目标机不执行 `git pull`、`pnpm install` 或 `pnpm build`，部署脚本也不会联网下载或自动安装 PostgreSQL。

## 创建数据库

使用 PostgreSQL 自带的 pgAdmin 或 `psql` 创建独立用户和数据库。用户名、数据库名可以调整，但必须与 `.env` 中的 `DATABASE_URL` 一致：

~~~sql
CREATE ROLE ai_training LOGIN PASSWORD '<独立强密码>';
CREATE DATABASE ai_training OWNER ai_training ENCODING 'UTF8';
~~~

PostgreSQL 只需监听本机 `127.0.0.1:5432`。不要把数据库端口加入办公网入站规则，也不要把真实密码写入 Git。

## 离线发布包部署

Windows 将 ZIP 解压到短路径，例如 `C:\AITraining`：

~~~powershell
Copy-Item deploy/single-node/.env.example deploy/single-node/.env
# 编辑 .env，填写 DATABASE_URL、LDAP、两条随机密钥、首位管理员、Worker 和 Code Agent
deploy\single-node\manage.cmd Prepare
deploy\single-node\manage.cmd Doctor
deploy\single-node\manage.cmd Start
~~~

Linux 将 tar.gz 解压到固定目录，例如 `/opt/ai-training`：

~~~bash
cp deploy/single-node/.env.example deploy/single-node/.env
# 编辑 .env，填写 DATABASE_URL、LDAP、两条随机密钥、首位管理员、Worker 和 Code Agent
./deploy/single-node/manage.sh Prepare
./deploy/single-node/manage.sh Doctor
./deploy/single-node/manage.sh Start
~~~

`Prepare` 会连接同机 PostgreSQL 并执行全部版本化迁移；`Doctor` 会检查运行时、配置、Nginx 和数据库迁移状态。数据库无法连接、配置仍有占位值或迁移失败时不会继续。

两套发布包的生成、运行时输入和 SHA-256 门禁见 [`docs/deployment/offline-dual-platform-release.md`](../../docs/deployment/offline-dual-platform-release.md)。

## 源码工作区准备

源码方式只供开发和发布机使用。安装 Node.js 20+、pnpm 11.8.0、Python 3.11+、Nginx 和 PowerShell 7 后，执行：

~~~powershell
Copy-Item deploy/single-node/.env.example deploy/single-node/.env
pnpm install --offline --frozen-lockfile
pnpm build
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --no-index --find-links deploy/single-node/wheelhouse -r grader/requirements.txt
python -m venv services/ldap3-gateway/.venv
.\services\ldap3-gateway\.venv\Scripts\python.exe -m pip install --no-index --find-links deploy/single-node/wheelhouse -r services/ldap3-gateway/requirements.txt
.\deploy\single-node\manage.ps1 Prepare
~~~

## 日常操作

~~~powershell
.\deploy\single-node\manage.ps1 Start
.\deploy\single-node\manage.ps1 Status
.\deploy\single-node\manage.ps1 Stop
~~~

~~~bash
./deploy/single-node/manage.sh Start
./deploy/single-node/manage.sh Status
./deploy/single-node/manage.sh Stop
~~~

默认入口为 http://服务器地址:8080/。HTTP 仅适用于隔离内网；已有企业证书时，使用 docs/deployment/ldap3-nginx-intranet-deployment.md 的 HTTPS Nginx 配置替换本目录的 HTTP 模板。

首次由 .env 中 PLATFORM_BOOTSTRAP_GLOBAL_ADMIN_EMPLOYEE_NO 对应的员工登录。只有系统尚无全局管理员时，该工号才会获得全局管理员权限。确认成功后可以删除该配置。

## 备份与恢复

~~~powershell
.\deploy\single-node\manage.ps1 Backup
.\deploy\single-node\manage.ps1 Restore -Archive D:\backup\ai-training-single-node-20260809-120000.zip
~~~

~~~bash
./deploy/single-node/manage.sh Backup
./deploy/single-node/manage.sh Restore --archive /backup/ai-training-single-node-20260810-120000.tar.gz
~~~

备份操作会短暂停止平台进程，在 Windows ZIP 或 Linux tar.gz 中写入 PostgreSQL 一致性快照和本地交付件目录，然后自动恢复原运行状态。备份不包含 `.env`，数据库密码和密钥应由运维单独保管。恢复先校验备份，再以数据库事务导入；原本地交付件保留在 `data.before-restore-*`。恢复失败时会自动放回原交付件，失败数据保留在 `data.failed-restore-*` 供排查。尚未确认的上传不进入备份，恢复后需要重新上传；旧上传临时文件会保留在 `runtime-state/artifact-uploads.before-restore-*`。

## 数据边界

- 正式单服务器档固定使用 PostgreSQL；JSON 文件仓储只用于开发和演示。
- 只启动一个 API 进程；平台会将集中到来的领域写入按序提交，避免快照版本争抢。
- 100 人集中提交与有界队列闭环已进入自动验收；实际评测耗时仍由 Worker、Code Agent 和赛题引擎决定。
- 数据库与 `data` 目录必须使用同一份备份；`runtime-state` 是日志、PID 和临时批次，可重建。
- 评测期间不要手工修改数据库、交付件或引擎包。
