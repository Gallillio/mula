import { findAccountByIdentifier } from '../../accounts/data/accountsRepo';
import { all, first, write } from '../../shared/db/client';
import type { Account, FxMethod, ID, LimitCheck, Minor, ParsedMessage } from '../../shared/db/types';
import { getSettings } from '../../shared/settings/settingsStore';
import { isoDay } from '../../shared/utils/dates';
import { formatMoney } from '../../shared/utils/money';
import { adjustBankAmount, appendBankNote, listAwaitingFinal } from '../../transactions/data/transactionsRepo';
import { LIMIT_DROP_RANGE, LIMIT_GAP_MAX_AGE_MS, decideFxAmount, markupPercent, pickGapTarget } from '../utils/cardFx';
import { parseBankSms } from '../utils/parser';

/**
 * The database side of card charges the bank settles later (rules in ../utils/cardFx.ts). Card
 * messages that report the available limit (HSBC Egypt credit cards) are read against the card's
 * previous message: for a charge in another currency the drop is the bank's own EGP amount, and
 * for an EGP charge any extra drop is the bank silently posting an earlier charge.
 */

export type LimitReading = { itemId: ID; limit: Minor; currency: string; at: number };

type LimitRow = { id: string; raw_text: string; parsed: string | null; received_at: number };

function limitOf(row: LimitRow): { limit: Minor; currency: string } | null {
  try {
    const p = row.parsed ? (JSON.parse(row.parsed) as ParsedMessage) : null;
    if (p?.availableLimit != null && p.availableLimitCurrency) return { limit: p.availableLimit, currency: p.availableLimitCurrency };
  } catch {
    // Fall back to reading the text.
  }
  // Messages stored before Mula kept the limit: read it from the text again.
  const r = parseBankSms(row.raw_text, row.received_at);
  if (r.status === 'transaction' && r.parsed.availableLimit != null && r.parsed.availableLimitCurrency) {
    return { limit: r.parsed.availableLimit, currency: r.parsed.availableLimitCurrency };
  }
  return null;
}

/** The latest bank message for this card, before `before`, whose available limit can be read. */
export async function previousLimit(last4: string, before: number, exceptId: ID): Promise<LimitReading | null> {
  const rows = await all<LimitRow>(
    `SELECT id, raw_text, parsed, received_at FROM inbox_items
      WHERE id != ? AND received_at < ? AND source IN ('sms', 'paste') AND parsed IS NOT NULL AND json_extract(parsed, '$.last4') = ?
      ORDER BY received_at DESC LIMIT 20`,
    [exceptId, before, last4],
  );
  for (const row of rows) {
    const l = limitOf(row);
    if (l) return { itemId: row.id, ...l, at: row.received_at };
  }
  return null;
}

/** Payments to the card and credits on it (refunds, cashback) recorded in (from, to]. */
export async function creditsBetween(accountId: ID, from: number, to: number): Promise<Minor> {
  const r = await first<{ n: number }>(
    `SELECT COALESCE(SUM(CASE WHEN type = 'transfer' THEN COALESCE(to_amount, amount) ELSE amount END), 0) AS n
       FROM transactions
      WHERE parent_id IS NULL AND date > ? AND date <= ?
        AND ((type = 'transfer' AND to_account_id = ?) OR (type = 'income' AND account_id = ?))`,
    [from, to, accountId, accountId],
  );
  return r?.n ?? 0;
}

const money = (minor: Minor, currency?: string) => formatMoney(minor, currency ? { currency } : {});

export type ForeignCharge = { amount: Minor; method: FxMethod; notes: string[] };

/**
 * The account-currency amount for a card charge in another currency, from a message that reports
 * the available limit. `market` is the market conversion (null without a rate). Null when there is
 * neither a usable limit drop nor a rate.
 */
