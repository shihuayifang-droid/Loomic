// OP-05 (workorder 45L): which volume objects does the database still reference?
//
// One read-only statement. A `bucket/key` counts as referenced when any of
// these says so:
//   - `asset_objects (bucket, object_path)`
//   - `projects.thumbnail_path`, which always lives in the `project-assets` bucket
//   - `brand_kit_assets.file_url`, a path inside the `brand-kit-assets` bucket
//     (the brand-kit tool signs it with that bucket name and the stored value)
// Nothing else is read and nothing is written.
import {
  withPrivilegedTransaction,
  type TransactionPool,
} from "./transaction.js";

export const THUMBNAIL_BUCKET = "project-assets";
export const BRAND_KIT_BUCKET = "brand-kit-assets";

export type ObjectRef = { bucket: string; key: string };

export type ObjectReferenceRepository = {
  /** The subset of `refs` that is referenced, as `bucket/key` strings. */
  findReferenced(refs: ObjectRef[]): Promise<Set<string>>;
};

export class ObjectReferenceError extends Error {
  constructor(cause: unknown) {
    super("object reference read failed (findReferenced)", { cause });
    this.name = "ObjectReferenceError";
  }
}

const FIND_REFERENCED_SQL = `
select r.bucket as bucket, r.key as key
from unnest($1::text[], $2::text[]) as r(bucket, key)
where exists (
        select 1 from public.asset_objects a
        where a.bucket = r.bucket and a.object_path = r.key
      )
   or (r.bucket = '${THUMBNAIL_BUCKET}' and exists (
        select 1 from public.projects p where p.thumbnail_path = r.key
      ))
   or (r.bucket = '${BRAND_KIT_BUCKET}' and exists (
        select 1 from public.brand_kit_assets b where b.file_url = r.key
      ))
`;

export function createObjectReferenceRepository(options: {
  getTransactionPool: () => TransactionPool;
}): ObjectReferenceRepository {
  return {
    async findReferenced(refs) {
      if (refs.length === 0) return new Set();
      try {
        const pool = options.getTransactionPool();
        const buckets = refs.map((r) => r.bucket);
        const keys = refs.map((r) => r.key);
        return await withPrivilegedTransaction(pool, null, async (client) => {
          const result = await client.query(FIND_REFERENCED_SQL, [buckets, keys]);
          const found = new Set<string>();
          for (const row of result.rows as Array<{ bucket: string; key: string }>) {
            found.add(`${row.bucket}/${row.key}`);
          }
          return found;
        });
      } catch (error) {
        throw new ObjectReferenceError(error);
      }
    },
  };
}
