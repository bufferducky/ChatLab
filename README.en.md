# ChatLab Personal

A local workspace for reading, searching and organizing your own QQ, WeCom and Telegram conversations.

[Latest release](https://github.com/bufferducky/ChatLab/releases/latest) · [Release notes](RELEASE_NOTES.md) · [中文](README.md)

This is an independently maintained personal project based on [ChatLab](https://github.com/ChatLab/ChatLab). Features and installers described here refer to this repository.

## Features

- Compact conversation reading with sender grouping, reply navigation and sender-specific message navigation.
- Telegram previews and originals in a shared cache, foreground download priority, cancellation and server cooldown feedback. QQ images use a bridge to the locally signed-in client.
- Scheduled incremental topic organization for unprocessed messages from the last 7 days, cross-day progress, evidence links and unread versions, alongside historical daily views. The default window is 09:30–23:40 Asia/Shanghai; the app must remain running with a model configured. Repeated pulls do not repeat summaries.
- Group highlights with reading actions, source links, model usage and budget status.
- Separate local collectors with authenticated Pull APIs, stable message IDs and resumable checkpoints. Settings → Automation supports immediate collection and pulling for groups, private chats, all subscriptions or a single conversation; collectors without on-demand collection fall back to pulling existing data.

AI features require your own model configuration. Messages remain locally stored; using an external model sends the relevant content to your selected provider.

The **global automatic summary switch** is under Settings → Automation → Auto Sync → Automatic topics. It defaults to on, saves immediately and persists after restarting. Turning it off stops automatic summaries for every conversation and aborts an active automatic request. Collection, message sync, existing topics, manual “Update now” and batch summaries remain available. Conversation switches, schedules and committed checkpoints are preserved; re-enabling resumes incremental processing under each conversation’s settings. Requests already sent to a model may still incur usage.

Automatic topics and “Update now” both use a rolling 7-day window, including newly imported messages within that window. Older original messages and existing topics remain available. Upstream model failures preserve progress for retry. Group/private filters select the pull scope; QQ collection still runs for the whole source. See [topic organization](packages/node-runtime/src/services/topics/README.md) and the [Pull protocol](docs/en/standard/chatlab-pull.md).

## Install and connect

Download macOS Apple Silicon DMG/ZIP or Windows x64 installer from [Releases](https://github.com/bufferducky/ChatLab/releases/latest). Builds are unsigned; macOS is not notarized. Windows CI checks do not constitute a complete device test. macOS Intel is not currently distributed. Use `SHA256SUMS.txt` to verify downloads and `BUILD_INFO.json` to identify the source commit. Manual upgrades through Release installers are recommended.

Collectors require separate setup and authorization on your own machine. Installers contain no account, credential or chat data. Collector integration has primarily been verified on macOS; Windows desktop availability does not imply Windows collector support.

See [QQ](integrations/qq/README.md), [WeCom](integrations/wecom/README.md) and [Telegram](integrations/telegram/README.md). Collection and import schedules are configured separately. QQ currently depends on a local reader compatibility fix that has not been published upstream. Personal WeChat collection is outside the supported scope.

## Develop and release

Use Node.js 24 and pnpm 11; Rust is required to build the native parser.

```bash
pnpm install --frozen-lockfile
pnpm dev:desktop
pnpm run type-check:all
pnpm test
```

See the [development guide](docs/cn/contributing/development.md) and [release guide](integrations/RELEASING.md). Tagged personal releases build macOS and Windows installers, validate artifacts and checksums, redownload the complete draft, then publish.

Keep account configuration, tokens, sessions, databases, decrypted copies, caches, logs and real chat screenshots outside the source tree. Audit unpublished commit history as well as the current files.

## License and credits

Retain the license and copyright notices in [LICENSE](LICENSE). Thanks to [ChatLab](https://github.com/ChatLab/ChatLab) and its open-source dependencies. Personal releases and issue tracking live in [this repository](https://github.com/bufferducky/ChatLab).
