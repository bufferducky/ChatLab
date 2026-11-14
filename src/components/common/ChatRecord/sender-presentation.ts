import type { ChatRecordMessage } from './types'

// Explicit classes let Tailwind include every member color in production builds.
const SENDER_COLORS = [
  {
    avatar: 'bg-blue-100 dark:bg-blue-900',
    text: 'text-blue-800 dark:text-blue-200',
    ring: 'ring-blue-400 dark:ring-blue-500',
  },
  {
    avatar: 'bg-orange-100 dark:bg-orange-900',
    text: 'text-orange-800 dark:text-orange-200',
    ring: 'ring-orange-400 dark:ring-orange-500',
  },
  {
    avatar: 'bg-emerald-100 dark:bg-emerald-900',
    text: 'text-emerald-800 dark:text-emerald-200',
    ring: 'ring-emerald-400 dark:ring-emerald-500',
  },
  {
    avatar: 'bg-violet-100 dark:bg-violet-900',
    text: 'text-violet-800 dark:text-violet-200',
    ring: 'ring-violet-400 dark:ring-violet-500',
  },
  {
    avatar: 'bg-rose-100 dark:bg-rose-900',
    text: 'text-rose-800 dark:text-rose-200',
    ring: 'ring-rose-400 dark:ring-rose-500',
  },
  {
    avatar: 'bg-cyan-100 dark:bg-cyan-900',
    text: 'text-cyan-800 dark:text-cyan-200',
    ring: 'ring-cyan-400 dark:ring-cyan-500',
  },
  {
    avatar: 'bg-amber-100 dark:bg-amber-900',
    text: 'text-amber-800 dark:text-amber-200',
    ring: 'ring-amber-400 dark:ring-amber-500',
  },
  {
    avatar: 'bg-indigo-100 dark:bg-indigo-900',
    text: 'text-indigo-800 dark:text-indigo-200',
    ring: 'ring-indigo-400 dark:ring-indigo-500',
  },
  {
    avatar: 'bg-teal-100 dark:bg-teal-900',
    text: 'text-teal-800 dark:text-teal-200',
    ring: 'ring-teal-400 dark:ring-teal-500',
  },
  {
    avatar: 'bg-pink-100 dark:bg-pink-900',
    text: 'text-pink-800 dark:text-pink-200',
    ring: 'ring-pink-400 dark:ring-pink-500',
  },
  {
    avatar: 'bg-lime-100 dark:bg-lime-900',
    text: 'text-lime-800 dark:text-lime-200',
    ring: 'ring-lime-400 dark:ring-lime-500',
  },
  {
    avatar: 'bg-sky-100 dark:bg-sky-900',
    text: 'text-sky-800 dark:text-sky-200',
    ring: 'ring-sky-400 dark:ring-sky-500',
  },
  {
    avatar: 'bg-fuchsia-100 dark:bg-fuchsia-900',
    text: 'text-fuchsia-800 dark:text-fuchsia-200',
    ring: 'ring-fuchsia-400 dark:ring-fuchsia-500',
  },
  {
    avatar: 'bg-green-100 dark:bg-green-900',
    text: 'text-green-800 dark:text-green-200',
    ring: 'ring-green-400 dark:ring-green-500',
  },
  {
    avatar: 'bg-red-100 dark:bg-red-900',
    text: 'text-red-800 dark:text-red-200',
    ring: 'ring-red-400 dark:ring-red-500',
  },
  {
    avatar: 'bg-purple-100 dark:bg-purple-900',
    text: 'text-purple-800 dark:text-purple-200',
    ring: 'ring-purple-400 dark:ring-purple-500',
  },
] as const

export function getSenderColor(platform: string, platformId: string) {
  // Platform IDs survive renames, searches, pagination and re-imports.
  let hash = 2166136261
  for (const char of `${platform}:${platformId}`) {
    hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619)
  }
  return SENDER_COLORS[(hash >>> 0) % SENDER_COLORS.length]!
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export function getSenderInitials(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return '?'

  const segments = [...graphemeSegmenter.segment(trimmed)].map(({ segment }) => segment)
  const letters = segments.filter((segment) => /[\p{L}\p{N}]/u.test(segment))
  if (!letters.length) return segments[0]!

  // Keep CJK names readable; use word initials for names such as Luis Pater.
  if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(letters[0]!)) {
    return letters.slice(0, 2).join('')
  }
  const words = trimmed.match(/[\p{L}\p{N}]+/gu) ?? []
  if (words.length > 1) {
    return words
      .slice(0, 2)
      .map((word) => [...graphemeSegmenter.segment(word)][0]!.segment)
      .join('')
      .toLocaleUpperCase()
  }
  return letters.slice(0, 2).join('').toLocaleUpperCase()
}

export function isSenderContinuation(previous: ChatRecordMessage | undefined, current: ChatRecordMessage): boolean {
  if (!previous || !current.senderPlatformId) return false
  const gap = current.timestamp - previous.timestamp
  return (
    current.senderPlatformId === previous.senderPlatformId &&
    current.senderName === previous.senderName &&
    gap >= 0 &&
    gap < 120
  )
}
