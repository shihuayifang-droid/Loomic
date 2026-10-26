/**
 * MD-03 / workorder 40B: upstream refusals about the NUMBER of reference images.
 *
 * Six image models declare `maxInputImages: "unbounded"` — the cap is unverified,
 * not absent. The requirement is explicit that the client must not intercept on
 * those models and that, when the upstream really does refuse the request, the
 * user must be told 「该模型参考图数量超限」 instead of the generic
 * 「生成失败，请重试。」. Without the translation below the refusal arrives as a
 * plain `api_error`, which reads like our service broke and invites a retry that
 * can only be refused the same way.
 *
 * The judgement is TEXT ONLY: providers wrap their HTTP failures with the
 * upstream message, so the message is the one piece of evidence available, and
 * no request of any kind is made here.
 */
export const REFERENCE_IMAGE_LIMIT_CODE = "reference_image_limit";

/**
 * The phrasings the providers in use have been seen to answer with.
 *
 * Matched against the lower-cased message, so casing never matters. Kept as a
 * list rather than one alternation so a new upstream phrasal form is one more
 * line, and so each entry can be a plain substring where that is enough.
 */
const REFERENCE_IMAGE_LIMIT_MARKERS: readonly RegExp[] = [
  /too many images/,
  /too many input images/,
  /maximum number of images/,
  /max images/,
  /exceeds the maximum number of/,
  // "You can provide at most 3 images" — the count is the upstream's, not ours.
  /at most \d+ images/,
  /image count/,
];

/** 上游报错是否是「参考图太多」。只看错误文本，大小写不敏感。 */
export function isReferenceImageLimitError(error: unknown): boolean {
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();

  return REFERENCE_IMAGE_LIMIT_MARKERS.some((marker) => marker.test(text));
}

/* ── QA-11 故障注入：基础设施故障的分类与稳定错误码 ─────────────────────
 *
 * Below is the one place that answers "what KIND of infrastructure failure is
 * this, and what does the client get told". Before it, every one of these
 * arrived at the client as the single generic `generation_failed` / 502, so a
 * rate-limited retry and a dead database were indistinguishable — the client
 * could not tell a "wait 5 seconds" from a "nothing works right now".
 *
 * Two rules the callers rely on:
 *
 * - The classification takes an explicit `context`, because the same socket
 *   error means different things: `ECONNREFUSED` while talking to PostgreSQL is
 *   our own database being down (503), not an upstream provider refusing.
 * - The sentence handed to the client is FIXED per fault. No upstream or driver
 *   text passes through here (X-40 §3), and the code is machine-readable.
 */

/** 数据库不可达时给前端的稳定错误码。 */
export const DATABASE_UNAVAILABLE_CODE = "database_unavailable";
/** 上游 429 时给前端的稳定错误码。 */
export const UPSTREAM_RATE_LIMITED_CODE = "upstream_rate_limited";
/** 连接被重置时给前端的稳定错误码（与 429 可区分）。 */
export const UPSTREAM_CONNECTION_RESET_CODE = "upstream_connection_reset";

/** 这句话是哪一侧的基础设施故障。`database` = 自己的库，`upstream` = 外部服务。 */
export type FaultContext = "database" | "upstream";

export type InfrastructureFault =
  | "database_unavailable"
  | "upstream_rate_limited"
  | "upstream_connection_reset"
  | "unknown";

/** Node socket codes that mean "the connection went away on us". */
const RESET_CODES: readonly string[] = [
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "UND_ERR_SOCKET",
  "ERR_STREAM_PREMATURE_CLOSE",
];

/** Socket codes / SQLSTATE that mean "we could not reach our own database". */
const DATABASE_DOWN_CODES: readonly string[] = [
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "ENOTFOUND",
  // postgres: cannot_connect_now — the server is starting up or shutting down.
  "57P03",
];

function asRecord(error: unknown): Record<string, unknown> | null {
  return typeof error === "object" && error !== null
    ? (error as Record<string, unknown>)
    : null;
}

function errorCode(error: unknown): string {
  const code = asRecord(error)?.["code"];
  return typeof code === "string" ? code.toUpperCase() : "";
}

function errorName(error: unknown): string {
  const name = asRecord(error)?.["name"];
  return typeof name === "string" ? name : "";
}

function errorText(error: unknown): string {
  const message = asRecord(error)?.["message"];
  if (typeof message === "string") return message.toLowerCase();
  return typeof error === "string" ? error.toLowerCase() : "";
}

/**
 * The HTTP status an error carries, if any. Providers wrap their failures in
 * several shapes (`{status}`, `{statusCode}`, `{response:{status}}`), so all
 * three are read here instead of every provider inventing its own accessor.
 */
export function upstreamHttpStatus(error: unknown): number | undefined {
  const record = asRecord(error);
  if (!record) return undefined;

  const candidates = [record["status"], record["statusCode"], asRecord(record["response"])?.["status"]];

  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }

  // Some wrapped messages still carry the status as text: "429 Too Many Requests".
  const match = /\b(429|503|502)\b/.exec(errorText(error));
  if (match?.[1]) return Number(match[1]);

  return undefined;
}

