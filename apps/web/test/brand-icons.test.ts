import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import manifest from "../src/app/manifest";

/**
 * BR-06 应用图标（工单 40V）
 *
 * 源码 / 二进制断言，不渲染组件：图标按文件头读宽高，避免依赖图片库。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, "..");

function readBuffer(relPath: string): Buffer {
  return fs.readFileSync(path.join(WEB_ROOT, relPath));
}

function read(relPath: string): string {
  return fs.readFileSync(path.join(WEB_ROOT, relPath), "utf8");
}

/** PNG IHDR：字节 16-19 宽、20-23 高，均大端。 */
function pngSize(relPath: string): { width: number; height: number } {
  const buf = readBuffer(relPath);

  expect(buf.subarray(1, 4).toString("ascii"), `${relPath} 不是 PNG`).toBe("PNG");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** ICO 头：字节 4-5 图像数，小端。 */
function icoImageCount(relPath: string): number {
  const buf = readBuffer(relPath);

  expect(buf.readUInt16LE(0), `${relPath} 保留位不是 0`).toBe(0);
  expect(buf.readUInt16LE(2), `${relPath} 类型不是图标`).toBe(1);
  return buf.readUInt16LE(4);
}

describe("BR-06 brand icons", () => {
  it("BR-06: every icon size the spec asks for ships", () => {
    const shipped = [
      "public/favicon.ico",
      "public/icon-192.png",
      "public/icon-512.png",
      "public/apple-touch-icon.png",
    ];

    for (const relPath of shipped) {
      expect(fs.existsSync(path.join(WEB_ROOT, relPath)), `${relPath} 缺失`).toBe(true);
    }

    expect(pngSize("public/icon-192.png"), "icon-192.png 尺寸不对").toEqual({ width: 192, height: 192 });
    expect(pngSize("public/icon-512.png"), "icon-512.png 尺寸不对").toEqual({ width: 512, height: 512 });
    expect(pngSize("public/apple-touch-icon.png"), "apple-touch-icon.png 尺寸不对").toEqual({
      width: 180,
      height: 180,
    });
    expect(icoImageCount("public/favicon.ico"), "favicon.ico 图像数不足 3").toBeGreaterThanOrEqual(3);
  });

  it("BR-06: the favicon is the new mark", () => {
    const source = read("public/favicon.svg");

    expect(source, "favicon.svg 不是荧光黄绿底").toContain("#E4F23A");
    expect(source, "favicon.svg 不是 H + 点 新图形").toContain("M18 16 h7 v13");
    expect(source, "favicon.svg 仍是旧花瓣图形").not.toContain("M50 4 C56 4");
  });

  it("BR-06: the app manifest lists the PWA icons", () => {
    const appManifest = manifest();
    const sizes = (appManifest.icons ?? []).map((icon) => icon.sizes);

    expect(appManifest.name, "manifest name 不是 HaHart").toBe("HaHart");
    expect(sizes, "manifest 缺 192 图标").toContain("192x192");
    expect(sizes, "manifest 缺 512 图标").toContain("512x512");

    // 每一项的 src 必须真的落在 public 下，且该 PNG 的宽高与 sizes 一致
    for (const icon of appManifest.icons ?? []) {
      const src = icon.src;
      expect(src, "manifest 图标缺 src").toBeTruthy();

      const relPath = path.posix.join("public", src.replace(/^\/+/, ""));

      expect(fs.existsSync(path.join(WEB_ROOT, relPath)), `${src} 指向的文件不存在`).toBe(true);

      const { width, height } = pngSize(relPath);

      expect(`${width}x${height}`, `${src} 的 PNG 宽高与清单 sizes 不一致`).toBe(icon.sizes);
    }
  });

  it("BR-06: the layout points the browser at the icon set", () => {
    const source = read("src/app/layout.tsx");

    expect(source, "layout.tsx 未指向 favicon.ico").toContain('"/favicon.ico"');
    expect(source, "layout.tsx 未指向 apple-touch-icon.png").toContain('"/apple-touch-icon.png"');
  });
});
