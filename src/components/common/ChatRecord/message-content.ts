import MarkdownIt from 'markdown-it'
import type { MessageLink, MessageLinks } from '@openchatlab/shared-types'

const linkifier = new MarkdownIt({ html: false, linkify: true }).linkify
const MARK_CLASS =
  'bg-transparent text-inherit underline decoration-primary-500/80 underline-offset-4 dark:decoration-primary-400/80'
const LINK_CLASS =
  'text-blue-600 underline underline-offset-2 hover:text-blue-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:text-blue-400 dark:hover:text-blue-300'
const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
const normalize = (text: string) => text.replace(/\r\n?/g, '\n')

function safeUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

/** Normalize service placeholders from already imported Telegram archives at display time. */
export function localizeTelegramServiceMessage(content: string, translate: (key: string) => string): string {
  const actions: Record<string, string> = {
    MessageActionChatAddUser: 'membersAdded',
    MessageActionChatJoinedByLink: 'joinedByLink',
    MessageActionChatJoinedByRequest: 'joinedByRequest',
    MessageActionChatDeleteUser: 'memberRemoved',
    MessageActionChatCreate: 'groupCreated',
    MessageActionChannelCreate: 'channelCreated',
    MessageActionChatEditTitle: 'titleChanged',
    MessageActionChatEditPhoto: 'photoChanged',
    MessageActionChatDeletePhoto: 'photoChanged',
    MessageActionPinMessage: 'messagePinned',
    MessageActionHistoryClear: 'historyCleared',
    MessageActionChatMigrateTo: 'groupMigrated',
    MessageActionChannelMigrateFrom: 'groupMigrated',
  }
  return content.replace(/^\[(MessageAction\w+)\]/, (_, action: string) =>
    translate(`records.telegramService.${actions[action] ?? 'other'}`)
  )
}

/** Render text and entity links without ever treating archived messages as HTML. */
export function renderMessageContent(
  content: string,
  keywords: string[] = [],
  metadata?: MessageLinks | null,
  originalContent = content
): string {
  const pattern = keywords
    .filter(Boolean)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')
  function text(value: string) {
    if (!pattern) return escapeHtml(value)
    const regex = new RegExp(pattern, 'gi')
    let html = '',
      cursor = 0
    for (const match of value.matchAll(regex)) {
      html +=
        escapeHtml(value.slice(cursor, match.index)) + `<mark class="${MARK_CLASS}">${escapeHtml(match[0])}</mark>`
      cursor = match.index + match[0].length
    }
    return html + escapeHtml(value.slice(cursor))
  }
  const links: MessageLink[] = []
  const normalizedOriginal = normalize(originalContent)
  const start = normalizedOriginal.indexOf(content)
  if (metadata?.content === originalContent && start >= 0) {
    for (const link of metadata.links) {
      const offset = normalize(originalContent.slice(0, link.offset)).length - start
      const end = normalize(originalContent.slice(0, link.offset + link.length)).length - start
      if (offset >= 0 && end <= content.length && end > offset && safeUrl(link.url))
        links.push({ ...link, offset, length: end - offset })
    }
  }
  for (const match of linkifier.match(content) ?? []) {
    if (
      safeUrl(match.url) &&
      !links.some((link) => match.index < link.offset + link.length && match.lastIndex > link.offset)
    ) {
      links.push({ offset: match.index, length: match.lastIndex - match.index, url: match.url })
    }
  }
  let html = '',
    cursor = 0
  for (const link of links.sort((a, b) => a.offset - b.offset)) {
    if (link.offset < cursor) continue
    html += text(content.slice(cursor, link.offset))
    html += `<a href="${escapeHtml(safeUrl(link.url)!)}" target="_blank" rel="noopener noreferrer" class="${LINK_CLASS}">${text(content.slice(link.offset, link.offset + link.length))}</a>`
    cursor = link.offset + link.length
  }
  return html + text(content.slice(cursor))
}
