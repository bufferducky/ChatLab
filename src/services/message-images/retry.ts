export interface ImageFailure {
  code: string
  message: string
  retryable: boolean
  retryAfterSeconds?: number
  retryAt?: number
}

export function asImageFailure(error: unknown): ImageFailure {
  return error && typeof error === 'object' && 'code' in error && 'retryable' in error
    ? (error as ImageFailure)
    : { code: 'IMAGE_SOURCE_UNAVAILABLE', message: '', retryable: true }
}

function wait(milliseconds: number, signal: AbortSignal) {
  signal.throwIfAborted()
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** Retry only active readers: server cooldowns are authoritative, network retries bounded. */
export async function withImageRetry<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  waiting: (failure: ImageFailure | null) => void
): Promise<T> {
  let transientRetries = 0
  for (;;) {
    signal.throwIfAborted()
    waiting(null)
    try {
      return await operation()
    } catch (error) {
      signal.throwIfAborted()
      const failure = asImageFailure(error)
      const cooldown = failure.retryAfterSeconds
      if (failure.code === 'IMAGE_RATE_LIMITED' && cooldown && cooldown > 0) {
        waiting({ ...failure, retryAt: Date.now() + cooldown * 1000 })
        // Split long waits to keep timer values representable; cancellation always wins.
        const deadline = Date.now() + cooldown * 1000
        while (Date.now() < deadline) await wait(Math.min(deadline - Date.now(), 60_000), signal)
      } else if (failure.retryable && transientRetries++ < 1) {
        await wait(500, signal)
      } else {
        throw failure
      }
    }
  }
}
