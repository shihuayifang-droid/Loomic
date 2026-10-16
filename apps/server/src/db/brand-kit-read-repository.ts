/**
 * Brand kit read repository (workorder 21Y, ADR-0001 migration step).
 *
 * The TWO PostgREST reads behind `GET /api/brand-kits` — the caller's own kit
 * rows and the `kit_id` / `asset_type` rows of those kits — move here, and only
 * those two. Both used to run on the caller's own user-scoped PostgREST client,
 * where ROW LEVEL SECURITY decided what was visible. The policies
 * (`supabase/migrations/20260325000001_create_brand_kits.sql`) are:
 *
 *   CREATE POLICY brand_kits_user_policy ON public.brand_kits
 *     FOR ALL USING (auth.uid() = user_id);
 *
 *   CREATE POLICY brand_kit_assets_policy ON public.brand_kit_assets
 *     FOR ALL USING (
 *       EXISTS (SELECT 1 FROM public.brand_kits WHERE id = kit_id AND user_id = auth.uid()));
 *
 * A brand kit is a PRIVATE, OWNER-ONLY resource and that is the whole ACL: a
 * kit belongs to exactly one `user_id` and nobody else reads it. Being a member
 * of a workspace, being able to read a project, or being an administrator grants
 * NOTHING here — an admin cannot read somebody else's brand kit today and this
 * migration must not start granting that. So there is deliberately no helper
 * function, no membership join, no role clause and no `is_default`/archive
 * filter: every predicate below is one of the two policy expressions translated
 * into SQL verbatim, and neither ACL may be derived from the other.
 *
 * This repository runs privileged (the pool's role bypasses RLS), so the
 * policies above no longer run and the statements' OWN predicates are the only
 * gate there is. That is exactly why they are written out here rather than
 * inherited from a policy that is no longer evaluated.
 *
 * `listOwnKits` is the entire interface: no access token, no table name, no
 * column list. The only rows it can ever answer with are the caller's own kits
 * and the assets of those kits, because `$1` is the actor and nothing else keys
 * the read.
 *
 * Statement 1 answering ZERO rows is a legal empty answer AND the end of the
 * call: the read it replaces returned early on an empty kit list and never
 * issued the asset read, so statement 2 is not sent here either. That keeps the
 * shape of the work identical (one round trip for a user with no kits) and keeps
 * a pointless `any('{}')` off the wire.
 *
 * Every failure — a bad argument, a connect, SQL, timeout or row-shape failure —
 * throws `BrandKitReadError`, whose own message is fixed text: no SQL, no host,
 * no connection string and no kit/user id. The driver's own error rides along as
 * `cause` so a caller can classify it without the driver's message reaching a log
 * line or an HTTP body.
 *
 * One intended difference from the read this replaces: PostgREST returned
 * timestamps with microseconds and a `+00:00` offset, while `toISOString()`
 * publishes milliseconds and `Z`. Both satisfy the published
 * `z.string().datetime({ offset: true })` contract, and the pg-backed
 * project/settings repositories that preceded this one made exactly the same
 * move.
 *
 * The pool is reached through a getter, so importing or wiring this module never
 * reads `DATABASE_URL`, never connects and never fails at build time. A missing
 * pool is a read failure on the call, never a silent fallback: nothing in this
 * module can reach PostgREST.
 */

import {
  withPrivilegedTransaction,
  type TransactionPool,
} from "./transaction.js";

/** The enum `public.brand_kit_asset_type`, verbatim. */
export type BrandKitReadAssetType = "color" | "font" | "logo" | "image";

/** A `brand_kits` row as statement 1 reads it, timestamps already ISO strings. */
export type BrandKitRow = {
  id: string;
  name: string;
  is_default: boolean;
  cover_url: string | null;
  created_at: string;
  updated_at: string;
};

/** A `brand_kit_assets` row as statement 2 reads it — two columns, nothing else. */
export type BrandKitAssetRow = {
  kit_id: string;
  asset_type: BrandKitReadAssetType;
};

export type BrandKitListResult = {
  kits: BrandKitRow[];
  assets: BrandKitAssetRow[];
};

export type BrandKitReadRepository = {
  /**
   * The kits `actorId` owns, in the order `created_at asc`, plus the
   * `kit_id`/`asset_type` rows of exactly those kits. Both lists are empty when
   * the actor owns none.
   */
  listOwnKits(input: { actorId: string }): Promise<BrandKitListResult>;
};

