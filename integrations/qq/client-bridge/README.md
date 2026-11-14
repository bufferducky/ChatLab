# QQ 进程内图片桥接

在用户已登录的 QQ 主进程内加载的最小 HTTP 桥接：只提供状态查询和原图获取，供 QQ 采集器在本地缓存未命中时补图。协议、错误码和验收要求见 [QQ 在线图片桥接接口设计](../IMAGE_BRIDGE_API.md)。

> 状态：桥接模块与采集器在线补图已实现，并通过自动化测试；带桥接的日常客户端安装流程仍属实验方案。没有加载桥接的原版 QQ 照常供采集器读取本地消息和图片缓存，只是无法在线补图。

## 文件

| 文件 | 作用 |
| --- | --- |
| `bootstrap.cjs` | 客户端入口：拦截 `wrapper.node` 取得 QQ 自己创建的 Session，启动桥接，再加载原启动器；失败不影响 QQ 启动 |
| `image-bridge.cjs` | 回环 HTTP 服务、发现文件、健康状态、账号与数据目录核对、原生消息查询、下载完成监听、并发与超时 |
| `test_image_bridge.test.mjs` | 合成 QQ 对象与临时目录的回归测试，不登录真实账号 |
| `bootstrap.test.mjs` | 验证无终端变量启动时的数据来源配置与正常退出信号 |

## 加载方式

桥接不单独创建 QQ 实例，也不登录第二个账号。做法是在**可回退的 QQ 副本**中把入口改为 `bootstrap.cjs`，由它加载原启动器：

1. 退出 QQ，制作独立副本并保留原版安装。
2. 将本目录三个文件复制到副本的 `Contents/Resources/app/`（与 `application.asar` 同级）。
3. 备份副本的 `package.json`，将其 `main` 指向 `bootstrap.cjs`。
4. 启动副本并登录。桥接使用 QQ 自己创建的会话，界面、收发消息与原生一致。

`bootstrap.cjs` 默认加载同目录 `application.asar/app_launcher/index.js`。副本路径不同时，可在同目录放 `chatlab-image-bridge.json`：

```json
{ "main": "application.asar/app_launcher/index.js" }
```

也可用环境变量 `CHATLAB_QQ_LAUNCHER` 指定原启动器；`CHATLAB_QQ_BRIDGE=0` 可只加载原客户端、不启动桥接，用于排查启动问题。

从访达启动不会继承终端里的环境变量。使用独立账号数据时，应在 `chatlab-image-bridge.json` 中同时保存绝对路径 `dataRoot`（QQ 实际运行的数据根目录）与 `home`（采集器目录），并让 QQ 的运行数据入口指向同一根目录。桥接报告的版本来自实际加载资源旁的 `package.json`。采集器的 `database_dir` 也必须指向这份账号目录，不得只修改健康检查返回值绕过来源核对。

macOS 上副本需要可启动的签名状态。实验副本使用自签名并保留原版；日常方案仍需单独确定签名、更新与回退流程，不能直接把实验副本当成正式安装。

## 运行数据

默认目录 `~/.local/share/chatlab-qq/`，可用 `CHATLAB_QQ_HOME` 覆盖，与采集器共用：

| 路径 | 内容 |
| --- | --- |
| `runtime/image-bridge.json` | 发现文件：协议版本、`127.0.0.1` 随机端口、临时 token、PID、`instanceId`；原子写入，权限 `0600` |
| `runtime/image-bridge.log` | 桥接自身诊断日志，超过 1 MiB 轮转，不记录图片内容或凭证 |
| `runtime/image-downloads/` | 下载临时目录；随机文件名，完成或失败后清理，启动时清理遗留的自身文件 |
| `runtime/image-bridge-launcher.log` | 入口加载与启动失败的诊断日志 |

token 每次启动随机生成（32 字节），只写入发现文件和采集器请求头，不进入 URL、日志或 Git。

采集器使用 `<home>/runtime/image-bridge.json` 发现服务，因此两边必须使用同一个 `CHATLAB_QQ_HOME`。数据根目录可用 `CHATLAB_QQ_DATA_ROOT` 指定；未指定时按平台查找 QQ 默认目录。

## 核对状态

```bash
home="${CHATLAB_QQ_HOME:-$HOME/.local/share/chatlab-qq}"
token=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["token"])' "$home/runtime/image-bridge.json")
curl -sS -H "Authorization: Bearer $token" http://127.0.0.1:$(python3 -c 'import json,sys;from urllib.parse import urlsplit;print(urlsplit(json.load(open(sys.argv[1]))["baseUrl"]).port)' "$home/runtime/image-bridge.json")/v1/health
```

`ready=true` 表示已取得会话、QQ 在线、账号数据目录可核对且原生接口具备取图能力。`sessionCaptured=true` 单独为真不代表在线；发现文件存在也不代表服务可用，采集器始终先做健康检查。

QQ 7.0.1-52892 实机登录成功会触发 `onQRCodeLoginSucceed`；桥接同时处理它与 `onUserLoggedIn`。原生下载完成回调中的成功码可能是字符串 `"0"`，与数字 `0` 等价；非零值仍按失败处理。退出信号交由 QQ 自身处理，桥接只在进程退出时清理自身文件。

