/** Shared presentation and filtering for chat origins, independent of the import transport. */
const neutralClass = 'bg-gray-100 text-gray-700 dark:bg-gray-700/60 dark:text-gray-200'
const blueClass = 'bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300'
const greenClass = 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'

const platforms: Record<string, { icon: string; badgeClass: string }> = {
  qq: { icon: 'i-simple-icons-qq', badgeClass: blueClass },
  wecom: { icon: 'i-lucide-briefcase-business', badgeClass: greenClass },
  weixin: { icon: 'i-simple-icons-wechat', badgeClass: greenClass },
  telegram: { icon: 'i-simple-icons-telegram', badgeClass: blueClass },
  discord: { icon: 'i-simple-icons-discord', badgeClass: neutralClass },
  whatsapp: { icon: 'i-simple-icons-whatsapp', badgeClass: greenClass },
  instagram: { icon: 'i-simple-icons-instagram', badgeClass: neutralClass },
  'google-chat': { icon: 'i-lucide-messages-square', badgeClass: neutralClass },
  line: { icon: 'i-simple-icons-line', badgeClass: greenClass },
  imessage: { icon: 'i-lucide-message-circle', badgeClass: greenClass },
  mixed: { icon: 'i-lucide-layers', badgeClass: neutralClass },
  unknown: { icon: 'i-lucide-circle-help', badgeClass: neutralClass },
}

export function getChatPlatform(platform: string) {
  // Both spellings occur in supported ChatLab exports; neither denotes WeCom.
  const key = platform === 'wechat' ? 'weixin' : Object.hasOwn(platforms, platform) ? platform : 'unknown'
  return { key, labelKey: `common.platform.${key}`, ...platforms[key]! }
}

export function filterSessionsByPlatform<T extends { platform: string }>(sessions: T[], platform: string): T[] {
  return platform === 'all'
    ? sessions
    : sessions.filter((session) => getChatPlatform(session.platform).key === platform)
}

export function getPlatformFilters(sessions: { platform: string }[], matchingSessions = sessions) {
  const keys = [...new Set(sessions.map((session) => getChatPlatform(session.platform).key))]
  // Keep the two local collectors stable at the front, with other platforms in catalog order.
  const priority = (key: string) => (key === 'qq' ? 0 : key === 'wecom' ? 1 : 2)
  keys.sort((a, b) => priority(a) - priority(b))
  return keys.map((key) => ({ ...getChatPlatform(key), count: filterSessionsByPlatform(matchingSessions, key).length }))
}
