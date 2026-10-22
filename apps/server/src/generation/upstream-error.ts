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