`GET /v1/health` 与 `POST /v1/images/fetch` 都要求 Bearer token；只绑定回环地址，不开放 CORS 或任意路径、URL、表达式、IPC 方法。请求体上限 16 KiB，单张图片上限 50 MiB，最多同时 2 个原生下载，其余请求按到达顺序自动排队。同一附件的并发请求合并；查询、排队和下载共用 50 秒期限。最多接收 16 个不同附件的进行中请求（含查询、下载及排队），只有总量满时才返回 `429` 与 `Retry-After: 2`。QQ 登出或桥接停止时，排队请求立即失败，不再启动下载。

## 已知限制

- 首版只取原图；预览未命中时会先下载整张原图再缩放，不提供原生小缩略图。
- QQ 可能提供与消息 MD5 不同的全尺寸变体。内容 MD5 不符时，仅接受 `original=false`、精确完成事件、当前账号 `Ori` 文件与原生 `sourcePath` 一致、文件名对应消息 MD5，且完整解码尺寸匹配的文件；采集器分别验证消息引用和响应正文 MD5。该验证依赖 QQ 的原生附件归属，不保证与发送端原文件逐字节一致，具体契约见接口设计第 8.2 节。
- QQ 原生下载能否可靠取消尚未验证。超时或客户端断开后，未能确认结束的任务仍占用 2 个实际下载额度，直到完成事件到达或 QQ 退出。
- 只支持已导入普通消息中的图片附件；不提供聊天导入、批量历史归档、视频/文件下载或发消息。
- 客户端更新可能覆盖入口文件并使原生接口失效。更新后应重新核对入口、`/v1/health` 的 `qqVersion`、`capabilities` 与一张实测图片；不兼容时采集器返回 `QQ_BRIDGE_INCOMPATIBLE`，不循环重试。
- 私聊链路与群聊需分别做真实账号验收；当前自动化测试使用合成会话，不替代私聊实机验证。

## 回退

1. 退出带桥接的 QQ。
2. 恢复副本 `package.json` 的 `main`，或直接删除副本、继续使用原版安装。
3. 确认同一时间只运行一个 QQ，再重新启动原版并核对账号与会话列表。

发现文件只由所属 `instanceId` 的实例在退出时删除；崩溃遗留文件由采集器的健康检查识别为不可用，不会仅凭 PID 判定可用。

## 测试

```bash
node --test integrations/qq/client-bridge/*.test.mjs
```

覆盖鉴权、请求形状、发现与健康状态、下载校验、并发合并、并发上限、超时后额度占用、登出和发现文件清理。

## 本机验收记录（2026-11-13）

QQ 7.0.1-52892 / Electron 40.0.0 的桥接副本已实测：群聊四张对照图片、私聊一张图片、同消息两张图片均通过采集器取图和 MD5 校验；私聊另通过原生桥接接口直接校验。已安装的 ChatLab Desktop 中，DBX 消息 `17757` 的预览与原图正常显示。共用 HTTP 图片路由在在线时返回清单、WebP 预览与原图；退出 QQ 并暂停采集器后，已缓存的清单、预览仍返回 200，原图请求明确失败。

QQ 正常退出后发现文件被清理；不带桥接环境变量重启后 `ready=true`，账号、数据目录与采集器一致，只保留一个 QQ 主进程。独立数据副本运行期间，QQ 未打开原始容器中的聊天数据库。以上仅为样本验收，不代表任意历史图片都能恢复；部分更早图片仍下载失败。后续修复为多张未缓存图片增加了有界自动排队；队列总量满或整体请求超时仍保留失败与重试入口。

自动排队修复当时通过 18 项桥接测试与 12 项采集器图片测试。更新并重启本机 QQ 桥接副本后，同时提交 7 个不同附件的原生取图请求，6 张返回 200 且 MD5 一致，1 张原有 MD5 不符样本仍返回 `IMAGE_INTEGRITY_FAILED`，没有返回 `QQ_IMAGE_BUSY`。该实测使用 QQ 原生下载接口（可能命中 QQ 自身缓存）；队列顺序、两项并发上限、总容量、共享截止时间及超时移除由合成回归测试验证。

后续完整性修复确认：QQ 可为 `original=false` 附件返回与消息 MD5 不同的全尺寸文件，完成事件与原生 `sourcePath` 均指向该附件。补充严格的原生来源验证和独立传输 MD5 后，抽查 12 张图片，强制通过采集器在线链路调用实际 QQ 桥接，全部返回成功，其中 2 张走全尺寸变体验证。已安装 Desktop 中也验证了样本图片预览及原图打开。该结果覆盖本机 QQ 7.0.1-52892 的抽查样本，其他变体与历史图片仍需按实际失败记录排查。

本机保留原版应用与原始账号数据，采集器已切换到桥接副本使用的账号数据。切回原版时应同时恢复采集器数据来源；不要把两份数据直接覆盖合并。客户端更新与长期维护仍需单独验证。
