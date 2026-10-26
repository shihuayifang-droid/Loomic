/** BR-19: the ONE place the product name and tagline are spelled. */
export const BRAND = {
  name: "HaHart",
  tagline: "AI 创意画布",
  /** `${name} · ${tagline}` — the description used by metadata and manifest. */
  description: "HaHart · AI 创意画布",
} as const;

/**
 * BR-19 术语表：界面上出现的产品术语，每项只能从这里取。
 *
 * key 是代码里的说法（英文小驼峰），值是界面上逐字使用的写法 —— 值一律照抄
 * 现有界面文案，不在这里改写措辞（改写是后续单的事）。成文说明见
 * `docs/brand/glossary.md`。
 */
export const GLOSSARY = {
  canvas: "画布",
  workspace: "工作区",
  project: "项目",
  credits: "积分",
  agent: "Agent",
  asset: "素材",
  file: "附件",
  model: "模型",
  skill: "技能",
  conversation: "对话",
  brandKit: "品牌套件",
  subscription: "订阅",
  generation: "生成",
} as const;

/** 术语 key 的联合类型。 */
export type GlossaryKey = keyof typeof GLOSSARY;

/** 按 key 取界面写法；key 写错在编译期就会被挡下来。 */
export function glossary(key: GlossaryKey): (typeof GLOSSARY)[GlossaryKey] {
  return GLOSSARY[key];
}
