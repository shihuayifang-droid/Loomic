import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PLAN_CONFIGS, type SubscriptionPlan } from "@loomic/shared";

import {
  JobConcurrencyError,
  type JobConcurrencyRepository,
} from "../../db/job-concurrency-repository.js";
import { TierGuardError, createTierGuard } from "./tier-guard.js";

/**
 * `TierGuard.checkConcurrency` after workorder 21J.
 *
 * What this file pins is the plan rule and nothing else: the count comes from
 * the `pg` repository, the comparison is unchanged, the 429 message is unchanged
 * to the character, and a FAILING count still lets the request through
 * (fail-open). That last one is business semantics, not an oversight: while the
 * database is unavailable, letting a workspace over its limit generate is the
 * intended trade — blocking every generation is not.
 *
 * The four other `TierGuard` methods are deliberately NOT covered here: this
 * workorder changed one method and this file is that method's contract.
 */

const WORKSPACE_ID = "00000000-0000-0000-0000-0000000000e1";
const OTHER_WORKSPACE_ID = "00000000-0000-0000-0000-0000000000e2";

/**
 * Every plan, with the max-concurrency limit pinned to a literal here as well as
 * through `PLAN_CONFIGS`. If the shared configuration moved, case 1 says so
 * instead of silently re-basing the whole boundary.
 */
const PLAN_LIMITS: ReadonlyArray<readonly [SubscriptionPlan, number]> = [
  ["free", 1],
  ["starter", 2],
  ["pro", 4],
  ["ultra", 8],
  ["business", 12],
];

/** The exact 429 text, hard-coded: it is a published contract, not a template. */
function limitMessage(activeCount: number, maxConcurrent: number): string {
  return `Concurrent job limit reached (${activeCount}/${maxConcurrent}). Wait for a job to finish or upgrade your plan.`;
}

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

describe("tier-guard checkConcurrency: under the limit", () => {
  it("case 1: every plan allows a count strictly below its limit, and the limit is the plan's own", () => {
    for (const [plan, limit] of PLAN_LIMITS) {
      // The shared configuration and this file agree on the boundary before the
      // boundary is exercised.
      expect([plan, PLAN_CONFIGS[plan].maxConcurrentJobs]).toEqual([plan, limit]);
    }
  });

  it("case 2: a count below the limit passes and the repository is read once", async () => {
    for (const [plan, limit] of PLAN_LIMITS) {
      const repository = countingRepository(limit - 1);
      const guard = createTierGuard({ jobConcurrencyRepository: repository });

      await expect(guard.checkConcurrency(WORKSPACE_ID, plan)).resolves.toBeUndefined();

      expect(repository.countActiveJobs).toHaveBeenCalledTimes(1);
      expect(repository.countActiveJobs).toHaveBeenCalledWith({
        workspaceId: WORKSPACE_ID,
      });
      // A passing check is not noisy either: nothing is logged on the happy path.
      expect(errorSpy).not.toHaveBeenCalled();
    }
  });

  it("case 3: zero active jobs passes on every plan, including the free one", async () => {
    for (const [plan] of PLAN_LIMITS) {
      const guard = createTierGuard({
        jobConcurrencyRepository: countingRepository(0),
      });

      await expect(guard.checkConcurrency(WORKSPACE_ID, plan)).resolves.toBeUndefined();
    }
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("tier-guard checkConcurrency: at and above the limit", () => {
  it("case 4: AT the limit each plan rejects with its own 429, message unchanged word for word", async () => {
    for (const [plan, limit] of PLAN_LIMITS) {
      const guard = createTierGuard({
        jobConcurrencyRepository: countingRepository(limit),
      });

      const error = await guard
        .checkConcurrency(WORKSPACE_ID, plan)
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(TierGuardError);
      const guardError = error as TierGuardError;
      expect(guardError.name).toBe("TierGuardError");
      expect(guardError.code).toBe("concurrency_limit");
      expect(guardError.statusCode).toBe(429);
      // Word for word, with the counted number and THIS plan's limit in it.
      expect(guardError.message).toBe(limitMessage(limit, limit));
      expect(guardError.message).toContain(`(${limit}/${limit})`);
    }
    // A refusal is a normal answer, not a logged incident.
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("case 5: ABOVE the limit rejects, carrying the counted number and the plan's limit", async () => {
    const cases: ReadonlyArray<readonly [SubscriptionPlan, number, number]> = [
      ["free", 5, 1],
      ["starter", 3, 2],
      ["pro", 9, 4],
      ["ultra", 20, 8],
      ["business", 13, 12],
    ];

    for (const [plan, count, limit] of cases) {
      const guard = createTierGuard({
        jobConcurrencyRepository: countingRepository(count),
      });

      const error = await guard
        .checkConcurrency(WORKSPACE_ID, plan)
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(TierGuardError);
      expect((error as TierGuardError).statusCode).toBe(429);
      expect((error as TierGuardError).code).toBe("concurrency_limit");
      expect((error as TierGuardError).message).toBe(limitMessage(count, limit));
    }
  });

  it("case 6: the boundary is exactly the plan's maxConcurrentJobs, not one either side", async () => {
    for (const [plan, limit] of PLAN_LIMITS) {
      const below = createTierGuard({
        jobConcurrencyRepository: countingRepository(limit - 1),
      });
      const at = createTierGuard({
        jobConcurrencyRepository: countingRepository(limit),
      });

      await expect(below.checkConcurrency(WORKSPACE_ID, plan)).resolves.toBeUndefined();
      await expect(at.checkConcurrency(WORKSPACE_ID, plan)).rejects.toBeInstanceOf(
        TierGuardError,
      );
    }
  });

  it("case 7: the workspace id is passed through unchanged, never defaulted", async () => {
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
  it("case 8: a repository failure lets the request through and logs exactly once", async () => {
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
    const repository = countingRepository(3);

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
