// Retrying the Supabase calls that never reached Postgres.
//
// WHY THIS EXISTS
// Every Supabase hostname here resolves into the local proxy's fake-ip range, so
// all database traffic is proxied. When that proxy switches or stalls a node the
// TLS handshake is reset mid-flight and supabase-js reports `fetch failed` with NO
// Postgres code. One such blip is enough to turn a fully successful piece of work
// into a visible failure:
//
//   - canvas save          -> the user's edit is silently discarded (fixed first,
//                             which is where this predicate was originally written)
//   - agent run bookkeeping -> the run is marked failed and the UI says "请求处理
//                             失败，请重试" while the generated image is already on
//                             the canvas
//   - chat message insert   -> the assistant's reply is lost for good; on reload the
//                             conversation shows the image with no text
//
// The predicate lived inside canvas-version.ts while the canvas was the only
// caller. It is here now because three other features need the same answer, and
// "chat imports from canvas" would be the wrong dependency.

/**
 * True when the request never reached Postgres, so replaying the statement is
 * safe.
 *
 * Deliberately narrow. Anything carrying a pg code (a statement timeout, an RLS
 * denial, a constraint violation) is a real answer from the database and will fail
 * again identically — retrying those just multiplies the wait.
 *
 * Note `!error.code` and not `error.code === undefined`: supabase-js was observed
 * setting `code` to an EMPTY STRING on transport failures. `_retry-predicate.mjs`
 * pins that case against error shapes copied out of the server log.
 */
export function isTransportFailure(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null | undefined;
  if (!e) return false;
  if (e.code) return false;
  return /fetch failed|ECONNRESET|ETIMEDOUT|EPIPE|socket disconnected|network/i.test(
    e.message ?? "",
  );
}

export interface TransportRetryOptions {
  /** Total attempts including the first. Default 3. */
  maxAttempts?: number;
  /** Backoff before attempt N is `attempt * backoffStepMs`. Default 400. */
  backoffStepMs?: number;
}

/**
 * Runs `fn`, replaying it while it fails with a transport failure.
 *
 * ⚠️ ONLY FOR OPERATIONS THAT ARE SAFE TO REPLAY.
 *
 * `isTransportFailure` says the request probably never reached Postgres — but
 * `fetch failed` also covers a response that was lost on the way BACK, in which
 * case the statement did execute. So "transport failure" does not by itself make a
 * replay safe; the OPERATION has to be idempotent:
 *
 *   safe    UPDATE ... WHERE id = ?   with a fixed patch (applying twice = once)
 *   safe    SELECT
 *   safe    INSERT with a caller-supplied primary key (a replay hits the PK and
 *           cannot create a second row)
 *   safe    Storage upload with upsert:true
 *   NOT     INSERT whose id the database generates  -> a lost response means the
 *           replay silently creates a duplicate row. chat_messages is exactly this
 *           case, which is why createMessage does not use this helper: it checks
 *           whether the row landed before deciding to insert again.
 *   NOT     a conditional write that is the caller's own snapshot (see
 *           replaceCanvasContent — replaying that IS the overwrite bug)
 *
 * If you cannot put the call in the "safe" list above, do not wrap it here.
 */
export async function withTransportRetry<T>(
  label: string,
  fn: () => Promise<T>,
  options: TransportRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const backoffStepMs = options.backoffStepMs ?? 400;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!isTransportFailure(error) || attempt >= maxAttempts) throw error;

      const backoffMs = attempt * backoffStepMs;
      // console.log, not console.error: stderr goes through PowerShell's error
      // record formatting in the tee'd dev log, which wraps and TRUNCATES the line.
      console.log(
        `[transport-retry] ${label} transport failure, retrying ` +
          `attempt=${attempt} in=${backoffMs}ms ` +
          `message=${(error as { message?: string })?.message}`,
      );
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
}

/**
 * supabase-js returns `{ data, error }` instead of throwing, so a caller that wants
 * `withTransportRetry` has to turn the error into a rejection first. This does that
 * without losing the driver's own error object (the `code` on it is what the
 * predicate reads).
 */
export function throwIfError<T>(result: { data: T; error: unknown }): T {
  if (result.error) throw result.error;
  return result.data;
}
