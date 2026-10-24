# HaHart 备份与恢复 (OP-08)

脚本：`backup.sh`（备份）、`verify-backup.sh`（校验）、`restore.sh`（恢复），均为 bash，需在 .37 的 WSL `hahart` 内运行。

## 定时任务（建议）
- systemd timer：每日 03:30（北京时间，`OnCalendar=*-*-* 03:30:00 Asia/Shanghai`）执行 `deploy/backup.sh`，成功后再跑 `verify-backup.sh <最新目录>`。
- 失败告警：service 的 `OnFailure=` 指向 OP-11 的告警回调（占位，待 OP-11 落地）。
- 默认备份到 `/mnt/g/hahart-backup/daily`（另一块物理盘）；日备份留 7 份，每周日那份复制到 `../weekly`，留 4 份。
- `HAHART_BACKUP_NOW` 仅供测试覆盖「现在」，生产环境不要设置。
- 备份内含 env 文件（密钥），备份盘需与生产同等保管。

## 恢复步骤
1. `verify-backup.sh <备份目录>`：校验 sha256、文件非空、`pg_restore --list` 可读。
2. 目标环境先 `docker compose up -d postgres`，再 `restore.sh <备份目录> --yes`（先校验，不一致退出码 3；不带 `--yes` 不执行任何还原）。
3. 手动按需从 `config.tar.gz` 取出 compose/nginx/env（脚本不会覆盖生产 env），然后 `docker compose up -d`。
4. 登录、看图、播放视频验证。

## QA-13 演练需记录的三份原始输出
1. 源环境的数据/对象 hash 清单（备份前）。
2. `verify-backup.sh` 的输出与退出码。
3. 空环境恢复后的数据/对象 hash 清单（与 1 差异应为 0）。
