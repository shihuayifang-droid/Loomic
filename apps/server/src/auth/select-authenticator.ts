// HAHART authenticator selection (ticket 42C / ADR-0001).
//
// One switch decides which `RequestAuthenticator` the app runs: the Supabase
// verifier that has always been there, or the self-hosted verifier added in
// 42C. Both factories are passed as thunks, so exactly one of them is ever
// constructed - an unset variable keeps today's behaviour and never touches
// the self-hosted path.
import {
  DEFAULT_AUTH_PROVIDER,
  type ServerEnv,
} from "../config/env.js";
import type { RequestAuthenticator } from "../supabase/user.js";

export type RequestAuthenticatorFactories = {
  supabase: () => RequestAuthenticator;
  self: () => RequestAuthenticator;
};

export function selectRequestAuthenticator(
  env: ServerEnv,
  deps: RequestAuthenticatorFactories,
): RequestAuthenticator {
  if ((env.authProvider ?? DEFAULT_AUTH_PROVIDER) === "self") {
    return deps.self();
  }

  return deps.supabase();
}
