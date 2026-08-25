/**
 * Redaction manifest model for the review page (spec §3.4).
 *
 * A deliberate small copy of packages/shared/src/redaction.ts (cutsToKeepRanges + normalise): the
 * extension is published standalone to the open-source mirror, so it takes no workspace
 * dependencies. If the semantics here change, change shared first — the worker validates every
 * manifest against the shared zod schema and is the source of truth.
 */

export interface RedactionManifest {
  /** KEEP-ranges on the original timeline; everything outside is cut. */
  trims?: { start: number; end: number }[];
  /** Blur boxes, normalised 0–1 against the source frame. */
  blurs?: { x: number; y: number; w: number; h: number; t0: number; t1: number }[];
  mutes?: { t0: number; t1: number }[];
}

export interface EditState {
  cuts: { t0: number; t1: number }[];
  blurs: { x: number; y: number; w: number; h: number; t0: number; t1: number }[];
  mutes: { t0: number; t1: number }[];
}

export const emptyEdits = (): EditState => ({ cuts: [], blurs: [], mutes: [] });
export const hasEdits = (s: EditState): boolean => s.cuts.length > 0 || s.blurs.length > 0 || s.mutes.length > 0;

function mergeRanges(ranges: { start: number; end: number }[], dur: number): { start: number; end: number }[] {
  const cleaned = ranges
    .map((r) => ({ start: Math.max(0, Math.min(r.start, dur)), end: Math.max(0, Math.min(r.end, dur)) }))
    .filter((r) => r.end - r.start > 0.05)
    .sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const r of cleaned) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

/** Cuts (how the user thinks) → keep-ranges (what the manifest wants). Null = everything cut. */
export function cutsToKeep(cuts: { t0: number; t1: number }[], dur: number): { start: number; end: number }[] | null {
  const cut = mergeRanges(cuts.map((c) => ({ start: c.t0, end: c.t1 })), dur);
  const keep: { start: number; end: number }[] = [];
  let at = 0;
  for (const c of cut) {
    if (c.start > at) keep.push({ start: at, end: c.start });
    at = Math.max(at, c.end);
  }
  if (at < dur) keep.push({ start: at, end: dur });
  return keep.length ? keep : null;
}

/** Seconds surviving the cuts — shown as "keeps M:SS" so the user sees the result before upload. */
export function keptSeconds(cuts: { t0: number; t1: number }[], dur: number): number {
  const keep = cutsToKeep(cuts, dur);
  return keep ? keep.reduce((s, r) => s + (r.end - r.start), 0) : 0;
}

export function toManifest(s: EditState, dur: number): RedactionManifest | null {
  if (!hasEdits(s)) return null;
  const m: RedactionManifest = {};
  if (s.cuts.length) {
    const keep = cutsToKeep(s.cuts, dur);
    if (!keep) return null; // cutting everything is a delete, not an edit
    m.trims = keep;
  }
  if (s.blurs.length) m.blurs = s.blurs;
  if (s.mutes.length) m.mutes = s.mutes;
  return m;
}
