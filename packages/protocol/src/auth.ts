// Signing in and who you are (worker/src/index.js /auth/otp/*, /me).

export interface OtpRequest { email: string; locale?: string }
export interface OtpVerify { email: string; code: string; name?: string; inviteCode?: string; locale?: string }
export interface SignedIn { token: string; userId: string; login: string; orgId: string | null; created?: boolean; inviteError?: string }

/// Sign in with Apple (POST /auth/apple): Apple's identity token, and the
/// nonce whose SHA-256 (hex) the app gave Apple — the token carries the hash,
/// only the app knows what it was made from. `name` is what Apple hands the
/// app the first time only; used when the account is new. `authorizationCode`
/// is Apple's short-lived code from the same sign-in: the Worker trades it for
/// a refresh token so that deleting the account can revoke the authorization.
export interface AppleSignIn { identityToken: string; nonce: string; name?: string; inviteCode?: string; locale?: string; authorizationCode?: string }

/// Redeeming an invitation (POST /invites/accept). 202 when an admin must approve.
export interface InviteAccepted { orgId: string; joined?: boolean; pending?: boolean; role?: string; message?: string }

export interface Me {
  login: string
  userId: string
  orgId: string | null
  name: string | null
  handle: string | null
  avatarUrl: string | null
  locale: string
  /// Every workspace this person is in.
  orgs?: Array<{ id: string; name: string | null; icon?: string | null; role?: string; memberCount?: number }>
}

/// A workspace's channel (GET /businesses): `b:<slug>` is its key.
export interface Business { slug: string; name: string; private: number | boolean }
