import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";

import {
  createSelfRequestAuthenticator,
  type SelfAuthDeps,
  type SelfAuthUser,
} from "./self-authenticator.js";
import {
  type AccessTokenConfig,
  accessTokenSecretFrom,
  DEFAULT_ACCESS_TTL_SECONDS,
  signAccessToken,
} from "./tokens.js";

/** Test-only key material: 36 bytes, never anything resembling a secret. */
const SECRET_RAW = "self-auth-test-secret-0123456789abcd";
const NOW = new Date("2026-01-01T00:00:00.000Z");
const SESSION_ID = "session-1";

const ACTIVE_USER: SelfAuthUser = {
  email: "user@example.invalid",
  id: "user-1",
  status: "active",
  tokenVersion: 3,
};

function makeConfig(overrides: Partial<AccessTokenConfig> = {}): AccessTokenConfig {
  return {
    secret: accessTokenSecretFrom(SECRET_RAW),
    issuer: "hahart",
    audience: "hahart-api",
    ttlSeconds: DEFAULT_ACCESS_TTL_SECONDS,
    ...overrides,
  };
}

type DepsOverrides = {
  now?: Date;
  sessionActive?: boolean;
  token?: AccessTokenConfig;
  user?: SelfAuthUser | null;
};

function makeDeps(overrides: DepsOverrides = {}): SelfAuthDeps {
  const user = overrides.user === undefined ? ACTIVE_USER : overrides.user;

  return {
    token: overrides.token ?? makeConfig(),
    findUserById: async () => user,
    isSessionActive: async () => overrides.sessionActive ?? true,
    now: () => overrides.now ?? NOW,
  };
}

async function makeToken(
  config: AccessTokenConfig = makeConfig(),
  user: SelfAuthUser = ACTIVE_USER,
  now: Date = NOW,
): Promise<string> {
  return signAccessToken(
    config,
    {
      sub: user.id,
      sid: SESSION_ID,
      ver: user.tokenVersion,
      email: user.email,
    },
    now,
  );
}

function request(header?: string): Pick<FastifyRequest, "headers"> {
  return { headers: header === undefined ? {} : { authorization: header } };
}

function tamper(token: string): string {
  const parts = token.split(".");
  const signature = parts[2] ?? "";
  // The FIRST base64url character of the signature is the one that cannot be
  // absorbed by the decoder's unused trailing bits (the last one can).
  const replacement = signature.slice(0, 1) === "A" ? "B" : "A";
  return `${parts[0] ?? ""}.${parts[1] ?? ""}.${replacement}${signature.slice(1)}`;
}

function expiredNow(): Date {
  return new Date(NOW.getTime() + (DEFAULT_ACCESS_TTL_SECONDS + 60) * 1000);
}

describe("S-A3 createSelfRequestAuthenticator", () => {
  it("S-A3: a valid token returns the user with empty metadata", async () => {
    const auth = createSelfRequestAuthenticator(makeDeps());

    await expect(
      auth.authenticate(request(`Bearer ${await makeToken()}`)),
    ).resolves.toEqual({
      accessToken: expect.any(String),
      email: ACTIVE_USER.email,
      id: ACTIVE_USER.id,
      userMetadata: {},
    });
  });

  it("S-A3: the bearer scheme is case-insensitive and tolerates whitespace", async () => {
    const token = await makeToken();
    const auth = createSelfRequestAuthenticator(makeDeps());

    await expect(
      auth.authenticate(request(`   bEaReR   ${token}  `)),
    ).resolves.toMatchObject({ id: ACTIVE_USER.id });
  });

  it("S-A3: no authorization header is rejected", async () => {
    const auth = createSelfRequestAuthenticator(makeDeps());

    await expect(auth.authenticate(request())).resolves.toBeNull();
  });

  it("S-A3: a non-bearer scheme is rejected", async () => {
    const auth = createSelfRequestAuthenticator(makeDeps());

    await expect(
      auth.authenticate(request(`Basic ${await makeToken()}`)),
    ).resolves.toBeNull();
  });

  it("S-A3: an empty bearer token is rejected", async () => {
    const auth = createSelfRequestAuthenticator(makeDeps());

    await expect(auth.authenticate(request("Bearer   "))).resolves.toBeNull();
  });

  it("S-A3: a tampered signature is rejected", async () => {
    const auth = createSelfRequestAuthenticator(makeDeps());

    await expect(
      auth.authenticate(request(`Bearer ${tamper(await makeToken())}`)),
    ).resolves.toBeNull();
  });

  it("S-A3: a token signed with another secret is rejected", async () => {
    const otherConfig = makeConfig({
      secret: accessTokenSecretFrom("another-test-secret-0123456789abcdef"),
    });
    const auth = createSelfRequestAuthenticator(makeDeps());

    await expect(
      auth.authenticate(request(`Bearer ${await makeToken(otherConfig)}`)),
    ).resolves.toBeNull();
  });

  it("S-A3: an expired token is rejected", async () => {
    const auth = createSelfRequestAuthenticator(makeDeps({ now: expiredNow() }));

    await expect(
      auth.authenticate(request(`Bearer ${await makeToken()}`)),
    ).resolves.toBeNull();
  });

  it("S-A3: a pending user is rejected", async () => {
    const user = { ...ACTIVE_USER, status: "pending" };
    const auth = createSelfRequestAuthenticator(makeDeps({ user }));

    await expect(
      auth.authenticate(request(`Bearer ${await makeToken(makeConfig(), user)}`)),
    ).resolves.toBeNull();
  });

  it("S-A3: a disabled user is rejected", async () => {
    const user = { ...ACTIVE_USER, status: "disabled" };
    const auth = createSelfRequestAuthenticator(makeDeps({ user }));

    await expect(
      auth.authenticate(request(`Bearer ${await makeToken(makeConfig(), user)}`)),
    ).resolves.toBeNull();
  });

  it("S-A3: a token version mismatch (password changed) is rejected", async () => {
    const changed = { ...ACTIVE_USER, tokenVersion: ACTIVE_USER.tokenVersion + 1 };
    const auth = createSelfRequestAuthenticator(makeDeps({ user: changed }));

    await expect(
      auth.authenticate(request(`Bearer ${await makeToken()}`)),
    ).resolves.toBeNull();
  });

  it("S-A3: a revoked session is rejected", async () => {
    const auth = createSelfRequestAuthenticator(
      makeDeps({ sessionActive: false }),
    );

    await expect(
      auth.authenticate(request(`Bearer ${await makeToken()}`)),
    ).resolves.toBeNull();
  });

  it("S-A3: an unknown user is rejected", async () => {
    const auth = createSelfRequestAuthenticator(makeDeps({ user: null }));

    await expect(
      auth.authenticate(request(`Bearer ${await makeToken()}`)),
    ).resolves.toBeNull();
  });

  it("S-A3: nothing is cached - a session revoked between two calls is rejected", async () => {
    let active = true;
    const auth = createSelfRequestAuthenticator({
      token: makeConfig(),
      findUserById: async () => ACTIVE_USER,
      isSessionActive: async () => active,
      now: () => NOW,
    });
    const header = `Bearer ${await makeToken()}`;

    await expect(auth.authenticate(request(header))).resolves.toMatchObject({
      id: ACTIVE_USER.id,
    });

    active = false;

    await expect(auth.authenticate(request(header))).resolves.toBeNull();
  });
});
