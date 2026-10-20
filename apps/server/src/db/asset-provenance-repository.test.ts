import { describe, expect, it, vi } from "vitest";

import {
  AssetProvenanceError,
  createAssetProvenanceRepository,
  isValidAssetSource,
  type AssetProvenance,
} from "./asset-provenance-repository.js";
import type { TransactionPool } from "./transaction.js";

const ASSET_ID = "dddd0000-0000-4000-8000-000000000001";

const PROVENANCE: AssetProvenance = {
  source: "generator",
  operation: "image_generation",
  modelId: "black-forest-labs/flux-kontext-pro",
  prompt: "a red panda",
  creditsCharged: 0,
  actionId: "act-1",
  sourceJobId: "eeee0000-0000-4000-8000-000000000001",
  parentArtifactId: "dddd0000-0000-4000-8000-000000000002",
};

type Call = { sql: string; params: readonly unknown[] | undefined };

function createFakePool(options: {
  businessRows?: unknown[];
  businessError?: Error;
}) {
  const calls: Call[] = [];
  const connect = vi.fn(async () => ({
    query: async (sql: string, params?: readonly unknown[]) => {
      calls.push({ sql, params });
      const isBusiness =
        sql.includes("update public.asset_objects") ||
        sql.includes("from public.asset_objects");

      if (isBusiness) {
        if (options.businessError) throw options.businessError;
        return { rows: options.businessRows ?? [] };
      }

      return { rows: [] };
    },
    release: () => undefined,
  }));
  const pool: TransactionPool = { connect };

  return { pool, connect, calls };
}

function repositoryFor(pool: TransactionPool) {
  return createAssetProvenanceRepository({ getTransactionPool: () => pool });
}

describe("asset provenance repository (fake pool)", () => {
  it("case 1: isValidAssetSource accepts the fixed values and tool:* ids only", () => {
    for (const ok of [
      "agent",
      "generator",
      "user_upload",
      "sketch",
      "agent:sandbox",
      "tool:edit_texts",
    ]) {
      expect(isValidAssetSource(ok)).toBe(true);
    }

    for (const bad of ["tool:", "tool:Bad-Id", "upload", ""]) {
      expect(isValidAssetSource(bad)).toBe(false);
    }
  });

  it("case 2: an invalid source throws before any connection is opened", async () => {
    const { pool, connect } = createFakePool({});

    await expect(
      repositoryFor(pool).recordProvenance({
        actorId: null,
        assetId: ASSET_ID,
        provenance: { ...PROVENANCE, source: "upload" },
      }),
    ).rejects.toBeInstanceOf(AssetProvenanceError);
    expect(connect).not.toHaveBeenCalled();
  });

  it("case 3: a negative creditsCharged throws before any connection is opened", async () => {
    const { pool, connect } = createFakePool({});

    await expect(
      repositoryFor(pool).recordProvenance({
        actorId: null,
        assetId: ASSET_ID,
        provenance: { ...PROVENANCE, creditsCharged: -1 },
      }),
    ).rejects.toBeInstanceOf(AssetProvenanceError);
    expect(connect).not.toHaveBeenCalled();
  });

  it("case 4: a valid write binds the nine parameters in order and answers updated=1", async () => {
    const { pool, calls } = createFakePool({ businessRows: [{ id: ASSET_ID }] });

    const result = await repositoryFor(pool).recordProvenance({
      actorId: "00000000-0000-0000-0000-0000000000a1",
      assetId: ASSET_ID,
      provenance: PROVENANCE,
    });

    expect(result).toEqual({ updated: 1 });

    const business = calls.find((call) =>
      call.sql.includes("update public.asset_objects"),
    );

    expect(business?.params).toEqual([
      ASSET_ID,
      PROVENANCE.source,
      PROVENANCE.operation,
      PROVENANCE.modelId,
      PROVENANCE.prompt,
      PROVENANCE.creditsCharged,
      PROVENANCE.actionId,
      PROVENANCE.sourceJobId,
      PROVENANCE.parentArtifactId,
    ]);
  });

  it("case 5: a driver error is wrapped with a fixed message that leaks nothing", async () => {
    const { pool } = createFakePool({
      businessError: new Error("connection to 10.0.0.1 refused: password=xyz"),
    });

    const failure = await repositoryFor(pool)
      .recordProvenance({
        actorId: null,
        assetId: ASSET_ID,
        provenance: PROVENANCE,
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(AssetProvenanceError);
    expect((failure as AssetProvenanceError).message).toBe(
      "asset provenance failed (recordProvenance)",
    );
    expect((failure as AssetProvenanceError).message).not.toContain("10.0.0.1");
    expect((failure as AssetProvenanceError).message).not.toContain("password");
  });

  it("case 6: readProvenance answers null when the row does not exist", async () => {
    const { pool } = createFakePool({ businessRows: [] });

    await expect(
      repositoryFor(pool).readProvenance({ assetId: ASSET_ID }),
    ).resolves.toBeNull();
  });

  it("case 7: a blank or over-long display name throws before any connection is opened", async () => {
    for (const displayName of ["   ", "角".repeat(256)]) {
      const { pool, connect } = createFakePool({});

      await expect(
        repositoryFor(pool).recordDisplayName({
          actorId: null,
          assetId: ASSET_ID,
          displayName,
        }),
      ).rejects.toBeInstanceOf(AssetProvenanceError);
      expect(connect).not.toHaveBeenCalled();
    }
  });

  it("case 8: a valid write binds the trimmed display name and answers updated=1", async () => {
    const { pool, calls } = createFakePool({
      businessRows: [{ id: ASSET_ID }],
    });

    const result = await repositoryFor(pool).recordDisplayName({
      actorId: "00000000-0000-0000-0000-0000000000a1",
      assetId: ASSET_ID,
      displayName: "  角色-小橘.png  ",
    });

    expect(result).toEqual({ updated: 1 });

    const business = calls.find((call) =>
      call.sql.includes("update public.asset_objects"),
    );

    expect(business?.params).toEqual([ASSET_ID, "角色-小橘.png"]);
  });

  it("case 9: a driver error on recordDisplayName is wrapped with a fixed message", async () => {
    const { pool } = createFakePool({
      businessError: new Error("connection to 10.0.0.1 refused: password=xyz"),
    });

    const failure = await repositoryFor(pool)
      .recordDisplayName({
        actorId: null,
        assetId: ASSET_ID,
        displayName: "角色-小橘.png",
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(AssetProvenanceError);
    expect((failure as AssetProvenanceError).message).toBe(
      "asset provenance failed (recordDisplayName)",
    );
    expect((failure as AssetProvenanceError).message).not.toContain("10.0.0.1");
    expect((failure as AssetProvenanceError).message).not.toContain("password");
  });

  it("case 10: readDisplayName answers null when the row does not exist", async () => {
    const { pool } = createFakePool({ businessRows: [] });

    await expect(
      repositoryFor(pool).readDisplayName({ assetId: ASSET_ID }),
    ).resolves.toBeNull();
  });
});
