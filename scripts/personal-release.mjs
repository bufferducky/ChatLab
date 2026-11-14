#!/usr/bin/env node
/** Build version-specific notes and verify the exact files exposed to fork users. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
const digest = (file, algorithm = 'sha256', encoding = 'hex') =>
  createHash(algorithm).update(fs.readFileSync(file)).digest(encoding)
const required = [
  `ChatLab-Personal-${version}-arm64.dmg`,
  `ChatLab-Personal-${version}-arm64.zip`,
  `ChatLab-${version}-setup.exe`,
  'latest-mac.yml',
  'latest.yml',
  'BUILD_INFO.json',
]
const optional = required.filter((name) => /\.(dmg|zip|exe)$/.test(name)).map((name) => `${name}.blockmap`)

export function releaseNotes(repository = 'bufferducky/ChatLab') {
  const read = (locale) => {
    const entry = JSON.parse(fs.readFileSync(path.join(root, 'changelogs', `${locale}.json`), 'utf8')).find(
      (item) => item.version === version
    )
    if (!entry) throw new Error(`Missing ${locale} release notes for ${version}`)
    return entry
  }
  const cn = read('cn')
  const en = read('en')
  const changes = (entry) =>
    entry.changes
      .flatMap((group) => group.items.map((item) => `- ${typeof item === 'string' ? item : item.text}`))
      .join('\n')
  const base = `https://github.com/${repository}`
  return `# ChatLab Personal v${version}\n\n${cn.summary}\n\n## 更新内容\n\n${changes(cn)}\n\n## 下载与升级\n\n| 平台 | 安装包 |\n| --- | --- |\n| macOS Apple Silicon | [DMG](${base}/releases/download/v${version}/ChatLab-Personal-${version}-arm64.dmg) · [ZIP](${base}/releases/download/v${version}/ChatLab-Personal-${version}-arm64.zip) |\n| Windows x64 | [安装程序](${base}/releases/download/v${version}/ChatLab-${version}-setup.exe) |\n\n个人 Fork 版本；macOS 包未使用 Apple 开发者证书签名或公证，Windows 包未做代码签名。桌面包包含阅读与同步能力；QQ、企微、Telegram 采集器仍需按仓库 integrations 文档在本机部署和授权，不包含账号或聊天数据。macOS 已做本机阅读抽查；Windows 仅通过 CI 构建和原生运行时检查，不等同于真机完整验收。\n\n每个安装包及自动更新元数据均由 SHA256SUMS.txt 覆盖。BUILD_INFO.json 记录版本和源码提交；发布前会重新下载草稿资产复核完整性。已有数据目录及采集配置继续保留。\n\n## English\n\n${en.summary}\n\n${changes(en)}\n\nPersonal fork for macOS Apple Silicon and Windows x64. Desktop installers are unsigned; macOS is not notarized. The collectors require separate local setup and authorization. Releases contain no accounts or chat data. Windows CI runtime checks do not constitute a full device test. Verify downloads with SHA256SUMS.txt; BUILD_INFO.json identifies the source commit.\n\n[完整更新日志](${base}/blob/v${version}/changelogs/cn.md) · [English changelog](${base}/blob/v${version}/changelogs/en.md)\n`
}

function unquote(value) {
  return value.replace(/^(['"])(.*)\1$/, '$2')
}

export function verifyRelease(directory, write = false) {
  const actual = fs
    .readdirSync(directory)
    .filter((name) => name !== 'SHA256SUMS.txt')
    .sort()
  if (
    required.some((name) => !actual.includes(name)) ||
    actual.some((name) => ![...required, ...optional].includes(name))
  )
    throw new Error('Release assets are missing or unexpected')
  for (const name of actual) {
    const stat = fs.lstatSync(path.join(directory, name))
    if (!stat.isFile() || stat.size === 0) throw new Error(`Invalid release asset: ${name}`)
  }
  const info = JSON.parse(fs.readFileSync(path.join(directory, 'BUILD_INFO.json'), 'utf8'))
  if (info.version !== version || !/^[a-f0-9]{40}$/.test(info.commit))
    throw new Error('Release source identity mismatch')
  const expectedCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  if (info.commit !== expectedCommit) throw new Error('Release commit does not match checked-out source')
  for (const manifest of ['latest-mac.yml', 'latest.yml']) {
    const text = fs.readFileSync(path.join(directory, manifest), 'utf8')
    if (unquote(/^version: (.+)$/m.exec(text)?.[1] ?? '') !== version)
      throw new Error(`Wrong updater version: ${manifest}`)
    const files = []
    let file
    for (const line of text.split(/\r?\n/)) {
      const url = /^ {2}- url: (.+)$/.exec(line)
      if (url) {
        file = { name: unquote(url[1]) }
        files.push(file)
      }
      const hash = /^ {4}sha512: (.+)$/.exec(line)
      if (hash && file) file.hash = unquote(hash[1])
      const size = /^ {4}size: (\d+)$/.exec(line)
      if (size && file) file.size = Number(size[1])
    }
    if (!files.length) throw new Error(`Empty updater manifest: ${manifest}`)
    for (const file of files) {
      if (!actual.includes(file.name) || !/\.(dmg|zip|exe)$/.test(file.name))
        throw new Error('Updater references an unknown file')
      const filename = path.join(directory, file.name)
      if (fs.statSync(filename).size !== file.size || digest(filename, 'sha512', 'base64') !== file.hash)
        throw new Error(`Updater integrity mismatch: ${file.name}`)
    }
  }
  const checksumFile = path.join(directory, 'SHA256SUMS.txt')
  if (write)
    fs.writeFileSync(
      checksumFile,
      actual.map((name) => `${digest(path.join(directory, name))}  ${name}`).join('\n') + '\n'
    )
  const checked = new Set()
  for (const line of fs.readFileSync(checksumFile, 'utf8').trim().split('\n')) {
    const match = /^([a-f0-9]{64}) {2}([^/\\\r\n]+)$/.exec(line)
    if (
      !match ||
      !actual.includes(match[2]) ||
      checked.has(match[2]) ||
      digest(path.join(directory, match[2])) !== match[1]
    )
      throw new Error('Release checksum mismatch')
    checked.add(match[2])
  }
  if (checked.size !== actual.length) throw new Error('Release checksums are incomplete')
  return { version, commit: info.commit, assets: checked.size }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, destination, flag] = process.argv.slice(2)
  if (command === 'notes' && destination) fs.writeFileSync(destination, releaseNotes())
  else if (command === 'verify' && destination)
    console.log(JSON.stringify(verifyRelease(destination, flag === '--write-checksums')))
  else throw new Error('Usage: personal-release.mjs notes <file> | verify <directory> [--write-checksums]')
}
