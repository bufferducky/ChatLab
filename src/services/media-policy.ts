import { get, patch } from './utils/http'

export interface MediaPolicy {
  videoPrefetch: boolean
  supported: boolean
}

const MEDIA_POLICY_PATH = '/automation/media-policy'

/**
 * Telegram media prefetch policy.
 *
 * The server owns the stored value. `supported` reports whether the current
 * runtime can prefetch media at all, so the settings UI can hide itself.
 */
export function useMediaPolicyService() {
  return {
    getMediaPolicy: () => get<MediaPolicy>(MEDIA_POLICY_PATH),
    setVideoPrefetch: (value: boolean) => patch<MediaPolicy>(MEDIA_POLICY_PATH, { videoPrefetch: value }),
  }
}
