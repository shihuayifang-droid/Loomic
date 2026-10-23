// OP-05 / ADR-0001: the ONE seam between the application and object storage.
//
// Why an interface instead of calling the SDK directly
// The application has been reading and writing objects through the Supabase SDK
// in 23 places. OP-05 moves the bytes onto a private Linux volume, so every one
// of those places has to keep working while the backend underneath changes. This
// module is that seam: callers depend on `ObjectStore`, and a backend (Supabase
// today, the file volume next) satisfies it. A migration ticket then only has to
// move a call site from the SDK to this interface; the behaviour stays put
// because the Supabase implementation is a one-to-one wrapper.
//
// This file deliberately holds TYPES AND THE ERROR ONLY: no backend, no I/O. It
// is the contract, and importing it must never pull a client into the process.
import type { ProjectAssetTransform } from "./project-asset-urls.js";

/** One object, addressed the way every backend addresses it: bucket + key. */
export type ObjectRef = {
  bucket: string;
  key: string;
};

/**
 * A byte range of an object, both ends INCLUSIVE - the HTTP `Range` spelling.
 * `end` absent means "to the last byte".
 */
export type ObjectRange = {
  start: number;
  end?: number;
};

/**
 * The four ways an object operation can fail, in the vocabulary callers act on:
 * `not_found` (404), `exists` (the object is there and upsert was not asked
 * for), `invalid_key` (the request cannot be addressed at all, e.g. a cross
 * bucket copy), `backend_failed` (the backend said no or broke).
 */
export type ObjectStoreErrorCode =
  | "not_found"
  | "exists"
  | "invalid_key"
  | "backend_failed";

export class ObjectStoreError extends Error {
  constructor(
    readonly code: ObjectStoreErrorCode,
    message: string,
    /**
     * 43F: the raw backend message, kept when the `message` above is a sentence
     * this module composed. Callers that have to reproduce a previous error text
     * word for word read this instead of parsing the composed one.
     */
    readonly detail?: string,
  ) {
    super(message);
    this.name = "ObjectStoreError";
  }
}

/** How `put` describes the bytes it is handed. */
export type ObjectPutOptions = {
  contentType: string;
  /** Replace an existing object instead of failing with `exists`. */
  upsert?: boolean;
};

/**
 * What `get` returns. `size` is the size of the WHOLE object; with a range the
 * returned `body` is just the requested slice and `range` says which one, echo
 * of the bytes actually served after clamping to the object.
 */
export type ObjectReadResult = {
  body: Buffer;
  size: number;
  contentType: string;
  range?: { start: number; end: number };
};

/** Metadata of an object that exists; `head` returns `null` instead when absent. */
export type ObjectHead = {
  size: number;
  contentType: string;
};

/** How `signedReadUrl` describes the URL it wants. */
export type SignedReadUrlOptions = {
  ttlSeconds: number;
  /** Name the download should carry, when the caller wants an attachment. */
  download?: string;
  /** On-the-fly image transform, when the backend supports one. */
  transform?: ProjectAssetTransform;
};

/**
 * The storage contract. `body` is a `Buffer` for now: streaming is a separate
 * decision and would change every implementation at once.
 */
export interface ObjectStore {
  put(ref: ObjectRef, body: Buffer, options: ObjectPutOptions): Promise<void>;

  get(ref: ObjectRef, range?: ObjectRange): Promise<ObjectReadResult>;

  head(ref: ObjectRef): Promise<ObjectHead | null>;

  /** Idempotent: deleting an object that is not there is not an error. */
  delete(refs: readonly ObjectRef[]): Promise<void>;

  copy(from: ObjectRef, to: ObjectRef): Promise<void>;

  signedReadUrl(ref: ObjectRef, options: SignedReadUrlOptions): Promise<string>;
}
