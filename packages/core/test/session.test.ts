import { describe, expect, it } from 'vitest'
import { ApiError, sessionEnded } from '../src/api'

describe('when a failed call ends the session', () => {
  it('the server no longer knows it, or its account is gone', () => {
    expect(sessionEnded(new ApiError(401, 'invalid session'))).toBe(true)
    expect(sessionEnded(new ApiError(409, 'unknown user'))).toBe(true)
  })
  it('never for no network, a timeout or a server error', () => {
    expect(sessionEnded(new TypeError('Network request failed'))).toBe(false)
    expect(sessionEnded(new ApiError(500, 'The server answered 500.'))).toBe(false)
    expect(sessionEnded(new ApiError(503, 'unavailable'))).toBe(false)
    expect(sessionEnded(new ApiError(429, 'slow down'))).toBe(false)
    expect(sessionEnded(undefined)).toBe(false)
  })
})
