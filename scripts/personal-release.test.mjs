import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { releaseNotes, verifyRelease } from './personal-release.mjs'

const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version
const digest = (data) => createHash('sha512').update(data).digest('base64')

test('a complete release verifies its source, updater payloads and redownloaded bytes', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-release-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const dmg = `ChatLab-Personal-${version}-arm64.dmg`
  const zip = `ChatLab-Personal-${version}-arm64.zip`
  const exe = `ChatLab-${version}-setup.exe`
  const files = [dmg, zip, exe]
  const data = Buffer.from('synthetic installer bytes')
  for (const name of files) fs.writeFileSync(path.join(directory, name), data)
  const manifest = (names) =>
    `version: ${version}\nfiles:\n` +
    names.map((name) => `  - url: ${name}\n    sha512: ${digest(data)}\n    size: ${data.length}\n`).join('')
  fs.writeFileSync(path.join(directory, 'latest-mac.yml'), manifest([zip, dmg]))
  fs.writeFileSync(path.join(directory, 'latest.yml'), manifest([exe]))
  fs.writeFileSync(
    path.join(directory, 'BUILD_INFO.json'),
    JSON.stringify({ version, commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() })
  )
  assert.equal(verifyRelease(directory, true).assets, 6)
  assert.equal(verifyRelease(directory).assets, 6)
  fs.appendFileSync(path.join(directory, zip), 'corrupted')
  assert.throws(() => verifyRelease(directory), /integrity mismatch/)
  fs.writeFileSync(path.join(directory, zip), data)
  fs.unlinkSync(path.join(directory, exe))
  assert.throws(() => verifyRelease(directory), /missing or unexpected/)
  fs.writeFileSync(path.join(directory, exe), data)
  fs.writeFileSync(path.join(directory, 'SHA256SUMS.txt'), '')
  assert.throws(() => verifyRelease(directory), /checksum/)
})

test('notes match the release version and link to this project installers', () => {
  const notes = releaseNotes()
  assert.ok(notes.includes(`ChatLab Personal v${version}`))
  assert.ok(notes.includes(`/bufferducky/ChatLab/releases/download/v${version}/ChatLab-${version}-setup.exe`))
  assert.ok(notes.includes('macOS'))
  assert.ok(notes.includes('Windows'))
  assert.ok(!notes.includes('https://github.com/ChatLab/ChatLab/releases/download/'))
})
