# deploy/ 运维安装说明（.37，WSL `hahart`）

本目录下的脚本都要随 release 一起拷到 `.37`（见文末「发布包」一条），在 WSL `hahart` 发行版里安装。

---

## 一、网桥自愈单元（`fix-bridge-rules.sh` + `hahart-bridge-rules.service`）

**为什么要有它**：2026-10-24 `.37` 冷启动后，`hahart_default` 网桥的 iptables 规则整段丢失。这台机器开了 `bridge-nf-call-iptables=1`，容器之间的包（nginx → server）会走 iptables，规则没了就撞上 `FORWARD` 默认策略 `DROP`：静态页正常（nginx 自己发），`/api/*` 全 504。`docker.service` 那时已经是 `active`，所以「docker 起来了」不能当就绪判据 —— 由一个 `After=docker.service` 的 oneshot 单元把规则补回去（脚本是幂等的「只补不删」，同机别的项目的网桥不受影响）。

**怎么装**：

```bash
sudo install -m 0755 /opt/hahart/current/deploy/fix-bridge-rules.sh /opt/hahart/fix-bridge-rules.sh
sudo install -m 0644 /opt/hahart/current/deploy/hahart-bridge-rules.service /etc/systemd/system/hahart-bridge-rules.service
sudo systemctl daemon-reload
sudo systemctl enable --now hahart-bridge-rules.service
```

**怎么验**：

```bash
systemctl is-enabled hahart-bridge-rules.service    # 期望 enabled
systemctl is-active  hahart-bridge-rules.service    # 期望 active (exited)
iptables -S DOCKER-FORWARD | grep br-               # 期望看到 -i br-<id> -j ACCEPT
sudo /opt/hahart/fix-bridge-rules.sh                # 第二次手动运行：必须没有任何 added: 输出（幂等）
```

手动运行最后一次打印的行是 `checked N docker bridge(s)`；`N` 是当前 `ip -o link show` 里的 `br-*` 个数。
如果一条 `added:` 都没有，说明规则已经齐了 —— 这是期望状态，不是故障。

---

## 二、每日备份定时任务（OP-08 / 45K）

**为什么要有它**：生产库和对象目录都需要每天一份可校验、可恢复的备份，靠人记着手跑会漏。

**怎么装**（脚本装到 `/opt/hahart/current/deploy/`，包装到 `/opt/hahart/`）：

```bash
# 脚本（随 release 已经在 /opt/hahart/current/deploy/，这里只做一次权限确认）
ls -l /opt/hahart/current/deploy/backup.sh /opt/hahart/current/deploy/verify-backup.sh /opt/hahart/current/deploy/restore.sh

# 备份 + 校验的入口包装
sudo install -m 0755 /opt/hahart/current/deploy/backup-and-verify.sh /opt/hahart/backup-and-verify.sh

# systemd 单元
sudo install -m 0644 /opt/hahart/current/deploy/hahart-backup.service /etc/systemd/system/hahart-backup.service
sudo install -m 0644 /opt/hahart/current/deploy/hahart-backup.timer   /etc/systemd/system/hahart-backup.timer
sudo systemctl daemon-reload
sudo systemctl enable --now hahart-backup.timer
```

`hahart-backup.timer` 的内容要点：`OnCalendar=*-*-* 03:30:00 Asia/Shanghai`、`Persistent=true`（关机错过的那次开机后补跑）。
`hahart-backup.service` 是 `Type=oneshot`，`ExecStart=/opt/hahart/backup-and-verify.sh`：先 `backup.sh`，成功后再用 `verify-backup.sh` 校验最新一份目录。

**怎么验**：

```bash
systemctl list-timers hahart-backup.timer           # 期望 NEXT 是下一个 03:30，LAST/PASSED 有记录
systemctl is-enabled hahart-backup.timer            # 期望 enabled
sudo systemctl start hahart-backup.service          # 手工跑一次
systemctl status hahart-backup.service              # 期望 Result=success
ls -1 /mnt/g/hahart-backup/daily | tail -3          # 期望出现当天 <YYYYMMDD>-033000 目录
```

备份目录内容与恢复步骤见 `deploy/BACKUP.md`。

---

## 三、`REVISION` 文件

**为什么要有它**：`backup.sh` 把 `git_sha` 写进备份的 `MANIFEST`，来源是 `/opt/hahart/current/REVISION`。这个文件不存在或为空，MANIFEST 里的 `git_sha` 就是 `unknown` —— 2026-10-24 踩过一次，事后没法判断某份备份对应哪个 release。

**怎么装**：每次发布、切到新 release 目录后，都要把该 release 的 git sha 写进去（**每次发布都做**，不是一次性）：

```bash
cd /opt/hahart/current && git rev-parse HEAD | sudo tee /opt/hahart/current/REVISION
```

**怎么验**：

```bash
cat /opt/hahart/current/REVISION        # 期望 40 位或短 sha，非空、非 unknown
grep '^git_sha=' /mnt/g/hahart-backup/daily/<最新目录>/MANIFEST   # 期望与上面一致，不是 unknown
```

---

## 四、发布包：`deploy/` 里的脚本必须随 release 一起拷到 `.37`

**为什么写这条**：45K 的备份脚本当时没进发布包，是后来手工补装的；45R 的网桥自愈脚本当初更是只在 `.37` 上手写过、仓库里没有，重建 release 或换机器就会丢。**「代码合并了」不等于「机器上有了」**。

**怎么装 / 怎么验**：

```bash
# 发布后确认这份清单在 /opt/hahart/current/deploy/ 下都在
ls -1 /opt/hahart/current/deploy/{backup.sh,verify-backup.sh,restore.sh,backup-and-verify.sh,fix-bridge-rules.sh,hahart-bridge-rules.service,hahart-backup.service,hahart-backup.timer}
# .sh 都要有可执行位
find /opt/hahart/current/deploy -maxdepth 1 -name '*.sh' ! -perm -u+x
```

第二条命令**不应有任何输出**；有输出就是该文件缺可执行位（`chmod +x` 补上）。

---

## 证书（OP-13）

**约定：TLS 证书和私钥不进仓库。** `.gitignore` 里有 `certs/` 和 `*.pem` 两条。仓库里不会出现真实证书，也不放占位 PEM；`git archive` 打 release 包时同样不会带上（这些文件不在版本库里）。

**`.37` 上的存放位置**：`/opt/hahart/certs/`。目录权限 `700`、里面的文件 `600`；由部署脚本从仓库外的位置拷进去，不是从 release 包里取。

```bash
sudo install -d -m 0700 /opt/hahart/certs
# 从仓库外的备份位置拷入（示例路径，实际按当期介质走）
sudo install -m 0600 /path/to/from-outside/fullchain.pem /opt/hahart/certs/fullchain.pem
sudo install -m 0600 /path/to/from-outside/privkey.pem   /opt/hahart/certs/privkey.pem
```

**当前部署形态不需要本地证书**：一期是 Cloudflare Tunnel 终结 TLS（OP-09），源站 nginx 只监听 80，`deploy/nginx.conf` 里没有任何 `ssl_certificate` 配置。这一节是为将来改成直连 HTTPS 留的位置，现在就按上面的约定放文件、放着不用也可以。

**轮换**：替换 `/opt/hahart/certs/` 下的文件后重建容器，让 nginx 重新读证书。

```bash
docker compose up -d --force-recreate web
```

私钥**不允许**写进 `.env.production`（也别写进任何进仓库的文件）——它只以文件形式存在 `/opt/hahart/certs/` 下。
