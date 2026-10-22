import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SubscriptionPlan } from "@loomic/shared";

import {
  JobConcurrencyError,
  type JobConcurrencyRepository,
} from "../../db/job-concurrency-repository.js";
import {
  MEMBER_CONCURRENCY_LIMIT,
  TierGuardError,
  createTierGuard,
} from "./tier-guard.js";

/**
 * `TierGuard` after workorder 21J, rewritten by workorder 39R (BL-40 / GN-20):
 * the plan no longer refuses a model or a quality, and concurrency is a per-member
 * limit of 4 on every plan.
 *
 * What this file pins is the plan rule and nothing else: the count comes from
 * the `pg` repository, the comparison is unchanged, the 429 message is unchanged
 * to the character, and a FAILING count still lets the request through
 * (fail-open). That last one is business semantics, not an oversight: while the
 * database is unavailable, letting a workspace over its limit generate is the
 * intended trade — blocking every generation is not.
 *
 * The three plan checks (model / image quality / video resolution) are pinned as
 * "never refuses" by the BL-40 case below.
 */

const WORKSPACE_ID = "00000000-0000-0000-0000-0000000000e1";
const OTHER_WORKSPACE_ID = "00000000-0000-0000-0000-0000000000e2";

/** Every plan: GN-20 says the concurrency limit is the same on all of them. */
const PLANS: readonly SubscriptionPlan[] = [
  "free",
  "starter",
  "pro",
  "ultra",
  "business",
];

/** The exact 429 text, hard-coded: it is a published contract, not a template. */
function limitMessage(activeCount: number): string {
  return `并发已满（${activeCount}/4），请等待当前任务完成`;
}

const MEMBER_ID = "00000000-0000-0000-0000-0000000000f1";
/** The two fixed arguments `checkConcurrency` logs on a failed count. */
const FAILURE_LOG_PREFIX = "[tier-guard] Failed to check concurrency:";
const FAILURE_LOG_DETAIL = "concurrency count unavailable";

type CountingRepository = JobConcurrencyRepository & {
  countActiveJobs: ReturnType<typeof vi.fn>;
};

/** A repository that answers `count` and records how it was called. */
function countingRepository(count: number): CountingRepository {
  return {
    countActiveJobs: vi.fn(async () => count),
  } as unknown as CountingRepository;
}

/** A repository that fails the way the real one does when PostgreSQL is gone. */
function failingRepository(error: unknown): CountingRepository {
  return {
    countActiveJobs: vi.fn(async () => {
      throw error;
    }),
  } as unknown as CountingRepository;
}

