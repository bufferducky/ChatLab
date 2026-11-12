# 企业微信本地数据源

复用本机已安装并跑通的 `wecom-agent`，把全部群聊、私聊及本地已有应用通知作为 ChatLab Pull 数据源。不会发送企微消息、重新登录、重新取钥、修改企微安装包或源数据库。

```text
企微 Info.db / Session.db + WAL
    → wecom-agent 稳定快照及解密
    → 本适配器独立 SQLite 存档（保留稳定 ID 和首次观察时间）
    → 仅本机 127.0.0.1:5034/api/v1，Bearer 鉴权
    → ChatLab 自动发现全部会话，每分钟增量拉取
```

## 前提与启动

- macOS，Python 3.10+；使用已安装 `wecom-agent` 的虚拟环境，其 `cryptography` 依赖可用。
- `wecom-agent` 默认位于 `~/.local/share/wecom-agent/source`，已有有效的 `decrypt/macos/wxwork_keys.json`。
- 多账号必须设置 `WECOM_PROFILE` 后初始化；一个适配器私有目录绑定一个源账号。
- 运行 `connect.mts` 使用项目依赖和 Node 24。注册/初次同步时退出 ChatLab，避免桌面端同时触发相同数据源。

从仓库根目录运行：

```bash
~/.local/share/wecom-agent/.venv/bin/python integrations/wecom/bridge.py init
~/.local/share/wecom-agent/.venv/bin/python integrations/wecom/bridge.py refresh
~/.local/share/wecom-agent/.venv/bin/python integrations/wecom/bridge.py serve
```

另一个终端注册并首次同步：

```bash
pnpm exec tsx integrations/wecom/connect.mts sync
pnpm exec tsx integrations/wecom/connect.mts verify
```

安装包含本分支同步引擎的桌面版本后，在“设置 → 自动化 → 自动同步”可查看“企业微信（本机全部会话）”，暂停/恢复及立即同步。`autoDiscoverSessions=true` 明确表示导入此数据源后续出现的全部群聊和私聊；单独移除订阅会在下次发现时重新加入，停止同步请暂停整个数据源。其它数据源默认不启用自动发现。

本次本机部署通过 LaunchAgent `io.github.bufferducky.chatlab-wecom` 托管适配服务，登录系统后启动；服务每 30 秒检查源库变化，ChatLab 开启时每分钟拉取。私有数据在 `~/.local/share/chatlab-wecom/`，包含配置、独立存档和仅含统计的验证报告；凭证、明文及用户聊天不会写入仓库。服务脚本从本仓库运行，移动仓库后须更新 LaunchAgent 路径。

暂停/恢复已部署的后台服务：

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/io.github.bufferducky.chatlab-wecom.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.github.bufferducky.chatlab-wecom.plist
```

停止服务不会删除数据；不要修改已有源的端口或更换私有存档，否则会改变 ChatLab 会话或增量游标的对应关系。

## 同步与数据边界

- 从源库读取全部记录，不根据会话是否隐藏或退出过滤。原生 `conversationtype=1` 映射群聊；其它会话保留在私聊类别，其中包含企微应用/服务通知，不等同于全部都是人与人的私聊。
- ID 使用账号隔离标识、会话 ID、消息 LID；不使用可变名称，也不将 64 位 ID 转成 JavaScript 数值。相同正文、发送人和时间的不同消息仍完整保留。
- `since` 对应存档的观察时间，原消息发送时间仍保存在 `timestamp`。较早时间或较小 LID 的新补录消息不会仅因发送时间过旧被跳过。同秒多消息通过 `nextOffset` 分页；只在终止页返回 `nextSince`。
- 群聊/私聊可能重名，始终按源 ID 分隔。文本保留正文及换行；已知媒体类型保留类型和现有可读表示；未知类型使用 99，保留 `wecom-agent` 渲染结果。
- 首版不复制完整媒体附件、不自动转写语音、不恢复本机不存在的历史、不将编辑/撤回同步为对 ChatLab 既有记录的替换。新会话名称在首次导入时读取，后续改名暂不更新。
- 解密失败后源返回 503，保留上一份成功存档；密钥失效需在企微读取工具中处理，不会自动重签或扩权。适配器不删除已采集记录，磁盘空间随历史量增长。
- 关闭 ChatLab 时适配器仍可收集本机数据库新增内容；再次打开 ChatLab 后补拉。仅启动 ChatLab 而没有有效企微源库更新，不代表能读取未同步到本机的云端消息。

## 验证

```bash
python3 -m unittest discover -s integrations/wecom -p 'test_*.py' -v
pnpm test -- packages/sync/src/auto-discovery.test.ts packages/sync/src/pull-engine.test.ts
pnpm test -- packages/node-runtime/src/import/incremental-importer.test.ts
python3 integrations/wecom/audit.py --database-dir /absolute/path/to/ChatLab/data/databases
```

`audit.py` 对每条消息核对稳定消息 ID、正文、类型、时间和发送者 ID，同时核对会话名称及类型；只输出统计，不打印聊天正文。活跃采集时新增消息可能暂未导入，应完成同步后再核对。
