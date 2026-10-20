/**
 * 工单34F · T1 —— 多选「下载全部」的打包计划（ED-05）。
 *
 * 这一层只做**纯计算**：给定「项目名 + 一个时间点 + 选中对象」，算出压缩包叫什么、
 * 里面每个对象叫什么都定下来，以及这次能不能打包。不读数据库、不碰存储、不写 zip。
 * 之后接路由时只管按计划取对象、写进 zip 流。
 *
 * 规格里能判定的规则全部钉在这里：
 *
 * 1. 只有 `status === "ready"` 的对象进包，`generating` / `failed` 一律跳过并计数。
 * 2. ready 超过 50 个 → 拒绝（`too_many`）。
 * 3. ready 的字节数合计（`byteSize` 为 null 按 0）超过 500MB → 拒绝（`too_large`）。
 * 4. ready 为 0 → 拒绝（`nothing_to_download`）。
 * 5. 包内重名按输入顺序加 ` (2)`、` (3)`…，加在扩展名之前。
 * 6. 压缩包名 `{项目名}_{YYYYMMDD-HHmm}.zip`，时间按 **Asia/Shanghai（UTC+8）** 格式化。
 *
 * 两条刻意写死的口径（都写在这里，别在别处再猜一次）：
 *
 * - **时区**：文件名一律按 Asia/Shanghai（UTC+8）取字段，不看运行机器的本地时区。
 *   T-51 / T-72 的「用户时区」尚未落地，现阶段按团队所在时区（见工单34F 规则 6）。
 * - **重名比较区分大小写**：`A.png` 与 `a.png` 视为两个不同文件名，不合并、不改名。
 *   大小写不敏感的文件系统（Windows / macOS 默认）上二者会互相覆盖 —— 这种情况本单
 *   不处理，属于后续打包实现要面对的问题，不在纯函数里假装解决。
 */

/** 一次打包最多多少个 ready 对象（超过即提示分批）。 */
export const ZIP_MAX_ITEMS = 50;

/** 一次打包 ready 对象字节数合计上限（500MB）。 */
export const ZIP_MAX_BYTES = 500 * 1024 * 1024;

/** 一个选中对象在下载时的完成状态；只有 `ready` 参与打包。 */
export type ZipDownloadItemStatus = "ready" | "generating" | "failed";

/** 调用方传进来的一个选中对象（够用即可，不绑定任何仓储形态）。 */
export interface ZipDownloadItem {
  /** 对象 id，原样带回 `entries`，供打包时取字节。 */
  id: string;
  /** 展示名（也是包内默认文件名，含扩展名）。 */
  name: string;
  /** 字节数；未知 / 未统计时为 null，按 0 计入合计。 */
  byteSize: number | null;
  /** 当前状态；只有 `ready` 会进包。 */
  status: ZipDownloadItemStatus;
}

/** `planZipDownload` 的入参。 */
export interface ZipDownloadInput {
  /** 项目名，用于压缩包名；不安全字符会被替换。 */
  projectName: string;
  /** 生成压缩包名用的时间点（调用方传 `new Date()` 即可，测试传固定值）。 */
  now: Date;
  /** 本次选中的对象，顺序即包内取名的优先顺序。 */
  items: readonly ZipDownloadItem[];
}

/** 包内一个条目：哪个对象、叫什么。 */
export interface ZipDownloadEntry {
  /** 源对象 id。 */
  id: string;
  /** 包内文件名（已处理重名）。 */
  entryName: string;
}

/** 拒绝的原因码。 */
export type ZipDownloadRejectionReason = "too_many" | "too_large" | "nothing_to_download";

/** 打包计划：要么能打包（带压缩包名与条目），要么拒绝（带原因码与给用户看的提示）。 */
export type ZipDownloadPlan =
  | {
      ok: true;
      /** 压缩包名 `{项目名}_{YYYYMMDD-HHmm}.zip`。 */
      fileName: string;
      /** 包内条目，顺序与输入中 ready 对象的顺序一致。 */
      entries: ZipDownloadEntry[];
      /** 被跳过的未完成对象个数。 */
      skipped: number;
      /** 跳过了就给用户看的提示，没跳过为 null。 */
      skippedMessage: string | null;
    }
  | {
      ok: false;
      reason: ZipDownloadRejectionReason;
      /** 直接可展示的中文提示。 */
      message: string;
    };

