import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createCanonicalDb, createCanonicalUser } from "../test-support/db/canonical-db.js";
import { createPGliteTransactionPool } from "../test-support/db/pglite-db.js";
import {
  createObjectReferenceRepository,
  type ObjectReferenceRepository,
} from "./object-reference-repository.js";

vi.setConfig({ testTimeout: 60_000 });

const USER_ID = "00000000-0000-0000-0000-0000000045a1";
const PROJECT_ID = "aaaa0000-0000-4000-8000-0000000045a1";

describe("object reference repository (canonical schema)", () => {
  let db: PGlite;
  let repository: ObjectReferenceRepository;

  beforeAll(async () => {
    ({ db } = await createCanonicalDb());
    await createCanonicalUser(db, USER_ID, "u-45l@hahart.test");
    const ws = await db.query<{ id: string }>(
      "select id from public.workspaces where owner_user_id = $1 and type = 'personal'",
      [USER_ID],
    );
    const workspaceId = ws.rows[0]?.id;
    if (workspaceId === undefined) throw new Error("no personal workspace");

    await db.query(
      `insert into public.projects (id, workspace_id, name, slug, description, created_by, thumbnail_path)
       values ($1, $2, 'Project 45L', 'project-45l', 'a project', $3, 'thumbs/p.png')`,
      [PROJECT_ID, workspaceId, USER_ID],
    );
    await db.query(
      `insert into public.asset_objects (workspace_id, project_id, bucket, object_path, created_by)
       values ($1, $2, 'project-assets', 'assets/a.png', $3)`,
      [workspaceId, PROJECT_ID, USER_ID],
    );
    const kit = await db.query<{ id: string }>(
      "insert into public.brand_kits (user_id) values ($1) returning id",
      [USER_ID],
    );
    const kitId = kit.rows[0]?.id;
    if (kitId === undefined) throw new Error("no brand kit");
    await db.query(
      `insert into public.brand_kit_assets (kit_id, asset_type, file_url)
       values ($1, 'logo', 'kit/logo.png')`,
      [kitId],
    );

    const pool = createPGliteTransactionPool(db);
    repository = createObjectReferenceRepository({ getTransactionPool: () => pool });
  }, 120_000);

  afterAll(async () => {
    await db.close();
  });

  it("returns the asset, thumbnail and brand-kit objects but not the unreferenced one", async () => {
    const found = await repository.findReferenced([
      { bucket: "project-assets", key: "assets/a.png" },
      { bucket: "project-assets", key: "thumbs/p.png" },
      { bucket: "brand-kit-assets", key: "kit/logo.png" },
      { bucket: "project-assets", key: "assets/orphan.png" },
    ]);
    expect([...found].sort()).toEqual([
      "brand-kit-assets/kit/logo.png",
      "project-assets/assets/a.png",
      "project-assets/thumbs/p.png",
    ]);
  });

  it("does not let a thumbnail path match in another bucket", async () => {
    const found = await repository.findReferenced([
      { bucket: "canvases", key: "thumbs/p.png" },
    ]);
    expect(found.size).toBe(0);
  });

  it("returns an empty set for an empty input", async () => {
    expect((await repository.findReferenced([])).size).toBe(0);
  });
});
