import type { BaseMessage, MessageContentComplex } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";

/**
 * Normalize legacy `image_url` content parts into OpenAI's wire format.
 *
 * OpenAI Chat Completions requires `image_url` to be an object:
 * `{ type: "image_url", image_url: { url } }`. LangChain historically also
 * accepted a bare string, and two producers in this codebase emitted that form:
 *
 * 1. `runtime.ts` built user attachment blocks as `image_url: "<data-url>"`
 *    (fixed at the source, but old threads are already checkpointed).
 * 2. `@langchain/google-common` converts Gemini `inlineData` output back into
 *    `image_url: "<data-url>"` (gemini.ts), so any Gemini turn that returned an
 *    inline image writes the string form into history.
 *
 * `@langchain/openai` passes content parts it does not recognize through
 * verbatim (`converters/completions.ts`: `return m`), so the string reaches the
 * gateway unchanged and is rejected with:
 *
 *     invalid type: string "data:image/webp;base64,…",
 *     expected struct OpenAICompletionImageUrl
 *
 * Gemini's adapter accepts both forms, which is why this went unnoticed until a
 * thread with image history was sent to an OpenAI-compatible endpoint.
 *
 * Returns the original array when nothing needs changing, so the common
 * text-only path allocates nothing. Messages that do change are cloned rather
 * than mutated — they are live objects in the checkpointed graph state.
 */
export function normalizeImageUrlBlocks(messages: BaseMessage[]): BaseMessage[] {
  let changedAny = false;

  const normalized = messages.map((message) => {
    if (typeof message.content === "string") return message;

    let changed = false;
    const content = message.content.map((part) => {
      if (
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "image_url" &&
        typeof (part as { image_url?: unknown }).image_url === "string"
      ) {
        changed = true;
        return {
          ...part,
          image_url: { url: (part as unknown as { image_url: string }).image_url },
        } as MessageContentComplex;
      }
      return part;
    });

    if (!changed) return message;
    changedAny = true;

    // Spreading the message carries every own field forward — id, name,
    // additional_kwargs, response_metadata, tool_calls, tool_call_id — so the
    // clone stays interchangeable with the original for the reducer and for
    // provider conversion. Reconstructing field-by-field would silently drop
    // whatever this message subclass happens to carry.
    const Ctor = message.constructor as new (fields: Record<string, unknown>) => BaseMessage;
    return new Ctor({ ...message, content });
  });

  return changedAny ? normalized : messages;
}

/**
 * `ChatOpenAI` with legacy `image_url` string parts normalized on the way out.
 *
 * Fixing the producer only helps new messages; threads already checkpointed
 * with the string form would fail on every subsequent turn forever. Both
 * entry points are overridden because the agent streams (`_streamResponseChunks`)
 * while some code paths and tests invoke (`_generate`).
 */
export class ChatOpenAIImageUrlCompat extends ChatOpenAI {
  /**
   * Keep the subclass alive across `bindTools()` / `withStructuredOutput()`.
   *
   * This override is what makes the whole class work. `BaseChatOpenAI.bindTools`
   * is implemented as `this.withConfig({ tools })`, and `ChatOpenAI.withConfig`
   * hardcodes `new ChatOpenAI(this.fields)` instead of `new this.constructor(...)`
   * (`@langchain/openai@1.3.0` chat_models/index.js). The agent binds tools before
   * every model call, so without this the bound model is a plain `ChatOpenAI` and
   * the overrides below are never reached — the symptom is a normalization layer
   * that passes its unit tests yet changes nothing on the live request.
   */
  override withConfig(config: Parameters<ChatOpenAI["withConfig"]>[0]) {
    const clone = new ChatOpenAIImageUrlCompat(this.fields);
    clone.defaultOptions = { ...this.defaultOptions, ...config };
    return clone;
  }

  override _generate(...args: Parameters<ChatOpenAI["_generate"]>) {
    const [messages, ...rest] = args;
    return super._generate(normalizeImageUrlBlocks(messages), ...rest);
  }

  override async *_streamResponseChunks(
    ...args: Parameters<ChatOpenAI["_streamResponseChunks"]>
  ) {
    const [messages, ...rest] = args;
    yield* super._streamResponseChunks(normalizeImageUrlBlocks(messages), ...rest);
  }
}
