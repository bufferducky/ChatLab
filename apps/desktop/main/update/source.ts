import { autoUpdater } from 'electron-updater'
import { logger } from '../logger'
import { getActiveProxyUrl } from '../network/proxy'

export function configureUpdateProxy(): void {
  const proxyUrl = getActiveProxyUrl()

  if (proxyUrl) {
    process.env.HTTPS_PROXY = proxyUrl
    process.env.HTTP_PROXY = proxyUrl
    logger.info('[Update] Proxy configured')
  } else {
    delete process.env.HTTPS_PROXY
    delete process.env.HTTP_PROXY
  }
}

export function resetToDefaultSource(): void {
  switchToGitHubUpdateSource()
}

export function handleUpdateError(error: Error): void {
  logger.error(`[Update] GitHub update error: ${error.message || error}`)
}

export function switchToGitHubUpdateSource(): void {
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: 'bufferducky',
    repo: 'ChatLab',
  })
  logger.info('[Update] Using personal fork GitHub update source')
}

export function isUpdateNetworkError(error: Error): boolean {
  const networkErrorKeywords = [
    'ECONNREFUSED',
    'ENOTFOUND',
    'ETIMEDOUT',
    'ECONNRESET',
    'ENETUNREACH',
    'EAI_AGAIN',
    'socket hang up',
    'network',
    'connect',
    'timeout',
    'getaddrinfo',
  ]
  const errorMessage = error.message?.toLowerCase() || ''
  const errorCode = (error as NodeJS.ErrnoException).code?.toLowerCase() || ''

  return networkErrorKeywords.some(
    (keyword) => errorMessage.includes(keyword.toLowerCase()) || errorCode.includes(keyword.toLowerCase())
  )
}