export const LIST_OWN_KITS = "listOwnKits";

export type BrandKitReadOperation = typeof LIST_OWN_KITS;

/**
 * The failure shape of this module. The message is built from the fixed
 * operation name only: a driver error that embeds the statement, a host or a
 * credential must never reach a log line or an HTTP body through us.
 */
export class BrandKitReadError extends Error {
  readonly operation: BrandKitReadOperation;

  constructor(operation: BrandKitReadOperation, cause: unknown) {
    super(
      `brand kit read failed (${operation})`,
      cause === undefined ? {} : { cause },
    );
    this.name = "BrandKitReadError";
    this.operation = operation;
  }
}

/**
 * Statement 1: `brand_kits_user_policy`, translated literally.
 *
 * `k.user_id = $1::uuid` IS the policy — `auth.uid() = user_id` with the actor
 * bound as a parameter. The id is bound with an explicit `::uuid` cast, so a
 * malformed one fails as a real SQL error (SQLSTATE 22P02) inside the
 * transaction instead of silently matching something else.
 *
 * The ORDER BY is `created_at asc` and nothing else, exactly as the removed
 * PostgREST read ordered it. Appending a tie-breaker here would change the order
 * the endpoint publishes for two kits created in the same transaction, which is
 * a behaviour change this workorder does not own.
 *
 * There is deliberately no workspace, project, archive or role predicate: the
 * read policy has none.
 */
const LIST_OWN_KITS_SQL = `
select k.id, k.name, k.is_default, k.cover_url, k.created_at, k.updated_at
  from public.brand_kits k
 where k.user_id = $1::uuid
 order by k.created_at asc
`;

/**
 * Statement 2: `brand_kit_assets_policy`, translated literally.
 *
 * The `exists` clause IS the policy, even though on this call path it looks
 * redundant — `$2` already came from statement 1, so every id in it belongs to
 * the actor. It is kept because a repository whose authorisation is "the caller
 * passed the right ids" has no authorisation of its own: the statement has to
 * refuse a kit that is not the actor's even if one is ever bound to it. Dropping
 * it would make the ACL a property of the caller instead of a property of this
 * statement.
 *
 * `asset_type` is cast to `text` because the column is the
 * `public.brand_kit_asset_type` enum and this module maps strings; the cast keeps
 * the driver from handing back an enum wrapper and lets the mapper do the
 * four-value check itself.
 */
const LIST_OWN_KIT_ASSETS_SQL = `
select a.kit_id, a.asset_type::text as asset_type
  from public.brand_kit_assets a
 where a.kit_id = any($2::uuid[])
   and exists (select 1 from public.brand_kits k
                where k.id = a.kit_id and k.user_id = $1::uuid)
`;

/**
 * Build the PostgreSQL implementation. The pool is reached through a getter,
 * never stored: constructing the repository is free, and a missing
 * `DATABASE_URL` only surfaces as a `BrandKitReadError` on an actual read.
 *
 * There is no fallback path. A caller that was handed this repository either
 * reads through it or fails.
 */
export function createBrandKitReadRepository(options: {
  getTransactionPool: () => TransactionPool;
}): BrandKitReadRepository {
  return {
    async listOwnKits(input) {
      // Arguments first: an unusable one must not open a connection, and it must
      // not be reported as a database failure either.
      const actorId = requireReadArgument(input.actorId, "actorId");

      try {
        const pool = options.getTransactionPool();

        return await withPrivilegedTransaction(
          pool,
          // The transaction context carries WHO asked, so a privileged read is
          // not anonymous in a log or an audit trail. It grants nothing: the
          // statements' own predicates above are the authorisation rule.
          { userId: actorId },
          async (client) => {
            const kitResult = await client.query(LIST_OWN_KITS_SQL, [actorId]);
            const kits = kitResult.rows.map(mapKitRow);

            // Zero kits: the read this replaces returned here without issuing the
            // asset read at all, so it is not issued either — see the header.
            if (kits.length === 0) return { kits: [], assets: [] };

            const assetResult = await client.query(LIST_OWN_KIT_ASSETS_SQL, [
              actorId,
              kits.map((kit) => kit.id),
            ]);

            return { kits, assets: assetResult.rows.map(mapAssetRow) };
          },
        );
      } catch (error) {
        throw new BrandKitReadError(LIST_OWN_KITS, error);
      }
    },
  };
}

