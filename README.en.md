# ChatLab Personal

A local workspace for reading, searching and organizing your own QQ, WeCom and Telegram conversations.

[Latest release](https://github.com/bufferducky/ChatLab/releases/latest) · [Release notes](RELEASE_NOTES.md) · [中文](README.md)

This is an independently maintained personal project based on [ChatLab](https://github.com/ChatLab/ChatLab). Features and installers described here refer to this repository. This README describes `main`; published installers follow their own release notes. Pushing source changes does not update downloaded installers.

## Features

- Compact, neutral conversation reading with sender grouping, reply navigation, adjustable text size and weight. Platform service events such as joins and removals are hidden from reading pages, search and context while the archive is retained. Toggle the right topic/record panel with `⌘L` on macOS or `Ctrl+L` elsewhere.
- Telegram image originals are prefetched with local previews. Ordinary MP4/WebM videos up to 50 MiB support inline and large-window playback. QQ images use a bridge to the locally signed-in client. Images, Telegram videos and manifests share a default 30 GiB cache, with foreground priority, cancellation and cooldown feedback.
- Blue, clickable Telegram title/text/username links, including on-demand metadata recovery for archived messages. Videos initially play muted; sound preferences persist per conversation and carry across inline and large players. Opening another video pauses the previous player.
- Scheduled incremental topic organization for unprocessed messages from the last 7 days, cross-day progress, evidence links and unread versions, alongside historical daily views. The default window is 09:30–23:40 Asia/Shanghai; the app must remain running with a model configured. Repeated pulls do not repeat summaries.
- Group highlights with reading actions, source links, model usage and budget status.
- Separate local collectors with authenticated Pull APIs, stable message IDs and resumable checkpoints. A “Collect and update now” button follows AI Chat on conversation pages; QQ, WeCom and Telegram all support collection before pulling the selected conversation. Settings → Automation manages source/type scopes. Failures, timeouts and pulls of existing data are distinguished.

AI features require your own model configuration. Messages remain locally stored; using an external model sends the relevant content to your selected provider.

The **global automatic summary switch** is under Settings → Automation → Auto Sync → Automatic topics. It defaults to on, saves immediately and persists after restarting. Turning it off stops automatic summaries for every conversation and aborts an active automatic request. Collection, message sync, existing topics, manual “Update now” and batch summaries remain available. Conversation switches, schedules and committed checkpoints are preserved; re-enabling resumes incremental processing under each conversation’s settings. Requests already sent to a model may still incur usage.

Automatic topics and “Update now” both use a rolling 7-day window, including newly imported messages within that window. Older original messages and existing topics remain available. Manual topic updates take priority over automatic runs while retaining committed batches. Upstream model failures show their reason and preserve progress for retry. Conversation/type filters select the pull scope; collection runs for the whole source. See [topic organization](packages/node-runtime/src/services/topics/README.md) and the [Pull protocol](docs/en/standard/chatlab-pull.md).

## Adjust reading text

1. Open **Settings → General → Appearance**.
2. Choose **Small**, **Standard** or **Large** under **Reading text size**. Standard uses 14px for chat messages and topic summaries, and 16px for AI body text.
3. Turn on **Heavier body text** to use medium weight (500) across these content areas; turn it off to return to regular weight. Compare the result in the settings preview or a conversation.

Changes apply immediately, save automatically and persist after restarting. Reading size affects content without scaling menus or toolbars.

## Install and connect

Download macOS Apple Silicon DMG/ZIP or Windows x64 installer from [Releases](https://github.com/bufferducky/ChatLab/releases/latest). Builds are unsigned; macOS is not notarized. Windows CI checks do not constitute a complete device test. macOS Intel is not currently distributed. Use `SHA256SUMS.txt` to verify downloads and `BUILD_INFO.json` to identify the source commit. Manual upgrades through Release installers are recommended.

Collectors require separate setup and authorization on your own machine. Installers contain no account, credential or chat data. Collector integration has primarily been verified on macOS; Windows desktop availability does not imply Windows collector support.

See [QQ](integrations/qq/README.md), [WeCom](integrations/wecom/README.md) and [Telegram](integrations/telegram/README.md). Collection and import schedules are configured separately. QQ currently depends on a local reader compatibility fix that has not been published upstream. Personal WeChat collection is outside the supported scope.

## Collection and conversation scope

“Collect and update now” requests `POST /api/v1/collect`, waits through `GET /api/v1/collect`, then pulls the selected conversations. Concurrent triggers share the current collection round.

QQ and WeCom use locally readable records. Telegram all-dialog discovery includes new visible conversations; first collection covers the last 7 days, followed by message-ID increments. An empty conversation can retain its subscription until new messages arrive.

Automatic discovery respects each source's `excludedRemoteSessionIds`. To remove a conversation without recreating it from an old archive, persist its remote ID exclusion, remove its subscription, then delete the ChatLab conversation. Exclusions are currently managed through configuration/maintenance; there is no unified approval UI. Excluding an ID affects automatic subscription creation, not the collector archive or membership on the source platform. All-dialog discovery can still collect newly joined chats before a manual review.

See the [QQ/Telegram media guide](integrations/IMAGE_MEDIA.md) for media, cache and deployment boundaries.

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
