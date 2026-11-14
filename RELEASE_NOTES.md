# ChatLab Personal v0.38.0

聊天阅读、自动话题与本机图片链路升级，建立个人版双平台 GitHub 发布流程。

## 更新内容

- 聊天阅读新增稳定发送者颜色、连续发言分组、引用原文跳转及同一发送者前后定位。
- 自动话题支持每会话整理时段、跨日讨论接续、新进展、证据引用与未读版本，继续保留按日阅读。
- 群聊热点补充阅读、收藏、略过与反馈操作，以及模型用量、预算状态和来源导航。
- Telegram 历史查询与媒体下载分开调度，点击原图和可见预览优先，后台在分块边界让行并继续补齐原图。
- 前台图片请求支持合并、提升和离屏取消；按服务器实际等待秒数倒计时重试，缓存可离线读取。
- QQ 正文不再混入搜索用原生标识，引用通过会话和原生序号解析，保留稳定消息 ID。
- QQ 图片桥接补充有界排队、下载完成校验、原生展示资源验证及退出清理，改善多图阅读。
- README 改为个人项目的实际功能、安装及采集器部署说明，公开样本与待推送提交身份脱敏。
- 个人版 tag 自动构建 macOS Apple Silicon 与 Windows x64，发布完整版本说明、源码身份和 SHA256 校验；重新下载草稿复核后发布。

## 下载与升级

| 平台 | 安装包 |
| --- | --- |
| macOS Apple Silicon | [DMG](https://github.com/bufferducky/ChatLab/releases/download/v0.38.0/ChatLab-Personal-0.38.0-arm64.dmg) · [ZIP](https://github.com/bufferducky/ChatLab/releases/download/v0.38.0/ChatLab-Personal-0.38.0-arm64.zip) |
| Windows x64 | [安装程序](https://github.com/bufferducky/ChatLab/releases/download/v0.38.0/ChatLab-0.38.0-setup.exe) |

个人 Fork 版本；macOS 包未使用 Apple 开发者证书签名或公证，Windows 包未做代码签名。桌面包包含阅读与同步能力；QQ、企微、Telegram 采集器仍需按仓库 integrations 文档在本机部署和授权，不包含账号或聊天数据。macOS 已做本机阅读抽查；Windows 仅通过 CI 构建和原生运行时检查，不等同于真机完整验收。

每个安装包及自动更新元数据均由 SHA256SUMS.txt 覆盖。BUILD_INFO.json 记录版本和源码提交；发布前会重新下载草稿资产复核完整性。已有数据目录及采集配置继续保留。

## English

Improve conversation reading, continuous topics and local image delivery, with verified personal GitHub releases for macOS and Windows.

- Add stable sender colors, grouped consecutive messages, reply navigation and previous/next sender-message navigation.
- Schedule topic organization per conversation, continue discussions across days, and track progress, evidence and unread versions alongside daily history.
- Extend group highlights with reading, save, skip and feedback actions, model usage, budgets and source navigation.
- Separate Telegram history pacing from media scheduling; prioritize original clicks and visible previews while background downloads yield between chunks.
- Coalesce and promote image downloads, cancel abandoned readers and honor server cooldowns; cached previews and originals remain available offline.
- Keep native search identifiers out of QQ message bodies and resolve replies within their conversation without changing stable message IDs.
- Bound QQ bridge queues and verify completion events, image resources and shutdown cleanup for multi-image reading.
- Replace upstream-only README content with personal project setup and installation guidance; anonymize public samples and unpublished commit identity.
- Build macOS Apple Silicon and Windows x64 installers from version tags; publish detailed notes, source identity and checksums only after redownloading and verifying the draft.

Personal fork for macOS Apple Silicon and Windows x64. Desktop installers are unsigned; macOS is not notarized. The collectors require separate local setup and authorization. Releases contain no accounts or chat data. Windows CI runtime checks do not constitute a full device test. Verify downloads with SHA256SUMS.txt; BUILD_INFO.json identifies the source commit.

[完整更新日志](https://github.com/bufferducky/ChatLab/blob/v0.38.0/changelogs/cn.md) · [English changelog](https://github.com/bufferducky/ChatLab/blob/v0.38.0/changelogs/en.md)