/** 对象名里替换成 `_` 的字符（Windows / POSIX 上都不合法的那些）。 */
const UNSAFE_FILE_NAME_CHARS = /[/\\:*?"<>|]/g;

/** 选中过多时给用户的提示（`too_many` 与 `too_large` 共用一句）。 */
const TOO_MANY_MESSAGE = "选中过多，请分批下载";

/** ready 为 0 时的提示。 */
const NOTHING_TO_DOWNLOAD_MESSAGE = "没有可下载的对象";

/** 项目名清洗后为空时的兜底名。 */
const FALLBACK_PROJECT_NAME = "project";

/** Asia/Shanghai 相对 UTC 的固定偏移（小时）。 */
const SHANGHAI_UTC_OFFSET_HOURS = 8;

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * 把 `name` 拆成「扩展名之前的部分」和「扩展名」。
 *
 * 只看**最后一个**点：`a.tar.gz` → `a.tar` + `.gz`。没有点、或点就在开头（`.env` 这种
 * 隐藏文件）都当作没有扩展名，整串进 `base`。
 */
function splitExtension(name: string): { base: string; extension: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) {
    return { base: name, extension: "" };
  }
  return { base: name.slice(0, dot), extension: name.slice(dot) };
}

/**
 * 按输入顺序给 ready 对象分配包内名：第一个保持原名，之后重名的在扩展名前加 ` (2)`、` (3)`…
 *
 * 跳过已经占用的候选名，所以 `a.png` + `a (2).png` + `a.png` 的第三个会拿到 `a (3).png`
 * 而不是撞上第二个。比较区分大小写（见文件头注释）。
 */
function assignEntryNames(ready: readonly ZipDownloadItem[]): ZipDownloadEntry[] {
  const used = new Set<string>();
  const entries: ZipDownloadEntry[] = [];

  for (const item of ready) {
    let entryName = item.name;
    if (used.has(entryName)) {
      const { base, extension } = splitExtension(item.name);
      let suffix = 2;
      while (used.has(`${base} (${suffix})${extension}`)) {
        suffix += 1;
      }
      entryName = `${base} (${suffix})${extension}`;
    }
    used.add(entryName);
    entries.push({ id: item.id, entryName });
  }

  return entries;
}

/**
 * 把时间点按 Asia/Shanghai（UTC+8）格式化成 `YYYYMMDD-HHmm`。
 *
 * 手动加 8 小时后再用 `getUTC*` 取字段，避免依赖运行机器本地时区；也避开 `Intl`
 * 的完整时区数据库（server 只保证有 `ES2022` 的 lib）。
 */
function formatShanghaiTimestamp(now: Date): string {
  const shifted = new Date(now.getTime() + SHANGHAI_UTC_OFFSET_HOURS * 60 * 60 * 1000);
  const year = shifted.getUTCFullYear();
  const month = pad2(shifted.getUTCMonth() + 1);
  const day = pad2(shifted.getUTCDate());
  const hours = pad2(shifted.getUTCHours());
  const minutes = pad2(shifted.getUTCMinutes());
  return `${year}${month}${day}-${hours}${minutes}`;
}

/**
 * 把项目名清洗成能放进文件名的形式：`/ \ : * ? " < > |` 替换成 `_`，去首尾空白，
 * 结果为空则用 `project`。
 */
function sanitizeProjectName(projectName: string): string {
  const cleaned = projectName.replace(UNSAFE_FILE_NAME_CHARS, "_").trim();
  return cleaned.length > 0 ? cleaned : FALLBACK_PROJECT_NAME;
}

/**
 * 算出多选「下载全部」的打包计划（ED-05）。
 *
 * 判定顺序与规格一致：先按状态筛出 ready 并计数 skipped，再判个数上限、合计字节上限，
 * 最后判「一个 ready 都没有」。
 *
 * @param input 项目名、生成文件名用的时间点、本次选中的对象（顺序即取名顺序）
 * @returns 能打包时的压缩包名 / 条目 / 跳过数，或拒绝时的原因码与提示
 */
export function planZipDownload(input: ZipDownloadInput): ZipDownloadPlan {
  const ready: ZipDownloadItem[] = [];
  for (const item of input.items) {
    if (item.status === "ready") {
      ready.push(item);
    }
  }
  const skipped = input.items.length - ready.length;

  if (ready.length > ZIP_MAX_ITEMS) {
    return { ok: false, reason: "too_many", message: TOO_MANY_MESSAGE };
  }

  let totalBytes = 0;
  for (const item of ready) {
    totalBytes += item.byteSize ?? 0;
  }
  if (totalBytes > ZIP_MAX_BYTES) {
    return { ok: false, reason: "too_large", message: TOO_MANY_MESSAGE };
  }

  if (ready.length === 0) {
    return {
      ok: false,
      reason: "nothing_to_download",
      message: NOTHING_TO_DOWNLOAD_MESSAGE,
    };
  }

  const fileName = `${sanitizeProjectName(input.projectName)}_${formatShanghaiTimestamp(input.now)}.zip`;

  return {
    ok: true,
    fileName,
    entries: assignEntryNames(ready),
    skipped,
    skippedMessage: skipped > 0 ? `已跳过 ${skipped} 个未完成对象` : null,
  };
}
