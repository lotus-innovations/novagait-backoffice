// Named, schema'd, bounded, inspectable memory stores (spec 07 §9, arch
// doc E). Three stores by design: run state (run-state.ts, wired at
// LOT-88), vendor profiles, and the dedupe ledger — the latter two live
// here. Every read/write is traced by the caller as memory.read /
// memory.write; store methods return what the trace needs (hit flags,
// field diffs) so call sites cannot forget the numbers.

import { createHash } from "node:crypto";
import type { Store } from "./store";

// Store names as they appear in trace events and on the /memory page.
export const MEMORY_STORE_NAMES = {
  runState: "run_state",
  vendorProfiles: "vendor_profiles",
  dedupe: "dedupe",
} as const;

// ---------------------------------------------------------------------------
// Dedupe ledger: normalized-content digest -> prior run_id (key seen:{digest})
// ---------------------------------------------------------------------------

// Entries survive the demo day; the nightly reset clears the store anyway.
export const DEDUPE_TTL_SECONDS = 24 * 60 * 60;

/** Whitespace-collapsed document text: the digest input. */
export function normalizeContent(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 16-hex-char sha256 digest of the normalized content. */
export function contentDigest(text: string): string {
  return createHash("sha256")
    .update(normalizeContent(text))
    .digest("hex")
    .slice(0, 16);
}

export class DedupeLedger {
  constructor(private store: Store) {}

  private key(digest: string): string {
    return `seen:${digest}`;
  }

  /** Prior run_id for this digest, or null if unseen. */
  async check(digest: string): Promise<string | null> {
    return this.store.get(this.key(digest));
  }

  async record(digest: string, runId: string): Promise<void> {
    await this.store.set(this.key(digest), runId, DEDUPE_TTL_SECONDS);
  }
}

// ---------------------------------------------------------------------------
// Vendor profiles: bounded per-vendor memory (key vendor:{vendor_id})
// ---------------------------------------------------------------------------

// Field set is closed and versioned; adding a field bumps PROFILE_VERSION.
export const PROFILE_VERSION = "1";

export interface VendorProfile {
  profile_version: string;
  canonical_name: string;
  last_seen: string; // YYYY-MM-DD
  runs_count: number;
  exception_count: number;
  learned_gl_code: string | null;
}

/** The bounded write surface (mirrors the update_vendor_profile tool). */
export interface VendorProfileUpdate {
  canonical_name?: string;
  last_seen?: string;
  learned_gl_code?: string;
  exception_increment?: number;
}

const LAST_SEEN_RE = /^\d{4}-\d{2}-\d{2}$/;
const GL_CODE_RE = /^\d{4}$/;
const EXCEPTION_COUNT_CAP = 999;

export class VendorProfileStore {
  constructor(private store: Store) {}

  private key(vendorId: string): string {
    return `vendor:${vendorId}`;
  }

  async get(vendorId: string): Promise<VendorProfile | null> {
    const hash = await this.store.hgetall(this.key(vendorId));
    if (!hash) return null;
    return {
      profile_version: hash.profile_version ?? PROFILE_VERSION,
      canonical_name: hash.canonical_name ?? "",
      last_seen: hash.last_seen ?? "",
      runs_count: Number(hash.runs_count ?? 0),
      exception_count: Number(hash.exception_count ?? 0),
      learned_gl_code: hash.learned_gl_code || null,
    };
  }

  /**
   * Apply a bounded update. Invalid fields are dropped (never thrown: the
   * model can call this tool) and reported in `rejected`. Returns the field
   * diff exactly as written, ready for the memory.write trace event.
   */
  async applyUpdate(
    vendorId: string,
    update: VendorProfileUpdate,
  ): Promise<{
    profile: VendorProfile;
    diff: Record<string, string>;
    rejected: string[];
  }> {
    const prior = await this.get(vendorId);
    const diff: Record<string, string> = {};
    const rejected: string[] = [];

    if (!prior) {
      diff.profile_version = PROFILE_VERSION;
      diff.runs_count = "1";
    } else {
      diff.runs_count = String(prior.runs_count + 1);
    }

    if (update.canonical_name !== undefined) {
      if (update.canonical_name.trim()) {
        diff.canonical_name = update.canonical_name.trim();
      } else {
        rejected.push("canonical_name");
      }
    }
    if (update.last_seen !== undefined) {
      if (LAST_SEEN_RE.test(update.last_seen)) {
        diff.last_seen = update.last_seen;
      } else {
        rejected.push("last_seen");
      }
    }
    if (update.learned_gl_code !== undefined) {
      if (GL_CODE_RE.test(update.learned_gl_code)) {
        diff.learned_gl_code = update.learned_gl_code;
      } else {
        rejected.push("learned_gl_code");
      }
    }
    if (update.exception_increment !== undefined) {
      const inc = update.exception_increment;
      if (Number.isInteger(inc) && inc > 0) {
        diff.exception_count = String(
          Math.min((prior?.exception_count ?? 0) + inc, EXCEPTION_COUNT_CAP),
        );
      } else if (inc !== 0) {
        rejected.push("exception_increment");
      }
    }

    await this.store.hset(this.key(vendorId), diff);
    const profile = (await this.get(vendorId))!;
    return { profile, diff, rejected };
  }
}
