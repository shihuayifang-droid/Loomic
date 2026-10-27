import { describe, expect, it } from "vitest";

import {
  INVOICE_ACCOUNT_ENV,
  INVOICE_ADDRESS_ENV,
  INVOICE_BANK_ENV,
  INVOICE_COMPANY_ENV,
  INVOICE_PHONE_ENV,
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

  it("四项专票信息齐全：complete=true、format 含四项与可开专票行", () => {
    const header = createInvoiceHeader({
      [INVOICE_COMPANY_ENV]: "某某开票主体",
      [INVOICE_ADDRESS_ENV]: "示例地址B",
      [INVOICE_PHONE_ENV]: "000-0000-0000",
      [INVOICE_BANK_ENV]: "示例银行C",
      [INVOICE_ACCOUNT_ENV]: "6222 0000 0000 0000",
    });

    expect(header.ready).toBe(true);
    expect(header.complete).toBe(true);
    expect(header.address).toBe("示例地址B");
    expect(header.phone).toBe("000-0000-0000");
    expect(header.bank).toBe("示例银行C");
    expect(header.account).toBe("6222 0000 0000 0000");

    const text = formatInvoiceHeader(header);
    expect(text).not.toBeNull();
    expect(text).toContain("某某开票主体");
    expect(text).toContain("示例地址B");
    expect(text).toContain("000-0000-0000");
    expect(text).toContain("示例银行C");
    expect(text).toContain("6222 0000 0000 0000");
    expect(text).toContain("可开具专用发票");
    // 产品 / 开票主体 / 地址 / 电话 / 开户行 / 银行账号 / 可开专票
    expect(text?.split("\n")).toHaveLength(7);
  });

  it("只缺银行账号：complete=false、跳过账号行且不写占位", () => {
    const header = createInvoiceHeader({
      [INVOICE_COMPANY_ENV]: "某某开票主体",
      [INVOICE_ADDRESS_ENV]: "示例地址B",
      [INVOICE_PHONE_ENV]: "000-0000-0000",
      [INVOICE_BANK_ENV]: "示例银行C",
    });

    expect(header.ready).toBe(true);
    expect(header.account).toBeNull();
    expect(header.complete).toBe(false);

    const text = formatInvoiceHeader(header);
    expect(text).not.toBeNull();
    expect(text).toContain("示例地址B");
    expect(text).toContain("000-0000-0000");
    expect(text).toContain("示例银行C");
    expect(text).not.toContain("银行账号");
    expect(text).not.toContain("可开具专用发票");
    expect(text).not.toContain("无");
    expect(text).not.toContain("N/A");
    expect(text).not.toContain("未配置");
    expect(text).not.toContain("null");
    // 产品 / 开票主体 / 地址 / 电话 / 开户行
    expect(text?.split("\n")).toHaveLength(5);

    for (const line of text === null ? [] : text.split("\n")) {
      expect(line.trimEnd().endsWith("：")).toBe(false);
    }
  });

  it("四项为空串（或纯空白）：按未配置处理、complete=false、不产生对应行", () => {
    for (const blank of ["", "   ", "\t\n"]) {
      const header = createInvoiceHeader({
        [INVOICE_COMPANY_ENV]: "某某开票主体",
        [INVOICE_ADDRESS_ENV]: blank,
        [INVOICE_PHONE_ENV]: blank,
        [INVOICE_BANK_ENV]: blank,
        [INVOICE_ACCOUNT_ENV]: blank,
      });

      expect(header.ready).toBe(true);
      expect(header.address).toBeNull();
      expect(header.phone).toBeNull();
      expect(header.bank).toBeNull();
      expect(header.account).toBeNull();
      expect(header.complete).toBe(false);

      const text = formatInvoiceHeader(header);
      expect(text).not.toBeNull();
      expect(text).not.toContain("地址");
      expect(text).not.toContain("电话");
      expect(text).not.toContain("开户行");
      expect(text).not.toContain("银行账号");
      expect(text).not.toContain("可开具专用发票");
      expect(text?.split("\n")).toHaveLength(2);
    }
  });
});
