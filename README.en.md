# ChatLab Personal

A local workspace for reading, searching and organizing your own QQ, WeCom and Telegram conversations.

[Latest release](https://github.com/bufferducky/ChatLab/releases/latest) · [Release notes](RELEASE_NOTES.md) · [中文](README.md)

This is an independently maintained personal project based on [ChatLab](https://github.com/ChatLab/ChatLab). Features and installers described here refer to this repository.

## Features

- Compact conversation reading with sender grouping, reply navigation and sender-specific message navigation.
- Telegram previews and originals in a shared cache, foreground download priority, cancellation and server cooldown feedback. QQ images use a bridge to the locally signed-in client.
- Scheduled topic organization, cross-day progress, evidence links and unread versions, alongside historical daily views.
- Group highlights with reading actions, source links, model usage and budget status.
- Separate local collectors with authenticated Pull APIs, stable message IDs and resumable checkpoints.

AI features require your own model configuration. Messages remain locally stored; using an external model sends the relevant content to your selected provider.

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
