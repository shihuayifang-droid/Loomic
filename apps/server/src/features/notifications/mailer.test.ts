import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createMailer,
  createMailerFromEnv,
  MAIL_API_TOKEN_ENV,
  MAIL_API_URL_ENV,
  MAIL_REQUEST_TIMEOUT_MS,
  type MailMessage,
} from "./mailer.js";

/**
 * BR-09 / workorder 45CE: the pluggable mailer.
 *
 * `fetch` is stubbed, never called for real: the point of these cases is that
 * an unconfigured server makes NO network call, and that a configured gateway
 * gets exactly the documented request and has its non-2xx answers thrown.
 */

const MESSAGE: MailMessage = {
  to: "someone@example.com",
  subject: "HaHart 邮箱验证",
  html: "<p>hi</p>",
  text: "hi",
};

type FetchCall = { url: string; init: RequestInit | undefined };

function stubFetch(respond: (call: FetchCall) => Response): FetchCall[] {
  const calls: FetchCall[] = [];

  const fake = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
    const call: FetchCall = { url: String(input), init };
    calls.push(call);

    return respond(call);
  });

  vi.stubGlobal("fetch", fake);

  return calls;
}

describe("BR-09 mailer: noop", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("BR-09: no configuration yields the noop mailer", () => {
    expect(createMailer({}).kind).toBe("noop");
    expect(createMailer({ url: "https://gateway.example.com/mail" }).kind).toBe("noop");
    expect(createMailer({ token: "t" }).kind).toBe("noop");
    expect(createMailer({ url: "  ", token: "  " }).kind).toBe("noop");
  });

  it("BR-09: noop send resolves without throwing and without touching the network", async () => {
    const calls = stubFetch(() => new Response("", { status: 200 }));
    const mailer = createMailer({});

    await expect(mailer.send(MESSAGE)).resolves.toBeUndefined();

    expect(calls).toHaveLength(0);
    expect(console.info).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.info).mock.calls[0]?.[0]).toBe(
      "mail(noop) to=someone@example.com subject=HaHart 邮箱验证",
    );
  });

  it("BR-09: the environment helper falls back to noop when either variable is missing", () => {
    expect(createMailerFromEnv({}).kind).toBe("noop");
    expect(createMailerFromEnv({ [MAIL_API_URL_ENV]: "https://gateway.example.com/mail" }).kind).toBe("noop");
    expect(createMailerFromEnv({ [MAIL_API_TOKEN_ENV]: "token" }).kind).toBe("noop");
  });
});

describe("BR-09 mailer: http", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("BR-09: both variables configured yields the http mailer", () => {
    expect(createMailer({ url: "https://gateway.example.com/mail", token: "secret" }).kind).toBe("http");
    expect(
      createMailerFromEnv({
        [MAIL_API_URL_ENV]: "https://gateway.example.com/mail",
        [MAIL_API_TOKEN_ENV]: "secret",
      }).kind,
    ).toBe("http");
  });

  it("BR-09: http send posts the documented JSON body with a bearer token", async () => {
    const calls = stubFetch(() => new Response("", { status: 200 }));
    const mailer = createMailer({ url: "https://gateway.example.com/mail", token: "secret" });

    await expect(mailer.send(MESSAGE)).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);

    const [call] = calls;

    expect(call?.url).toBe("https://gateway.example.com/mail");
    expect(call?.init?.method).toBe("POST");

    const headers = call?.init?.headers as Record<string, string>;

    expect(headers["content-type"]).toBe("application/json");
    expect(headers.authorization).toBe("Bearer secret");
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      to: MESSAGE.to,
      subject: MESSAGE.subject,
      html: MESSAGE.html,
      text: MESSAGE.text,
    });
    expect(call?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("BR-09: a non-2xx answer throws with the status in the message", async () => {
    stubFetch(() => new Response("nope", { status: 500 }));
    const mailer = createMailer({ url: "https://gateway.example.com/mail", token: "secret" });

    await expect(mailer.send(MESSAGE)).rejects.toThrow("mail provider responded 500");
  });

  it("BR-09: the request carries the documented ten-second ceiling", () => {
    expect(MAIL_REQUEST_TIMEOUT_MS).toBe(10_000);
  });

  it("BR-09: the gateway gets one call per message", async () => {
    const calls = stubFetch(() => new Response("", { status: 202 }));
    const mailer = createMailer({ url: "https://gateway.example.com/mail", token: "secret" });

    await mailer.send(MESSAGE);
    await mailer.send({ ...MESSAGE, to: "other@example.com" });

    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({ to: "other@example.com" });
  });
});
