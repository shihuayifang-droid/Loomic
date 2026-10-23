// HAHART self-hosted request authenticator (ticket 42C / ADR-0001).
//
// Verifies the HS256 access token minted by ticket 42A and then re-reads the
// authoritative state on EVERY request: the user row, its credential version
// and the session the token names. Nothing is cached here on purpose - a
// revoked session, a bumped `token_version` (password change) or a disabled
// account takes effect on the very next request. The Supabase-era
// authenticator caches 5 minutes for its own reasons; that behaviour is not
// copied into this one.
//
// Pure module: no database client, no env reads. The caller injects the token
// configuration and the two repository reads.
import type {
  AuthenticatedUser,
  RequestAuthenticator,
} from "../supabase/user.js";
import { type AccessTokenConfig, verifyAccessToken } from "./tokens.js";

/** The subset of an `AuthUser` row this authenticator needs to see. */
export type SelfAuthUser = {
  id: string;
  email: string;
  status: string;
  tokenVersion: number;
};

export type SelfAuthDeps = {
  token: AccessTokenConfig;
  findUserById: (id: string) => Promise<SelfAuthUser | null>;
  isSessionActive: (sessionId: string, at: Date) => Promise<boolean>;
  now?: () => Date;
};

export function createSelfRequestAuthenticator(
  deps: SelfAuthDeps,
): RequestAuthenticator {
  return {
    async authenticate(request) {
      const accessToken = readBearerToken(request.headers.authorization);
      if (!accessToken) return null;

      // One clock reading for both the token and the session check, so a
      // request cannot be judged against two different "now"s.
      const at = deps.now ? deps.now() : new Date();

      const verified = await verifyAccessToken(deps.token, accessToken, at);
      if (!verified.ok) return null;

      const { claims } = verified;

      const user = await deps.findUserById(claims.sub);
      if (!user) return null;
      // Administrator approval / suspension.
      if (user.status !== "active") return null;
      // Moved by a password change: every access token issued before it is dead.
      if (user.tokenVersion !== claims.ver) return null;

      const sessionActive = await deps.isSessionActive(claims.sid, at);
      if (!sessionActive) return null;

      const authenticated: AuthenticatedUser = {
        accessToken,
        email: user.email,
        id: user.id,
        userMetadata: {},
      };
      return authenticated;
    },
  };
}

/**
 * `authorization: Bearer <token>` -> `<token>`. Case-insensitive scheme, any
 * amount of surrounding whitespace, and `null` for anything else (missing
 * header, a non-Bearer scheme, an empty token, a repeated header).
 */
function readBearerToken(
  authorizationHeader: string | string[] | undefined,
): string | null {
  if (typeof authorizationHeader !== "string") {
    return null;
  }

  const [scheme, token] = authorizationHeader.trim().split(/\s+/, 2);

  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return null;
  }

  return token;
}
