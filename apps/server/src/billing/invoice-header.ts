// BR-18 / 工单45DV —— 发票抬头配置通道。
//
// BR-18（账单与发票抬头）要求发票上有三项事实：
//   * 产品名，固定为 "HaHart"；
//   * 开票主体（公司名）—— 由财务提供，因此放在配置里；本单执行时这个名字
//     还没拿到，所以这里**绝不硬编码公司名**；
//   * 税号，可选。
//
// 公司名没配置时抬头不是"就绪"状态，`formatInvoiceHeader` 故意返回 `null`：
// 返回"未配置"这类占位文案会被当成真名开出去。调用方拿到 `null` 应该提示
// 抬头信息不完整，而不是把占位文案渲染到发票上。
//
// 以后拿到公司名不需要改代码，只配环境变量：
//   HAHART_INVOICE_COMPANY=<开票主体>
//   HAHART_INVOICE_TAX_ID=<税号>   （可选）

/**
 * 发票上的产品名（需求 BR-18）。
 *
 * `apps/server` 目前没有导出一个共享的品牌 / 产品名常量（本包里出现的
 * "HaHart" 字面量只是 CLI 的团队名和 auth 的 issuer / audience 取值），
 * 所以产品名放在这里，并注明锁定它的是需求 BR-18。以后引入品牌常量时把它
 * 指过去即可。
 */
export const PRODUCT_NAME = "HaHart";

/** 开票主体（公司名）所在的环境变量。 */
export const INVOICE_COMPANY_ENV = "HAHART_INVOICE_COMPANY";

/** 税号所在的环境变量（可选）。 */
export const INVOICE_TAX_ID_ENV = "HAHART_INVOICE_TAX_ID";

/** 只读环境变量的形状，便于测试直接传一个对象。 */
export type InvoiceEnvSource = Record<string, string | undefined>;

/** 发票抬头。`company` / `taxId` 未配置时为 `null`。 */
export interface InvoiceHeader {
  productName: string;
  company: string | null;
  taxId: string | null;
  /** 公司名存在即为 true；税号不影响该标志。 */
  ready: boolean;
}

function readTrimmed(source: InvoiceEnvSource, key: string): string | null {
  const raw = source[key];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/** 从（默认 `process.env`）读出发票抬头；不抛错，缺什么就是 `null`。 */
export function createInvoiceHeader(source: InvoiceEnvSource = process.env): InvoiceHeader {
  const company = readTrimmed(source, INVOICE_COMPANY_ENV);
  const taxId = readTrimmed(source, INVOICE_TAX_ID_ENV);
  return {
    productName: PRODUCT_NAME,
    company,
    taxId,
    ready: company !== null,
  };
}

/**
 * 抬头未就绪（没有公司名）时返回 `null`，绝不返回占位文案；
 * 就绪时返回多行文本：产品名、开票主体，有税号时再加一行。
 */
export function formatInvoiceHeader(header: InvoiceHeader): string | null {
  if (!header.ready || header.company === null) return null;

  const lines = [`产品：${header.productName}`, `开票主体：${header.company}`];
  if (header.taxId !== null) lines.push(`税号：${header.taxId}`);
  return lines.join("\n");
}