export async function foreignChargeAmount(itemId: ID, p: ParsedMessage, account: Account, at: number, market: Minor | null): Promise<ForeignCharge | null> {
  const ccy = account.currency;
  const markup = markupPercent(getSettings().cardFxMarkup, p.currency);
  let drop: Minor | null = null;
  let how = '';
  if (p.last4 && p.availableLimit != null && p.availableLimitCurrency === ccy) {
    const prev = await previousLimit(p.last4, at, itemId);
    if (prev && prev.currency === ccy) {
      const credits = await creditsBetween(account.id, prev.at, at);
      drop = prev.limit - p.availableLimit + credits;
      how = `available limit ${money(prev.limit)} → ${money(p.availableLimit)}${credits ? ` with ${money(credits)} paid in` : ''}`;
    } else {
      how = 'no earlier message with this card’s limit';
    }
  }
  const d = decideFxAmount({ drop, market, markup });
  if (!d) return null;
  const charged = money(p.amount, p.currency);
  const marketText = market != null ? `market ${money(market, ccy)}` : 'no market rate to check against';
  const notes: string[] = [];
  if (d.method === 'available_limit') {
    const ratio = market ? ` (${(d.amount / market).toFixed(3)}× market)` : '';
    notes.push(`${charged} held as ${money(d.amount, ccy)} from the drop in the card’s ${how}; ${marketText}${ratio}`);
  } else {
    const why =
      drop == null
        ? how || 'the message has no available limit'
        : `limit drop ${money(drop, ccy)} (${how}) is outside ${LIMIT_DROP_RANGE.min}–${LIMIT_DROP_RANGE.max}× market`;
    notes.push(`${charged} booked as ${marketText} + ${markup}% mark-up = ${money(d.amount, ccy)}; ${why}`);
  }
  return { amount: d.amount, method: d.method, notes };
}

/**
 * Runs once, when an EGP card message arrives: if the available limit fell by more (or less) than
 * this message's amount, the difference is the bank posting (or releasing) an earlier charge. A
 * positive gap is added to the waiting record it unambiguously belongs to, which keeps waiting; a
 * negative one is only noted. The finding is kept on the message for its own record's notes.
 */
export async function checkLimitGap(itemId: ID): Promise<LimitCheck | null> {
  const row = await first<LimitRow & { source: string }>('SELECT id, raw_text, parsed, received_at, source FROM inbox_items WHERE id = ?', [itemId]);
  if (!row?.parsed || (row.source !== 'sms' && row.source !== 'paste')) return null;
  const p = JSON.parse(row.parsed) as ParsedMessage;
  if (p.kind !== 'card_purchase' || !p.last4 || p.availableLimit == null) return null;
  const account = await findAccountByIdentifier(p.last4);
  if (!account || p.currency !== account.currency || p.availableLimitCurrency !== account.currency) return null;

  const at = row.received_at;
  const prev = await previousLimit(p.last4, at, itemId);
  if (!prev || prev.currency !== account.currency || at - prev.at > LIMIT_GAP_MAX_AGE_MS) return null;
  const credits = await creditsBetween(account.id, prev.at, at);
  const expected = prev.limit - p.amount + credits;
  const gap = expected - p.availableLimit;
  if (gap === 0) return null;

  const ccy = account.currency;
  const day = isoDay(at);
  const after = `after ${p.counterparty ?? 'a card payment'} ${money(p.amount, ccy)} on ${day}`;
  const candidates = await listAwaitingFinal(account.id, at);
  const target = pickGapTarget(candidates, gap);
  const label = (t: { amount: Minor; originalAmount: number | null; originalCurrency: string | null; date: number }) =>
    `${t.originalCurrency && t.originalAmount != null ? money(t.originalAmount, t.originalCurrency) : money(t.amount, ccy)} on ${isoDay(t.date)}`;

  let note: string;
  if (target && gap > 0) {
    await adjustBankAmount(
      target.id,
      gap,
      `${day}: the bank posted ${money(gap, ccy)} more (available limit ${after} was lower than expected); now ${money(target.amount + gap, ccy)}, still awaiting the final amount`,
    );
    note = `Available limit was ${money(gap, ccy)} lower than expected: added to the charge of ${label(target)} as the bank’s posting adjustment`;
  } else if (target) {
    await appendBankNote(
      target.id,
      `${day}: available limit ${after} was ${money(-gap, ccy)} higher than expected; a hold may have been released. Amount not changed, please review`,
    );
    note = `Available limit was ${money(-gap, ccy)} higher than expected (a released hold?); noted on the charge of ${label(target)}`;
  } else {
    const direction = gap > 0 ? 'lower' : 'higher';
    note = `Available limit was ${money(Math.abs(gap), ccy)} ${direction} than expected (expected ${money(expected)}, reported ${money(p.availableLimit)})${
      candidates.length ? `; could belong to one of ${candidates.length} charges awaiting the final amount, nothing changed` : '; nothing is awaiting a final amount on this card'
    }`;
    for (const c of candidates) {
      await appendBankNote(c.id, `${day}: unexplained ${money(Math.abs(gap), ccy)} available-limit gap (${direction}) ${after}; may belong to this charge`);
    }
  }

  const check: LimitCheck = { gap, appliedTo: target?.id ?? null, note };
  await write(['inbox_items'], 'UPDATE inbox_items SET parsed = ? WHERE id = ?', [JSON.stringify({ ...p, limitCheck: check }), itemId]);
  return check;
}
