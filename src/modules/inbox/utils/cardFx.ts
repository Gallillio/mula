import type { FxMethod, Minor } from '../../shared/db/types';

/**
 * Rules for card charges the bank settles later (HSBC Egypt credit cards). At purchase the bank
 * holds its own EGP amount, visible only as the drop in the card's available limit between two
 * messages; 1–3 days later it posts at the posting-date rate plus a mark-up, without a message.
 * Pure functions; the database side is in ../data/cardLimitRepo.ts.
 */

/** A limit drop is trusted only between these multiples of the market conversion. */
export const LIMIT_DROP_RANGE = { min: 0.95, max: 1.2 } as const;

/**
 * A silent posting adjustment is matched to a waiting record only when it is at most this share
 * of that record's amount (HSBC's run 0.3–3%); a bigger gap is something else (a fee, an
 * unrecorded charge) and is only noted.
 */
export const POSTING_ADJUSTMENT_MAX_SHARE = 0.08;

/** How far back the card's previous message may be for its limit to explain a gap. */
export const LIMIT_GAP_MAX_AGE_MS = 14 * 86_400_000;

/** The mark-up (percent) for a currency: its own entry, else `other`, else 0. */
export function markupPercent(table: Record<string, number> | null | undefined, currency: string): number {
  const own = table?.[currency.toUpperCase()];
  if (typeof own === 'number' && Number.isFinite(own)) return own;
  const other = table?.other;
  return typeof other === 'number' && Number.isFinite(other) ? other : 0;
}

export type FxDecision = { amount: Minor; method: FxMethod; withinRange: boolean | null };

/**
 * The amount in the account's currency for a foreign-currency card charge.
 * - `drop`: previous limit − this limit + payments and credits recorded in between (null when unknown)
 * - `market`: the market conversion (null when no rate is available)
 */
export function decideFxAmount(input: { drop: Minor | null; market: Minor | null; markup: number }): FxDecision | null {
  const { drop, market, markup } = input;
  if (market != null && market > 0) {
    if (drop != null && drop >= market * LIMIT_DROP_RANGE.min && drop <= market * LIMIT_DROP_RANGE.max) {
      return { amount: drop, method: 'available_limit', withinRange: true };
    }
    return { amount: Math.round(market * (1 + markup / 100)), method: 'markup', withinRange: drop == null ? null : false };
  }
  // No market rate to check against: the bank's own hold is still the best figure there is.
  if (drop != null && drop > 0) return { amount: drop, method: 'available_limit', withinRange: null };
  return null;
}

/** Whether the bank's merchant name is one of the foreign merchants that bill in EGP. */
export function isForeignEgpMerchant(counterparty: string | null | undefined, patterns: readonly string[] | null | undefined): boolean {
  if (!counterparty || !patterns?.length) return false;
  const name = counterparty.toUpperCase();
  return patterns.some((p) => p.trim() && name.includes(p.trim().toUpperCase()));
}

type Candidate = { id: string; amount: Minor };

/**
 * Which waiting record a limit gap belongs to, if that is unambiguous: the only waiting record on
 * the card, or the only one the gap plausibly fits (a small share of its amount, or exactly its
 * amount for a released hold). Null when nothing or more than one fits.
 */
export function pickGapTarget<T extends Candidate>(candidates: readonly T[], gap: Minor): T | null {
  const size = Math.abs(gap);
  // A released hold that equals one charge exactly is that charge, whatever else it might fit.
  const exact = gap < 0 ? candidates.filter((c) => c.amount === size) : [];
  if (exact.length === 1) return exact[0];
  const plausible = candidates.filter((c) => size <= c.amount * POSTING_ADJUSTMENT_MAX_SHARE);
  if (plausible.length !== 1) return null;
  return plausible[0];
}
