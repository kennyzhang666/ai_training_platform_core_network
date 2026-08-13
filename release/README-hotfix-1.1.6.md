# v1.1.6 Linux 热补丁包

本分支只存放构建好的热补丁归档，供无法构建项目的机器直接下载。
`release/` 平时被 `.gitignore` 忽略，这些文件是刻意强制加入的。

## 文件

- `ai-training-platform-1.1.6-hotfix-linux-x64.tar.gz`
- `ai-training-platform-1.1.6-hotfix-linux-x64.tar.gz.sha256`

SHA256：`38f3e13cbad8a90da23d17c0be7a434d945831b0c866760182bc6e78a86734aa`

## 构建来源

由以下两个分支合并后构建，**不是**任何单一分支的产物：

- `feat/v1.1.6-admin-score-visibility`（管理端评测分数可见）
- `fix/v1.1.5-hotfix-version-gate-and-degraded-start`（安装器版本闸 + Code Agent 降级启动）

安装器修复是必需的：main 上的 `apply-hotfix.sh` 读取发布包中不存在的根
`package.json`，不带这个修复的包在任何真实部署上都装不上。

## 使用

归档内没有顶层目录，解压前先建目录：

```bash
mkdir -p hotfix-1.1.6
tar -xzf ai-training-platform-1.1.6-hotfix-linux-x64.tar.gz -C hotfix-1.1.6
cd hotfix-1.1.6
sudo ./apply-hotfix.sh /opt/ai-training
```

适用于 `VERSION` 为 v1.1.0–v1.1.3 的单服务器部署，无数据库迁移。
详见归档内的 `HOTFIX_GUIDE.md`。