/**
 * A bound value is only usable when it is a real, non-empty string.
 *
 * The UUID SHAPE is deliberately not checked here: a malformed id is bound as
 * `::uuid`, so PostgreSQL rejects it (SQLSTATE 22P02) inside the transaction, the
 * transaction rolls back and the connection stays usable. Pre-validating it here
 * would hide that path instead of exercising it.
 */
function requireReadArgument(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new BrandKitReadError(
      LIST_OWN_KITS,
      new Error(`brand kit read needs a non-empty "${field}"`),
    );
  }

  return value;
}

/**
 * Statement 1's row, mapped strictly. Every column of the projection has a
 * declared type — `name text not null`, `is_default boolean not null`,
 * `cover_url text` (nullable), two `timestamptz not null` — so a value of any
 * other shape means the statement and this mapper disagree, and it fails here
 * rather than travelling on as a brand kit the client cannot render.
 */
function mapKitRow(row: unknown): BrandKitRow {
  const record = asReadRow(row);

  return {
    id: requireString(record, "id"),
    name: requireText(record, "name"),
    is_default: requireBoolean(record, "is_default"),
    cover_url: requireNullableString(record, "cover_url"),
    created_at: requireTimestamp(record, "created_at"),
    updated_at: requireTimestamp(record, "updated_at"),
  };
}

/**
 * Statement 2's row. `asset_type` arrives as text (the statement casts it) and
 * is checked against the four values of `public.brand_kit_asset_type`: the
 * service keeps a `Record` of the four counts and would silently create a fifth
 * key — or count `NaN` — for anything else.
 */
function mapAssetRow(row: unknown): BrandKitAssetRow {
  const record = asReadRow(row);

  return {
    kit_id: requireString(record, "kit_id"),
    asset_type: requireAssetType(record["asset_type"]),
  };
}

function asReadRow(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("brand kit read returned a row that is not an object");
  }

  return value as Record<string, unknown>;
}

function requireString(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`brand kit read returned no usable "${field}"`);
  }

  return value;
}

/**
 * `name` is `text not null` with a default, and an EMPTY name is a string this
 * module has no mandate to reject: `PATCH /api/brand-kits/:id` accepts a
 * one-space name (the request schema checks length, then the service trims it),
 * so `""` is reachable in the column today. The read this replaces published it
 * unchanged, and tightening that here would be a silent behaviour change.
 */
function requireText(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = row[field];
  if (typeof value !== "string") {
    throw new Error(`brand kit read returned an unusable "${field}"`);
  }

  return value;
}

function requireBoolean(
  row: Readonly<Record<string, unknown>>,
  field: string,
): boolean {
  const value = row[field];
  if (typeof value !== "boolean") {
    throw new Error(`brand kit read returned an unusable "${field}"`);
  }

  return value;
}

/**
 * `cover_url` is a nullable text column, so the projection always carries it:
 * SQL NULL is the only "absent" this accepts. A missing key or any other type is
 * drift, not a null — the removed PostgREST read published the column as it was
 * and never invented a value for it.
 */
function requireNullableString(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string | null {
  const value = row[field];
  if (value === null) return null;

  if (typeof value !== "string") {
    throw new Error(`brand kit read returned an unusable "${field}"`);
  }

  return value;
}

const ASSET_TYPES: readonly BrandKitReadAssetType[] = [
  "color",
  "font",
  "logo",
  "image",
];

function requireAssetType(value: unknown): BrandKitReadAssetType {
  for (const candidate of ASSET_TYPES) {
    if (value === candidate) return candidate;
  }

  throw new Error("brand kit read returned an unusable \"asset_type\"");
}

/** ISO-8601 with an explicit offset: the shape the HTTP contract publishes. */
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * `pg` and PGlite hand back `timestamptz` as a `Date`; the HTTP DTO
 * (`brandKitSummarySchema`) is a string with an offset. Both are accepted and
 * normalised to `toISOString()`, anything else fails loud — a null timestamp
 * would silently become a kit the client cannot render.
 *
 * A private copy of the rule `db/project-read-repository.ts` established, kept
 * local on purpose: importing it from there would couple two repositories that
 * have no other reason to know about each other, and `project-read-repository.ts`
 * is outside this workorder's whitelist.
 */
function requireTimestamp(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = row[field];

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error(`brand kit read returned an unusable "${field}"`);
    }

    return value.toISOString();
  }

  if (typeof value === "string" && ISO_TIMESTAMP.test(value)) {
    return new Date(value).toISOString();
  }

  throw new Error(`brand kit read returned no usable "${field}"`);
}
