# AI 训战平台 v@@VERSION@@ Linux 热补丁指导书

适用范围：通过单服务器离线包部署在 Linux `/opt/ai-training` 的 `v1.1.0`–`v1.1.2`。本补丁只替换平台 API 和网页构建产物，不修改 PostgreSQL、交付件、评测引擎、配置文件或历史记录。

## 修复内容

- 修复评测失败后再次发起评测产生相同幂等键、PostgreSQL 返回 500 的问题。
- 失败重试会自动创建新的评测次数、运行记录和批次，保留原交付件与失败历史。
- 评测中心对失败记录显示“重新评测”。

## 操作步骤

将 `ai-training-platform-@@VERSION@@-hotfix-linux-x64.tar.gz` 上传到服务器，例如 `/opt`：

```bash
cd /opt
sha256sum -c ai-training-platform-@@VERSION@@-hotfix-linux-x64.tar.gz.sha256
mkdir -p ai-training-hotfix-@@VERSION@@
tar -xzf ai-training-platform-@@VERSION@@-hotfix-linux-x64.tar.gz -C ai-training-hotfix-@@VERSION@@
cd ai-training-hotfix-@@VERSION@@
sudo ./apply-hotfix.sh /opt/ai-training /opt/ai-training/deploy/single-node/.env
```

脚本会依次执行文件校验、原构建产物备份、停止服务、替换、启动和健康检查。失败会自动恢复原构建产物。

## 验证

```bash
cat /opt/ai-training/runtime-state/hotfix-version.json
/opt/ai-training/deploy/single-node/manage.sh Status --environment /opt/ai-training/deploy/single-node/.env
curl -I http://127.0.0.1:8080/
```

进入管理后台评测中心，失败记录应显示“重新评测”。点击后会直接创建新批次，不需要删除提交。

## 手动回滚

脚本最后会打印备份目录。需要回滚时，将下面的 `<备份目录>` 替换为实际路径：

```bash
cd /opt/ai-training
sudo ./deploy/single-node/manage.sh Stop --environment ./deploy/single-node/.env
sudo rm -rf ./services/platform-api/dist ./apps/web/dist
sudo tar -xzf <备份目录>/application-dist-before.tar.gz -C /opt/ai-training
sudo ./deploy/single-node/manage.sh Start --environment ./deploy/single-node/.env
```

不要删除或重建数据库，不要删除 `data/`、`runtime-state/evaluation-*` 或员工交付件。

