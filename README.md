<div align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="https://github.com/ChatLab/ChatLab/raw/main/public/images/banner-light.png">
    <img src="https://github.com/ChatLab/ChatLab/raw/main/public/images/banner.png" alt="ChatLab" title="ChatLab" width="500" />
  </picture>

Your chat history, finally yours.

English | [简体中文](./README.zh-CN.md)

[Official Website](https://chatlab.fun/) · [Docs](https://docs.chatlab.fun/) · [Quick Start](https://docs.chatlab.fun/usage/quick-start) · [Roadmap](https://chatlab.fun/roadmap/tasks) · [Releases](https://github.com/ChatLab/ChatLab/releases)

</div>

## Personal fork: a local automated message workspace

This is [bufferducky's personal fork](https://github.com/bufferducky/ChatLab) of [ChatLab](https://github.com/ChatLab/ChatLab). It automatically collects **QQ, WeCom (Enterprise WeChat), and Telegram** messages into local ChatLab storage for browsing, search and AI analysis, with scheduled daily digests planned next. [完整中文方案](README.zh-CN.md).

**As of November 12, 2026, all three collection paths—WeCom, QQ and Telegram—are implemented and verified on a local Mac.** This development branch includes the collectors, ChatLab integration and verification scripts. The local build is named **ChatLab Personal** and uses this fork's GitHub update source. These are this fork's integrations and local deployment settings; upstream installers do not necessarily include these collectors.

**Personal WeChat collection is no longer planned.** Its strict platform restrictions and the risk of account restrictions or bans make it unsuitable for this fork's automated collection plan. WeCom remains a separate, implemented source.

### Collection design

```mermaid
flowchart TD
    subgraph QQ_SOURCE["QQ: collect every 3 hours"]
        QQ["Original QQ client"] --> QDB["nt_msg.db / profile_info.db / group_info.db + WAL"]
        QDB --> QR["qq-local-interface: stable copy and authenticated decryption"]
        QR --> QA["Scan native IDs and parse new records"]
        QA --> QS[("Independent QQ SQLite archive")]
        QS --> QAPI["Loopback Pull API: 5035"]
    end
    subgraph WECOM_SOURCE["WeCom: collect every 10 minutes"]
        WC["WeCom client"] --> WDB["Info.db / Session.db + WAL"]
        WDB --> WR["wecom-agent: stable snapshot and decryption"]
        WR --> WA["Read and deduplicate"]
        WA --> WS[("Independent WeCom SQLite archive")]
        WS --> WAPI["Loopback Pull API: 5034"]
    end
    subgraph TG_SOURCE["Telegram: collect every 3 hours"]
        TG["Visible groups, channels, private and bot chats"] --> TR["Telethon / MTProto with local login authorization"]
        TR --> TA["Last 7 days for new chats, then new message IDs"]
        TA --> TS[("Independent TG SQLite archive and checkpoints")]
        TS --> TAPI["Loopback Pull API: 5036"]
    end
    QAPI -->|"Pull every 180 minutes"| CL["ChatLab: Bearer auth, session discovery and pagination"]
    WAPI -->|"Pull every 10 minutes"| CL
    TAPI -->|"Pull every 180 minutes"| CL
    CL --> IMPORT["Existing importer: stable-ID deduplication and consumer checkpoints"]
    IMPORT --> DB[("Local ChatLab session databases")]
    DB --> USE["Browse, query with SQL and analyze with AI"]
    USE -.-> TODO["Planned: finer group selection, scheduled digests and daily reading"]
```

QQ keys were captured once using an isolated debug copy; daily collection reuses the saved keys with the original client running, without a second QQ login. WeCom reuses the installed and authorized `wecom-agent`. Telegram reads visible cloud messages using Telethon and the user's MTProto authorization, without manual JSON exports. Separate LaunchAgents keep all three collectors running while ChatLab is closed; ChatLab pulls their archives when running.

Accounts, conversations and messages use stable source IDs. Collection checkpoints and ChatLab consumer checkpoints are separate; Pull uses observation times and page cursors while retaining original send times. QQ and WeCom discover new local records; Telegram resumes after committed message IDs. Each newly discovered Telegram chat starts with its last seven days, then accumulates new messages. This is an initial lookback, not a rolling deletion policy.

| Capability | Status |
| --- | --- |
| QQ groups and private chats | Verified: 36 nonempty conversations and 1,199,012 messages, zero field differences in reconciliation, zero additions on repeat pull, and successful scheduled desktop increments |
| WeCom | Local groups, private chats and existing application notifications connected through a separate archive and automatic session discovery |
| Telegram | All-chat discovery implemented: initial acceptance checked 85 chats, imported 10,276 messages from 61 chats active in the last week, with zero field differences and zero additions on repeat pull; subsequent collection runs every 3 hours |
| Personal WeChat collection | No longer planned because of strict restrictions and the risk of account restrictions or bans |
| Account and group selection | One source account per platform; all-chat discovery is enabled, and TG also supports selected peer IDs; status, manual sync and pause are available, with a unified fine-grained selection UI planned |
| Scheduled AI digests | Planned: per-group and cross-group summaries, daily reading and links back to source evidence |

Setup and evidence: [QQ integration](integrations/qq/README.md), [WeCom integration](integrations/wecom/README.md), [Telegram integration](integrations/telegram/README.md), and [QQ research](integrations/qq/RESEARCH.md). The QQ reader requires a local fix for preallocated zero pages that has not been published upstream; installing the unmodified reader alone does not reproduce this setup.

### Current cadence and resource costs

These are the **local deployment settings**, not script initialization defaults. Collector refresh and ChatLab pull are independent schedules:

| Source | Collector wait after each refresh | ChatLab pull interval | Measured write reference per changed refresh |
| --- | --- | --- | --- |
| QQ | 3 hours (10,800 seconds) | 180 minutes | About 2 GB |
| WeCom | 10 minutes (600 seconds) | 10 minutes | About 61 MB |
| Telegram | 3 hours (10,800 seconds) | 180 minutes | Writes new messages to its archive; no comparable disk-write measurement yet |

QQ parses only newly discovered messages, but still copies and decrypts the full changed database and scans all native IDs. With a roughly 1 GB main database, two foreground refreshes took 7.8–10.9 seconds with peak RSS around 175 MiB; historical background samples were usually 41–76 seconds, and a busy source also caused retry failure. WeCom also rewrites decrypted databases after source changes; unchanged sources skip the large operations.

Assuming continuous operation and a changed source on every cycle, roughly eight QQ and 144 WeCom refreshes imply about **25 GB/day or 9 TB/year** of collector writes, excluding Telegram. This is a conditional OS-accounted estimate, not permanent storage growth, NAND writes or an SSD lifespan prediction; retries can add writes. Telegram uses API requests instead of the local full-database copy/decryption path. See [QQ performance measurements](integrations/qq/PERFORMANCE.md). Visibility can approach the sum of the collection and pull intervals, plus processing time.

### Current limits

- QQ and WeCom collect locally synchronized records. TG reads account-visible cloud messages, starting each new chat with its last seven days; Secret Chats, deleted messages and inaccessible history are outside this path. Existing imported messages are not replaced after edits, recalls or conversation renames.
- Media retains types, readable text or placeholders; full attachments, voice transcription and forwarded-message expansion are not complete. The QQ acceptance dataset includes 378 unknown-time records with timestamp 1, which may appear in 1970.
- Pull APIs bind to loopback only (WeCom `5034`, QQ `5035`, TG `5036`) and require Bearer authentication. Keys, tokens, Telegram sessions, plaintext snapshots and archives stay outside Git. AI analysis uses the configured model service; external model calls may send selected chat content to that service.

The upstream AGPL-3.0 license and attribution are retained. Never commit account credentials, API keys or real chat data to this repository. The upstream project overview follows below.

ChatLab is an open-source desktop app for understanding your social conversations. It combines a flexible SQL engine with AI agents so you can explore patterns, ask better questions, and extract insights from chat data, all on your own machine.

Currently supported: **WhatsApp, LINE, QQ, Discord, Instagram, Telegram, iMessage, and Google Chat**. Coming next: **Messenger and KakaoTalk**.

> New install? Start here: [Getting started](https://docs.chatlab.fun/usage/quick-start)

## Core Features

- 🚀 **Built for large histories**: Stream parsing and multi-worker processing keep imports and analysis responsive, even at million-message scale.
- 🔒 **Private by default**: Your chat data and settings stay local. No mandatory cloud upload of raw conversations.
- 🤖 **AI that can actually operate on data**: Agent + Function Calling workflows (24+ tools) can search, summarize, and analyze chat records with context.
- 📊 **Insight-rich visual views**: See trends, time patterns, interaction frequency, rankings, and more in one place.
- 🧩 **Cross-platform normalization**: Different export formats are mapped into a unified model so you can analyze them consistently.

## Installation

### Desktop App

Download the installer for your OS from the [official website](https://chatlab.fun/?type=download) or [GitHub Releases](https://github.com/ChatLab/ChatLab/releases), then double-click to install.

### CLI

Requires Node.js ≥ 20.

```bash
npm i chatlab-cli -g
```

Start ChatLab:

```bash
clb web            # Start API + Web UI, auto-open in browser
clb web --no-open  # Start API + Web UI, skip auto-open
clb web --headless # API only, no Web UI (for scripts / AI Agents)
```

Common options: `--port <port>` (default 3110), `--host <address>`, `--token <token>`.

To run as a persistent background service (auto-start on login + auto-restart on crash):

```bash
clb web --daemon   # Install as system service (macOS / Linux)
clb status           # Check service status
clb stop             # Stop and uninstall service
```

For a full walkthrough, see the [Quick Start guide](https://docs.chatlab.fun/usage/quick-start).

## Usage Guides

- [Download Guide](https://chatlab.fun/?type=download)
- [Chat Record Export Guide](https://docs.chatlab.fun/usage/how-to-export)
- [Standardized Format Specification](https://docs.chatlab.fun/standard/chatlab-format)
- [Troubleshooting Guide](https://docs.chatlab.fun/usage/troubleshooting)

## Preview

For more previews, please visit the official website: [chatlab.fun](https://chatlab.fun/)

![Preview Interface](/public/images/intro_en.png)

## Architecture Overview

ChatLab is a pnpm monorepo built on Electron + Vue 3 + Nuxt UI + Tailwind CSS. Core business logic lives in shared packages (`@openchatlab/core`, `@openchatlab/node-runtime`, `@openchatlab/tools`), consumed by both the desktop app and the CLI service — so they stay in sync.

Data flows in five stages: **format detection → stream parsing → local persistence → SQL + AI query → visualization**.

For a deep dive, see the [architecture documentation](https://docs.chatlab.fun/intro).

### Architecture Principles

- **Local-first by default**: Raw chat data, indexes, and settings remain on-device unless you explicitly choose otherwise.
- **Streaming over buffering**: Stream-first parsing and incremental processing keep large imports stable and memory-efficient.
- **Composable intelligence**: AI features are assembled through Agent + Tool Calling, not hard-coded into one model path.
- **Schema-first evolution**: Import, query, analysis, and visualization share a consistent data model that scales with new features.

---

## Local Development

For complete contributor instructions, see the [Development Guide](https://docs.chatlab.fun/contributing/development).

### Requirements

- Node.js >= 24 < 25
- pnpm >= 11 < 12

### Setup

```bash
# Install dependencies
pnpm install

# Start dev mode — prompts you to choose which app to launch
pnpm dev
```

Or launch a specific target directly:

```bash
pnpm dev:desktop   # Electron desktop app
pnpm dev:cli-web   # CLI Web frontend + local server
pnpm dev:web-wasm  # Browser-only Web WASM
pnpm dev:serve     # CLI server only
pnpm docs:dev      # Docs site
```

If Electron encounters exceptions during startup, you can try using `electron-fix`:

```bash
npm install electron-fix -g
electron-fix start
```

## Privacy Policy & User Agreement

Before using this software, please read the [Privacy Policy & User Agreement](./src/assets/docs/agreement_en.md).

## Community

Please follow these principles before submitting a Pull Request:

- Obvious bug fixes can be submitted directly.
- For new features, please submit an Issue for discussion first; **PRs submitted without prior discussion will be closed**.
- Keep one PR focused on one task; if changes are extensive, consider splitting them into multiple independent PRs.
- For local setup, repository structure, checks, and AI collaboration notes, see the [Development Guide](https://docs.chatlab.fun/contributing/development).

Thanks to all contributors:

<a href="https://github.com/ChatLab/ChatLab/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=ChatLab/ChatLab" />
</a>

## License

AGPL-3.0 License
