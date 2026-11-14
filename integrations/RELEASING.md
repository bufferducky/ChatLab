# ChatLab Personal 发布

版本说明与安装包由本仓库维护，发布到 `bufferducky/ChatLab`。上游发布流程只在上游仓库执行；个人版不调用 npm publish 或上游对象存储。

## 准备版本

1. 更新根目录 `package.json` 的版本，遵循 semver。新增功能使用 minor，修复使用 patch。
2. 在 `changelogs/cn.json`、`en.json`、`tw.json`、`ja.json` 为当前版本添加日期、摘要和变更内容。
3. 使用 Node.js 24 执行 `node scripts/changelog-to-markdown.mjs`，再执行 `node scripts/personal-release.mjs notes RELEASE_NOTES.md`。发布只提取与当前版本匹配的说明，不覆盖旧版本记录。
4. 完成类型、lint、格式、相关回归和隐私检查。Git 作者／提交者使用公开 GitHub 身份及 noreply 邮箱；检查待推送历史，不能仅扫描最后一次提交。
5. 提交至 `main`，创建与版本匹配的 `v版本号` tag，再将分支和该 tag 推送到本仓库。

## 自动构建与发布

`.github/workflows/personal-release.yml` 校验 tag、根版本和说明，然后分别在 macOS arm64 与 Windows x64 runner 上构建 Rust 解析器、Electron 和对应安装包。程序版本由根版本注入，桌面子包的开发占位版本不作为发布版本。

构建过程中使用项目现有原生检查，避免仅生成安装文件却缺失 SQLite、解析器或图片运行时。当前个人包不使用平台开发者签名或 Apple 公证；Release 会明确说明验证范围。

全部平台成功后才组装草稿：

- 必须包含 macOS DMG、ZIP、Windows 安装程序，以及各平台更新清单。
- `BUILD_INFO.json` 记录版本、源码提交和构建任务。
- 校验更新清单引用的文件、大小和 SHA512，再生成覆盖全部资产的 `SHA256SUMS.txt`。
- 上传后重新下载草稿资产，核对源码身份和全部哈希，通过才公开并设置 Latest；预发布 tag 使用 Prerelease。

代码、说明和下载链接指向本仓库。采集器运行配置、账号、密钥、授权会话、聊天库、截图、运行日志和个人交付记录不进入源码归档或 Release。

## 失败续办

构建失败时修复后创建新提交和新版本 tag；不移动已经发布的 tag。发布阶段已产生草稿时，先检查草稿和资产，不重复创建同名 Release。可下载资产至空目录，执行：

```bash
node scripts/personal-release.mjs verify /path/to/downloaded-assets
```

手动补传只接受同一 tag 源码的产物。不能将旧构建改名充当新版本；本机交付记录及包含绝对路径的构建清单不作为公共附件。
