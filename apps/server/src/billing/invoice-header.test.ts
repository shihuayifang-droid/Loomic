import { describe, expect, it } from "vitest";

import {
  INVOICE_COMPANY_ENV,
  INVOICE_TAX_ID_ENV,
  PRODUCT_NAME,
  createInvoiceHeader,
  formatInvoiceHeader,
} from "./invoice-header.js";

/**
 * 工单45DV / BR-18 —— 发票抬头配置通道。
 *
 * 公司名由财务提供、本单执行时还没有，所以测试里只用明显的假名
 * （"某某"），不写入任何真实开票主体。
 */
describe("createInvoiceHeader / formatInvoiceHeader (BR-18)", () => {
  it("未配置公司名：company=null、ready=false、format 返回 null", () => {
    const header = createInvoiceHeader({});

    expect(header.productName).toBe(PRODUCT_NAME);
    expect(header.company).toBeNull();
    expect(header.taxId).toBeNull();
    expect(header.ready).toBe(false);
    expect(formatInvoiceHeader(header)).toBeNull();
  });

  it("只配公司名：ready=true、税号行不出现", () => {
    const header = createInvoiceHeader({ [INVOICE_COMPANY_ENV]: "某某开票主体" });

    expect(header.ready).toBe(true);
    expect(header.company).toBe("某某开票主体");
    expect(header.taxId).toBeNull();

    const text = formatInvoiceHeader(header);
    expect(text).not.toBeNull();
    expect(text).toContain(PRODUCT_NAME);
    expect(text).toContain("某某开票主体");
    expect(text).not.toContain("税号");
    expect(text?.split("\n")).toHaveLength(2);
  });

  it("公司名 + 税号：两行都在", () => {
    const header = createInvoiceHeader({
      [INVOICE_COMPANY_ENV]: "某某开票主体",
      [INVOICE_TAX_ID_ENV]: "91310000TEST0001XX",
    });

    expect(header.ready).toBe(true);
    expect(header.taxId).toBe("91310000TEST0001XX");

    const text = formatInvoiceHeader(header);
    expect(text).not.toBeNull();
    expect(text).toContain("某某开票主体");
    expect(text).toContain("91310000TEST0001XX");
    expect(text).not.toContain("null");
    expect(text?.split("\n")).toHaveLength(3);
  });

  it("公司名带前后空格：trim 后生效", () => {
    const header = createInvoiceHeader({ [INVOICE_COMPANY_ENV]: "  某某开票主体  " });

    expect(header.company).toBe("某某开票主体");
    expect(header.ready).toBe(true);
    expect(formatInvoiceHeader(header)).toContain("某某开票主体");
  });

  it("公司名为空串（或纯空白）：仍为 null、ready=false、format 返回 null", () => {
    for (const blank of ["", "   ", "\t\n"]) {
      const header = createInvoiceHeader({ [INVOICE_COMPANY_ENV]: blank });

      expect(header.company).toBeNull();
      expect(header.ready).toBe(false);
      expect(formatInvoiceHeader(header)).toBeNull();
    }
  });

  it("税号为空串不影响 ready，也不产生税号行", () => {
    const header = createInvoiceHeader({
      [INVOICE_COMPANY_ENV]: "某某开票主体",
      [INVOICE_TAX_ID_ENV]: "   ",
    });

    expect(header.ready).toBe(true);
    expect(header.taxId).toBeNull();
    expect(formatInvoiceHeader(header)?.split("\n")).toHaveLength(2);
  });
});