/** The driver failure that must NOT reach the log line, host and SQL included. */
function driverFailure(): Error {
  return new Error(
    "select count(*) from public.background_jobs failed: " +
      "postgres://loomic:secret@10.210.134.37:5432/loomic",
  );
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

/**
 * Compile-time nail: the factory's option object has ONE key, and it is the
 * repository. Both directions matter — a required `getAdminClient` would fail
 * the first, an optional one would fail the second — so re-adding a Supabase
 * client to this factory cannot pass `tsc` without this file being edited, which
 * is the whole point of the migration.
 */
type FactoryOptions = Parameters<typeof createTierGuard>[0];
type FactoryOptionKey = keyof FactoryOptions;
type FactoryTakesOnlyTheRepository =
  FactoryOptionKey extends "jobConcurrencyRepository"
    ? "jobConcurrencyRepository" extends FactoryOptionKey
      ? true
      : false
    : false;
const factoryTakesOnlyTheRepository: FactoryTakesOnlyTheRepository = true;

/**
 * Compile-time only helper: passing a Supabase-client-shaped option is a TYPE
 * error now. If `getAdminClient` were re-added to the options type, this call
 * would compile and the directive above it would become unused, which `tsc`
 * reports as an error. At runtime the extra key is simply ignored, which is what
 * the case below asserts.
 */
function callWithLegacyClientOption(
  jobConcurrencyRepository: JobConcurrencyRepository,
): unknown {
  // @ts-expect-error createTierGuard no longer takes a Supabase admin client
  return createTierGuard({ jobConcurrencyRepository, getAdminClient: () => null });
}

describe("tier-guard BL-40: the plan no longer refuses a model or a quality", () => {
  it("BL-40: no plan refuses a model or a quality", () => {
    const guard = createTierGuard({
      jobConcurrencyRepository: countingRepository(0),
    });

    for (const plan of ["free", "starter"] as const) {
      expect(() => guard.checkModelAccess(plan, "kwjm/gpt-image-2")).not.toThrow();
      expect(() => guard.checkModelAccess(plan, "any/other-model")).not.toThrow();
    }
    expect(() => guard.checkResolution("free", "ultra")).not.toThrow();
    expect(() => guard.checkVideoResolution("free", "4k")).not.toThrow();
    for (const plan of PLANS) {
      expect(() => guard.checkResolution(plan, "ultra")).not.toThrow();
      expect(() => guard.checkVideoResolution(plan, "4k")).not.toThrow();
    }
  });
});

describe("tier-guard checkConcurrency: under the limit", () => {
  it("GN-20: the limit is a constant 4", () => {
    expect(MEMBER_CONCURRENCY_LIMIT).toBe(4);
  });

  it("GN-20: three active jobs pass, the fourth is the limit", async () => {
    const three = countingRepository(3);
    const passing = createTierGuard({ jobConcurrencyRepository: three });

    await expect(
      passing.checkConcurrency(WORKSPACE_ID, "free", MEMBER_ID),
    ).resolves.toBeUndefined();
    expect(three.countActiveJobs).toHaveBeenCalledTimes(1);
    // A passing check is not noisy either: nothing is logged on the happy path.
    expect(errorSpy).not.toHaveBeenCalled();

    const four = createTierGuard({
      jobConcurrencyRepository: countingRepository(4),
    });
    const error = await four
      .checkConcurrency(WORKSPACE_ID, "free", MEMBER_ID)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(TierGuardError);
    const guardError = error as TierGuardError;
    expect(guardError.name).toBe("TierGuardError");
    expect(guardError.code).toBe("concurrency_limit");
    expect(guardError.statusCode).toBe(429);
    expect(guardError.message).toBe("并发已满（4/4），请等待当前任务完成");
    // A refusal is a normal answer, not a logged incident.
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("GN-20: the limit is the same on every plan", async () => {
    for (const plan of PLANS) {
      const below = createTierGuard({
        jobConcurrencyRepository: countingRepository(3),
      });
      const at = createTierGuard({
        jobConcurrencyRepository: countingRepository(4),
      });

      await expect(
        below.checkConcurrency(WORKSPACE_ID, plan, MEMBER_ID),
      ).resolves.toBeUndefined();

      const error = await at
        .checkConcurrency(WORKSPACE_ID, plan, MEMBER_ID)
        .catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(TierGuardError);
      expect((error as TierGuardError).code).toBe("concurrency_limit");
      expect((error as TierGuardError).statusCode).toBe(429);
      expect((error as TierGuardError).message).toBe(limitMessage(4));
    }
  });

  it("case 3: zero active jobs passes on every plan, including the free one", async () => {
    for (const plan of PLANS) {
      const guard = createTierGuard({
        jobConcurrencyRepository: countingRepository(0),
      });

      await expect(guard.checkConcurrency(WORKSPACE_ID, plan)).resolves.toBeUndefined();
    }
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("tier-guard checkConcurrency: at and above the limit", () => {
  it("GN-20: above the limit rejects, carrying the counted number", async () => {
    for (const count of [5, 9, 20]) {
      const guard = createTierGuard({
        jobConcurrencyRepository: countingRepository(count),
      });

      const error = await guard
        .checkConcurrency(WORKSPACE_ID, "business", MEMBER_ID)
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(TierGuardError);
      expect((error as TierGuardError).statusCode).toBe(429);
      expect((error as TierGuardError).code).toBe("concurrency_limit");
      expect((error as TierGuardError).message).toBe(
        `并发已满（${count}/4），请等待当前任务完成`,
      );
    }
  });

  it("GN-20: a member is counted by created_by", async () => {
    const repository = countingRepository(0);
    const guard = createTierGuard({ jobConcurrencyRepository: repository });

    await guard.checkConcurrency(WORKSPACE_ID, "pro", MEMBER_ID);

    expect(repository.countActiveJobs).toHaveBeenCalledTimes(1);
    expect(repository.countActiveJobs).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      createdBy: MEMBER_ID,
    });
  });

  it("case 7: without a user id the workspace id is passed through unchanged, never defaulted", async () => {
    const repository = countingRepository(0);
    const guard = createTierGuard({ jobConcurrencyRepository: repository });

    await guard.checkConcurrency(OTHER_WORKSPACE_ID, "pro");

    expect(repository.countActiveJobs).toHaveBeenCalledWith({
      workspaceId: OTHER_WORKSPACE_ID,
    });
    expect(repository.countActiveJobs).not.toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
    });
  });
});
describe("tier-guard checkConcurrency: a failing count fails OPEN", () => {
  it("GN-20: a failed count still lets the job through, and logs exactly once", async () => {
    const guard = createTierGuard({
      jobConcurrencyRepository: failingRepository(driverFailure()),
    });

    // Fail-OPEN: the check must not reject, must not throw, and must not fall
    // back to anything else. Blocking every generation while the database is
    // unavailable is exactly what this behaviour exists to prevent.
    await expect(guard.checkConcurrency(WORKSPACE_ID, "free")).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(FAILURE_LOG_PREFIX, FAILURE_LOG_DETAIL);
  });

  it("case 9: the logged arguments carry no driver message, host or SQL", async () => {
    const guard = createTierGuard({
      jobConcurrencyRepository: failingRepository(driverFailure()),
    });

    await guard.checkConcurrency(WORKSPACE_ID, "free");

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const args = errorSpy.mock.calls[0] ?? [];
    expect(args).toEqual([FAILURE_LOG_PREFIX, FAILURE_LOG_DETAIL]);

    const logged = args.map((value: unknown) => String(value)).join(" ");
    expect(logged).not.toMatch(
      /postgres:\/\/|10\.210\.134\.37|secret|select|background_jobs|public\./i,
    );
    expect(logged).not.toContain(WORKSPACE_ID);
    // Only two arguments: nothing was appended "for context".
    expect(args).toHaveLength(2);
  });

  it("case 10: a typed repository failure is logged as the same fixed text, cause and all", async () => {
    // The real repository wraps the driver error in `JobConcurrencyError` and
    // keeps the driver's error as `cause`. That cause is what would carry a host
    // or a statement into a log line, so it must not be passed on.
    const failure = new JobConcurrencyError(
      "countActiveJobs",
      driverFailure(),
    );
    const guard = createTierGuard({
      jobConcurrencyRepository: failingRepository(failure),
    });

    await expect(guard.checkConcurrency(WORKSPACE_ID, "business")).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const args = errorSpy.mock.calls[0] ?? [];
    expect(args).toEqual([FAILURE_LOG_PREFIX, FAILURE_LOG_DETAIL]);
    const logged = args.map((value: unknown) => String(value)).join(" ");
    expect(logged).not.toContain(failure.message);
    expect(logged).not.toContain("countActiveJobs");
  });

  it("case 11: a missing repository fails open too, instead of taking generation down", async () => {
    // `app.ts` always wires one, so this is the "wired wrong" path rather than a
    // supported configuration — and it still must not throw out of the check.
    const guard = createTierGuard({
      jobConcurrencyRepository: undefined,
    } as unknown as FactoryOptions);

    await expect(guard.checkConcurrency(WORKSPACE_ID, "free")).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});

describe("tier-guard checkConcurrency: no Supabase client anywhere", () => {
  it("case 12: the factory takes the repository as its ONLY option", () => {
    const repository = countingRepository(0);
    const options = { jobConcurrencyRepository: repository };

    expect(Object.keys(options)).toEqual(["jobConcurrencyRepository"]);
    expect(factoryTakesOnlyTheRepository).toBe(true);
  });

  it("case 13: a Supabase-client-shaped option is neither required nor called", async () => {
    const getAdminClient = vi.fn(() => {
      throw new Error("checkConcurrency must not reach for a Supabase client");
    });
    const repository = countingRepository(MEMBER_CONCURRENCY_LIMIT);

    // The type does not accept this key (see `callWithLegacyClientOption`), and
    // the runtime object below proves nothing reads it either.
    const options = {
      jobConcurrencyRepository: repository,
      getAdminClient,
    } as unknown as FactoryOptions;
    const guard = createTierGuard(options);

    await expect(guard.checkConcurrency(WORKSPACE_ID, "free")).rejects.toBeInstanceOf(
      TierGuardError,
    );
    expect(getAdminClient).not.toHaveBeenCalled();

    // The same on the failure path, where the old code used the client to ask.
    const failing = createTierGuard({
      jobConcurrencyRepository: failingRepository(driverFailure()),
      getAdminClient,
    } as unknown as FactoryOptions);
    await expect(failing.checkConcurrency(WORKSPACE_ID, "free")).resolves.toBeUndefined();
    expect(getAdminClient).not.toHaveBeenCalled();

    // And the legacy call shape is a compile-time error, not a silent fallback.
    expect(() => callWithLegacyClientOption(repository)).not.toThrow();
    expect(getAdminClient).not.toHaveBeenCalled();
  });
});
