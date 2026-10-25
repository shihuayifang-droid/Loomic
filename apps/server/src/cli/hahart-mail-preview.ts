/**
 * BR-09 / workorder 45CE: write the three authentication emails to disk so they
 * can be opened in a browser before any provider credential exists.
 *
 * Usage (from `apps/server`):
 *   pnpm run mail:preview -- --out <dir>      # default: ./mail-preview
 *
 * NOTHING IS SENT
 * This never imports `mailer.ts` and never touches the network: it renders the
 * templates with sample values and writes `<slug>.html` / `<slug>.txt` pairs.
 * The real send path stays blocked on the provider decision (U-28), and a
 * preview command that could mail someone would be the one way to break that.
 *
 * EXIT CODES
 *   0 — six files were written and every subject was printed
 *   1 — the templates could not be rendered or the directory could not be
 *       written; the reason goes to stderr
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  loginCode,
  resetPassword,
  verifyEmail,
  type EmailContent,
} from "../features/notifications/email-templates.js";

export const DEFAULT_OUT_DIR = "mail-preview";

type PreviewTemplate = {
  /** File stem: `<slug>.html` / `<slug>.txt`. */
  readonly slug: string;
  readonly content: EmailContent;
};

/** Sample values that exercise every branch of each template. */
export const PREVIEW_TEMPLATES: readonly PreviewTemplate[] = [
  {
    slug: "verify-email",
    content: verifyEmail({
      displayName: "预览用户",
      link: "https://hahart.example.com/verify?token=preview-verify-token",
    }),
  },
  {
    slug: "login-code",
    content: loginCode({ displayName: "预览用户", code: "804213" }),
  },
  {
    slug: "reset-password",
    content: resetPassword({
      displayName: "预览用户",
      link: "https://hahart.example.com/reset-password?token=preview-reset-token",
    }),
  },
];

export type PreviewFile = {
  readonly slug: string;
  readonly subject: string;
  readonly htmlPath: string;
  readonly textPath: string;
  readonly htmlBytes: number;
  readonly textBytes: number;
};

export type PreviewResult = {
  readonly dir: string;
  readonly files: ReadonlyArray<PreviewFile>;
};

/**
 * Render and write every preview. Split out from the entry point so it can be
 * driven without argv or `process.exit`, and so the byte counts come from the
 * same strings that were written.
 */
export async function writeMailPreview(outDir: string): Promise<PreviewResult> {
  const dir = path.resolve(outDir);

  await fs.mkdir(dir, { recursive: true });

  const files: PreviewFile[] = [];

  for (const template of PREVIEW_TEMPLATES) {
    const htmlPath = path.join(dir, `${template.slug}.html`);
    const textPath = path.join(dir, `${template.slug}.txt`);

    await fs.writeFile(htmlPath, template.content.html, "utf8");
    await fs.writeFile(textPath, template.content.text, "utf8");

    files.push({
      slug: template.slug,
      subject: template.content.subject,
      htmlPath,
      textPath,
      htmlBytes: Buffer.byteLength(template.content.html, "utf8"),
      textBytes: Buffer.byteLength(template.content.text, "utf8"),
    });
  }

  return { dir, files: [...files] };
}

/** `--out <dir>` / `--out=<dir>`; anything else is ignored, missing value is an error. */
export function parseOutDir(argv: readonly string[]): string {
  let outDir = DEFAULT_OUT_DIR;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === undefined) {
      continue;
    }

    if (arg === "--out") {
      const value = argv[index + 1];

      if (value === undefined || value.startsWith("--")) {
        throw new Error("--out 需要一个目录参数");
      }

      outDir = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--out=")) {
      const value = arg.slice("--out=".length);

      if (value === "") {
        throw new Error("--out 需要一个目录参数");
      }

      outDir = value;
    }
  }

  return outDir;
}

async function main(argv: readonly string[]): Promise<number> {
  try {
    const outDir = parseOutDir(argv);
    const result = await writeMailPreview(outDir);

    console.info(`out: ${result.dir}`);

    for (const file of result.files) {
      console.info(
        `${file.slug}  subject=${file.subject}  html=${file.htmlBytes} bytes  text=${file.textBytes} bytes`,
      );
    }

    console.info(`${result.files.length} templates, ${result.files.length * 2} files`);

    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));

    return 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
