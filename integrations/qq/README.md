# QQ 本地数据源

读取已安装的 `qq-local-interface` 和已有密钥，将本机 QQ 群聊、私聊接入 ChatLab。原版 QQ 正常运行，无需日常启动第二个 QQ 实例。

```text
首次：已有 records.db → QQ 独立存档 → 本机 Pull API → ChatLab
后续：原版 QQ DB/WAL → 稳定副本及页面认证解密
                     → 比对全部原生消息 ID，只解析新记录 → 同一存档
```

## 本机运行

- 使用已安装 `qq-local-interface` 的 Python 虚拟环境；下例假设读取器位于 `~/openProjects/qq-local-interface`。本机读取器包含尚未发布到上游的预分配零页兼容修复，具体条件见 [调研记录](RESEARCH.md#已授权的重签试验与本机兼容修复)，不能把原版读取器视为已经包含此修复。
- 默认读取 `~/Library/Application Support/qq-local-interface/sources/personal-qq/`。需先有有效配置、三个核心库密钥和成功快照。
- ChatLab 工程使用 Node 24 和已有 pnpm 依赖。

从仓库根目录运行：

```bash
~/openProjects/qq-local-interface/.venv/bin/python integrations/qq/bridge.py init --interval 10800
~/openProjects/qq-local-interface/.venv/bin/python integrations/qq/bridge.py bootstrap
~/openProjects/qq-local-interface/.venv/bin/python integrations/qq/bridge.py serve
```

退出 ChatLab 后执行首次导入，完成后重新打开桌面端：

```bash
pnpm exec tsx integrations/qq/connect.mts sync
pnpm exec tsx integrations/qq/connect.mts verify
python3 integrations/qq/audit.py --database-dir ~/.chatlab/data/databases
```

`connect.mts` 使用已有 ChatLab 导入器，不直接写消息表。`audit.py` 逐条核对原消息 ID、时间、正文、类型及发送者，并检查会话名称和类型，只输出统计。

## 自动同步与暂停

本机部署使用 LaunchAgent `io.github.bufferducky.chatlab-qq`，登录后启动。**2026-11-12 最新配置：采集服务每轮结束后等待 3 小时（10,800 秒），ChatLab 每 180 分钟拉取一次。** 无变化直接跳过，有变化对稳定副本整库解密、扫描全部原生 ID，仅解析新消息。设置 → 自动化 → 自动同步中可查看 `QQ（本机全部会话）`、调整拉取间隔、立即同步或暂停，并自动发现新会话。

上面的 `init --interval 10800` 只设置新建采集配置；已有配置不会被 `init` 覆盖。已有部署应在停止服务后，将 `~/.local/share/chatlab-qq/config.json` 的 `interval` 改为 `10800`，再启动服务。ChatLab 的拉取间隔需另外设置为 180 分钟；脚本初始化默认仍是采集 300 秒、注册拉取 5 分钟，运行示例不会自动改写拉取周期。

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/io.github.bufferducky.chatlab-qq.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.github.bufferducky.chatlab-qq.plist
```

服务绑定 `127.0.0.1:5035`，Pull 接口需要 Bearer token。`/health` 只返回就绪状态、计数、刷新时间及错误类别。凭证、独立存档和统计报告保存在 `~/.local/share/chatlab-qq/`，不放进 Git。移动代码仓库或读取器后需要更新 LaunchAgent 路径。

## 数据边界

- 消息 ID 包含固定账号 origin 和读取器稳定标识，不按姓名、正文或时间去重。原生 64 位 ID 使用 SQLite 整数和 Python 整数，绝不转成 JavaScript 数值。
- 首次导入保留已有快照的全部消息；53 个已知会话中有消息的是 36 个（22 个群、14 个私聊），17 个空群不创建 ChatLab 消息库。后续通过 `(原生表名, 原生消息 ID)` 比对所有记录，不依赖 ID 大小或发送时间。因此较早时间、较小 ID 的新补录仍可导入。只解析新记录，不重建读取器的百万条完整索引。
- 增量游标使用本地观察时间，分页 `nextOffset` 是不透明的递增记录序号，客户端原样传回即可。首次历史置于重叠窗口之外，避免紧接着再次拉取百万条旧消息。
- 378 条首轮消息没有有效原始时间，使用正数占位时间戳 1，兼容 ChatLab 增量导入；界面可能显示在 1970 年。这个值只表示时间未知，不是推定的发送日期。
- 文本保留正文和换行；媒体保留可读文字及类型，没有可读文字时使用占位。混合或尚未映射的类型为 99，不代表完整媒体可播放、附件已导入或转发内层已展开。
- 首版只追加消息；已采集消息的编辑、撤回、后续完善及会话改名不覆盖 ChatLab 既有记录。源库缺失的历史不会删除本地存档。联系人和群信息用于新消息的名称与身份解析。
- 刷新失败保留上次成功存档，`/health.error` 显示错误类别，稍后重试；`lastRefresh` 用于判断新鲜度。就绪并不代表所有辅助库齐全，当前只读取三个核心库。
- 每次有变化仍需复制和解密约 1 GB 的主库，并扫描全部原生 ID；这不是只处理变化页。当前低频配置用于历史存档与分析。临时副本随刷新结束删除，不生成持续增长的完整快照代次；历史存档本身会随消息增长。
- 本机一次前台增量刷新约 12 秒；后台服务与百万条导入并行时，一次刷新约 233 秒。轮询间隔从刷新结束后计算，ChatLab 还有独立的拉取周期，当前消息可见延迟可能接近 6 小时，另加处理耗时。
- 读取器已有完整快照不会由本适配器自动更新；QQ 调试副本、备份和已有快照均保留。密钥失效时需在读取器侧处理，不会自动调试或重签 QQ。

## 检查

刷新耗时、CPU、内存、磁盘读写及轮询频率判断见 [性能实测](PERFORMANCE.md)。

```bash
python3 -m unittest discover -s integrations/qq -p 'test_*.py' -v
pnpm exec eslint integrations/qq/connect.mts
pnpm exec prettier --check integrations/qq/connect.mts integrations/qq/README.md
pnpm run type-check:node
```

回归覆盖同正文不同消息、64 位 ID、较小 ID 的历史补录、时间缺失、事务回滚、重启去重、媒体类型和 HTTP 鉴权分页。共享 Pull 引擎和增量导入器沿用其既有回归测试。