/**
 * `Retry-After` in seconds, from wherever the provider put it: a plain number, a
 * `headers.get("retry-after")` (WHATWG `Response`), or a plain header bag.
 * Answers `undefined` when the header is absent or not a number of seconds.
 */
export function upstreamRetryAfterSeconds(error: unknown): number | undefined {
  const record = asRecord(error);
  if (!record) return undefined;

  const direct = record["retryAfterSeconds"];
  if (typeof direct === "number" && Number.isFinite(direct) && direct >= 0) return direct;

  const headers = record["headers"];
  const raw = readRetryAfterHeader(headers);
  if (raw === undefined) return undefined;

  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function readRetryAfterHeader(headers: unknown): string | undefined {
  if (typeof headers === "object" && headers !== null) {
    const get = (headers as Record<string, unknown>)["get"];
    if (typeof get === "function") {
      const value: unknown = (get as (name: string) => unknown).call(headers, "retry-after");
      if (typeof value === "string") return value;
      return undefined;
    }

    const plain = asRecord(headers)?.["retry-after"] ?? asRecord(headers)?.["Retry-After"];
    if (typeof plain === "string") return plain;
    if (typeof plain === "number") return String(plain);
  }

  return undefined;
}

/** 这是哪一类基础设施故障。只看错误的 code / 状态码 / 文本，不发任何请求。 */
export function classifyInfrastructureFault(
  error: unknown,
  context: FaultContext,
): InfrastructureFault {
  const code = errorCode(error);
  const text = errorText(error);
  const status = upstreamHttpStatus(error);

  if (context === "database") {
    if (DATABASE_DOWN_CODES.includes(code)) return "database_unavailable";
    if (/econnrefused|enotfound|ehostunreach|enetunreach|cannot connect now|terminating connection/.test(text)) {
      return "database_unavailable";
    }
    return "unknown";
  }

  // 429 first: a rate-limited answer is an ANSWER from a reachable upstream, and
  // it must stay distinguishable from the connection being torn down under us.
  if (status === 429) return "upstream_rate_limited";
  if (errorName(error) === "AbortError") return "upstream_connection_reset";
  if (RESET_CODES.includes(code)) return "upstream_connection_reset";
  if (/econnreset|econnaborted|socket hang up|connection reset|aborted/.test(text)) {
    return "upstream_connection_reset";
  }

  return "unknown";
}

/** 一类故障对应的固定句子；用错句子就等于把故障种类暴露错了。 */
function faultMessage(fault: InfrastructureFault): string {
  switch (fault) {
    case "database_unavailable":
      return "数据服务暂时不可用，请稍后重试。";
    case "upstream_rate_limited":
      return "AI 服务请求过于频繁，请稍后重试。";
    case "upstream_connection_reset":
      return "与 AI 服务的连接中断，请重试。";
    default:
      return "AI 服务暂时不可用，请稍后重试。";
  }
}

/** 状态码：三类故障彼此可区分，且都不是 200。 */
function faultStatus(fault: InfrastructureFault): number {
  switch (fault) {
    case "database_unavailable":
      return 503;
    case "upstream_rate_limited":
      return 429;
    case "upstream_connection_reset":
      return 502;
    default:
      return 502;
  }
}

function faultCode(fault: InfrastructureFault): string {
  switch (fault) {
    case "database_unavailable":
      return DATABASE_UNAVAILABLE_CODE;
    case "upstream_rate_limited":
      return UPSTREAM_RATE_LIMITED_CODE;
    case "upstream_connection_reset":
      return UPSTREAM_CONNECTION_RESET_CODE;
    default:
      return "generation_failed";
  }
}

export interface InfrastructureFaultResponse {
  /** HTTP 状态码。 */
  statusCode: number;
  /** 机器可读的错误码。 */
  code: string;
  /** 固定句子，绝不带上游原文。 */
  message: string;
  /** 客户端重发同一个请求是否有机会成功。 */
  retryable: boolean;
  /** 上游 `Retry-After` 换算出的建议等待秒数（没有就是 `undefined`）。 */
  retryAfterSeconds?: number;
}

/**
 * 一类基础设施故障的完整对外答复：状态码 + 稳定错误码 + 固定句子 +
 * 是否可重试 + 建议等待秒数。纯函数，路由和 worker 共用同一个判定。
 */
export function infrastructureFaultResponse(
  error: unknown,
  context: FaultContext,
): InfrastructureFaultResponse {
  const fault = classifyInfrastructureFault(error, context);
  const retryAfterSeconds = upstreamRetryAfterSeconds(error);

  const response: InfrastructureFaultResponse = {
    statusCode: faultStatus(fault),
    code: faultCode(fault),
    message: faultMessage(fault),
    retryable: fault === "upstream_rate_limited" || fault === "upstream_connection_reset",
  };

  if (retryAfterSeconds !== undefined) response.retryAfterSeconds = retryAfterSeconds;

  return response;
}
