# 版本变更记录

本文件只记录发布事实；架构、开发流程、路线和运维说明分别以 `README.md`、`DESIGN.md`、`DEPLOYMENT.html` 为准。

## v0.9.8-docker.1 · 2026-08-10

- 新增 Linux amd64 生产应用镜像；同一不可变镜像分别运行 Web、API、独立评测 Worker 和 LDAP 登录网关，PostgreSQL 保持独立容器。
- 新增 Docker Compose 单服务器拓扑和 `Prepare / Doctor / Start / Stop / Status / Logs` 管理命令，只向办公网开放统一访问端口，并把数据库、交付件和评测状态保存在命名卷。
- 新增内含平台与 PostgreSQL 镜像的离线 Docker 发布包；断网服务器解压后不需要拉取镜像。
- 新增 GitHub Ubuntu 22.04 原生镜像构建、完整 Compose 启动冒烟、GHCR 推送、离线镜像往返校验和 GitHub Release 发布流水线。

## v0.9.8 · 2026-08-10

- 保留已发布的 `sdd-log-redaction-v1`，新增不可覆盖历史版本的 `sdd-log-redaction-v2`。
- 将赛题扩展为策略驱动、HMAC 关联标识、失败关闭和逐行流式批处理的 360 分钟进阶训战。
- 新增核心、复杂、安全、工程四层共 24 项评测方隐藏用例，并把功能事实接入 16 个评分点证据链。
- 新增满分参考交付件和 v1 风格弱实现强度回归；参考件 24/24、100 分，弱实现不得超过 75 分。
- 修复 Windows 动态端口可能连续落入 Fetch 禁用区间导致 100 人本地验收偶发无法启动的问题，改为显式申请安全端口并重试占用冲突。
- 为 Ubuntu 22.04 x64 增加从不可变版本标签构建的 GitHub Actions 原生离线发布流程，固定并校验 Node、Python、Nginx 运行时，生成 tar.gz、SHA-256 和运行时来源清单后上传 Release。
- 修复 Code Agent 命令白名单和 Windows npm 原生包装器在非 Windows 测试机上的路径解析差异；Linux 发布门禁只执行目标平台适用的部署检查。
- 修复 pnpm 在 Linux 上传递参数分隔符导致发布打包器误判空选项的问题，并兼容带或不带分隔符的发布命令。
- 修复全新检出中不存在 `release/` 父目录时首次打包无法创建输出目录的问题。
- 修复 Linux 运行时内部相对软链接在复制后被改写成构建机绝对路径的问题；发布准备阶段只固化指向运行时目录内部的文件链接。
- Linux 回补发布使用当前已审计打包器处理不可变版本标签，并在 GitHub Release 说明中记录打包器提交号，避免旧标签打包器破坏生产依赖的相对软链接。
- Linux 发布包只保存在 GitHub Release，不再重复上传受 Actions 临时附件配额限制的 30 天副本。
- GitHub Release 发布命令显式指定目标仓库，兼容同一工作目录同时检出发布工具和版本源码的构建方式。
