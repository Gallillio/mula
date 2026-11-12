import Papa from 'papaparse';

import type { Minor } from '../../shared/db/types';
import type { FeeRule } from '../../shared/settings/settingsStore';
import { instapayFee } from '../../transactions/utils/instapay';

/**
 * Reads transaction files downloaded from online banking (HSBC Egypt's "Download › Spreadsheet
 * (CSV)" for the current account and for credit cards) into bank-neutral rows. Matching rows
 * against records already in Mula, and saving them, happens in importStatement.ts.
 */

export type StatementKind =
  | 'purchase'
  | 'instapay_out'
  | 'instapay_in'
  | 'own_transfer_out'
  | 'own_transfer_in'
  | 'salary'
  | 'fee'
  | 'atm_withdrawal'
  | 'cash_deposit'
  | 'refund'
  | 'other_out'
  | 'other_in';

export type StatementRow = {
  index: number;
  /** Local time; noon when the bank gives only a day. */
  date: number;
  /** Positive, in the file's currency, fee included (as the bank charged it). */
  amount: Minor;
  direction: 'out' | 'in';
  currency: string;
  /** A foreign-currency card charge as the merchant billed it. */
  original: { amount: Minor; currency: string } | null;
  kind: StatementKind;
  counterparty: string | null;
  reference: string | null;
  /** Last digits of the other side when it is a card or account ("TO 5193 … 3104"). */
  otherDigits: string | null;
  /** InstaPay fee included in `amount` (outgoing InstaPay only). */
  fee: Minor | null;
  raw: string;
};

export type StatementFile = {
  bank: 'hsbc-eg';
  format: 'account' | 'card';
  /** The card's last 4 digits (card files name the card on every row). */
  accountDigits: string | null;
  rows: StatementRow[];
  /** Rows dropped because a later row cancelled them (ATM retries, reversed transfers). */
  cancelled: number;
  firstDate: number | null;
  lastDate: number | null;
};

const MONTHS: Record<string, number> = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

/** "06 Nov 2026" or "6 Nov 2026" → local noon. */
function dayDate(s: string): number | null {
  const m = s.trim().match(/^(\d{1,2})\s+([A-Za-z]{3})\w*\s+(\d{4})$/);
  if (!m) return null;
  const mo = MONTHS[m[2].toUpperCase()];
  return mo == null ? null : new Date(+m[3], mo, +m[1], 12, 0).getTime();
}

/** "20MAY26" (+ optional "16:29:41") → local time. */
function compactDate(s: string, time?: string): number | null {
  const m = s.match(/^(\d{2})([A-Z]{3})(\d{2})$/);
  if (!m) return null;
  const mo = MONTHS[m[2]];
  if (mo == null) return null;
  const [h, mi] = time ? time.split(':').map(Number) : [12, 0];
  return new Date(2000 + +m[3], mo, +m[1], h, mi).getTime();
}

function money(s: string | undefined): number | null {
  if (!s) return null;
  const v = s.replace(/[,\s]/g, '').replace(/^Cr/i, '');
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

const tidy = (s: string | undefined | null) => {
  const v = (s ?? '').replace(/\s+/g, ' ').trim();
  return v.length ? v : null;
};

/**
 * Splits an InstaPay total into principal + fee when the total is exactly "amount + fee" under
 * the fee rule (HSBC books them as one line: EGP 5,005.00 = 5,000 + 5 fee).
 */
export function splitInstapayFee(total: Minor, rule: FeeRule): { principal: Minor; fee: Minor } {
  let p = total - instapayFee(total, rule);
  for (let i = 0; i < 3; i++) {
    const f = instapayFee(p, rule);
    if (p + f === total) return { principal: p, fee: f };
    p = total - f;
  }
  return { principal: total, fee: 0 };
}

/** Which kind of file this is, from its first rows; null when it isn't a known statement. */
export function detectStatement(text: string): { bank: 'hsbc-eg'; format: 'account' | 'card' } | null {
  const rows = readRows(text).slice(0, 10);
  if (!rows.length) return null;
  if (rows.every((r) => r.length >= 4 && dayDate(r[0]) != null && dayDate(r[1]) != null)) return { bank: 'hsbc-eg', format: 'card' };
  if (rows.every((r) => r.length >= 3 && dayDate(r[0]) != null && money(r[r.length - 1]) != null)) return { bank: 'hsbc-eg', format: 'account' };
  return null;
}

function readRows(text: string): string[][] {
  const { data } = Papa.parse<string[]>(text.replace(/^﻿/, ''), { header: false, skipEmptyLines: true });
  return data.filter((r) => r.some((c) => c.trim()));
}

export function parseStatement(text: string, rule: FeeRule): StatementFile | null {
  const kind = detectStatement(text);
  if (!kind) return null;
  const rows = readRows(text);
  const parsed = kind.format === 'card' ? rows.map((r, i) => parseCardRow(r, i)) : rows.map((r, i) => parseAccountRow(r, i, rule));
  const valid = parsed.filter((r): r is StatementRow => r != null);
  const { kept, cancelled } = dropCancelled(valid);
  const digits = kind.format === 'card' ? (rows.map((r) => r[2]?.match(/^0?(\d{12})(\d{4})/)?.[2]).find(Boolean) ?? null) : null;
  const dates = kept.map((r) => r.date);
  return {
    ...kind,
    accountDigits: digits,
    rows: kept.sort((a, b) => a.date - b.date || a.index - b.index),
    cancelled,
    firstDate: dates.length ? Math.min(...dates) : null,
    lastDate: dates.length ? Math.max(...dates) : null,
  };
}

/* ---------- HSBC current account ---------- */

/** Reference ("0e3eb60f"), then the other side, then HSBC's own trace ("YFSB24639"). */
const IPN_TAIL = '([0-9a-fA-F]{8})(.*?)(?:YFS[A-Z]\\d+)?(?:SYSTEM GENERATED)?$';
const IPN_OUT = new RegExp(`^TRANSFERInstant Transfer to${IPN_TAIL}`);
const IPN_IN = new RegExp(`^TRANSFERInstant Transfer from${IPN_TAIL}`);
const IPN_PURCHASE = new RegExp(`^TRANSFERPurchase from${IPN_TAIL}`);
const TO_CARD = /^TRANSFER(?:PAY BY [\d-]+)?TO (\d{4}) ?(\d{4}) ?(\d{4}) ?(\d{4})/;
const SALARY = /^SALARY\s*TRANSFER FROM(.+?)SALARY/;
const CARD_TXN = /^CARD TRANSACTION(\d{2}[A-Z]{3}\d{2})\s*(.*)$/;

function parseAccountRow(r: string[], index: number, rule: FeeRule): StatementRow | null {
  const date = dayDate(r[0]);
  const signed = money(r[r.length - 1]);
  if (date == null || signed == null || signed === 0) return null;
  const desc = r.slice(1, -1).join(',').trim();
  const direction = signed < 0 ? 'out' : 'in';
  const amount = Math.abs(signed);
  const base = { index, date, amount, direction, currency: 'EGP', original: null, counterparty: null, reference: null, otherDigits: null, fee: null, raw: desc } as const;

  let m = desc.match(TO_CARD);
  if (m) return { ...base, kind: direction === 'out' ? 'own_transfer_out' : 'own_transfer_in', otherDigits: m[4] };

  m = desc.match(IPN_OUT);
  if (m && direction === 'out') {
    const { fee } = splitInstapayFee(amount, rule);
    const other = m[2].trim();
    // "…to0912f5ea0100": an account number's last digits instead of a name.
    if (/^\d{4}$/.test(other)) return { ...base, kind: 'own_transfer_out', reference: m[1], otherDigits: other, fee: fee || null };
    return { ...base, kind: 'instapay_out', reference: m[1], counterparty: tidy(other), fee: fee || null };
  }
  m = desc.match(IPN_IN);
  if (m) return { ...base, kind: 'instapay_in', reference: m[1], counterparty: tidy(m[2]) };
  m = desc.match(IPN_PURCHASE);
  if (m) return { ...base, kind: 'instapay_out', reference: m[1], counterparty: tidy(m[2]) };

  if (/^TFR REV/.test(desc)) {
    const ref = desc.match(/Rev([0-9a-fA-F]{8})/)?.[1] ?? null;
    return { ...base, kind: 'refund', reference: ref, counterparty: 'Reversed transfer' };
  }

  m = desc.match(SALARY);
  if (m && direction === 'in') return { ...base, kind: 'salary', counterparty: tidy(m[1]) };

  if (/^(SVC CHG|CHARGES)/.test(desc)) {
    const what = tidy(desc.replace(/^(SVC CHG|CHARGES)/, '').replace(/[A-Z]{2,4}\d{5,}.*$/, '').replace(/SYSTEM GENERATED$/, ''));
    return { ...base, kind: direction === 'out' ? 'fee' : 'refund', counterparty: 'HSBC', reference: what };
  }

  m = desc.match(CARD_TXN);
  if (m) {
    const rest = m[2];
    // Debit card purchase: "V DEBIT003931EGP      1315.10PAYMOB*MEAT PARTY FOA89588979ATM"
    const pos = rest.match(/^V DEBIT\d+([A-Z]{3})\s*([\d.,]+)(.+?)A\d{6,}ATM$/);
    if (pos) {
      return {
        ...base,
        date: compactDate(m[1]) ?? date,
        kind: direction === 'out' ? 'purchase' : 'refund',
        counterparty: tidy(pos[3]),
        original: pos[1] !== 'EGP' ? { amount: money(pos[2]) ?? amount, currency: pos[1] } : null,
      };
    }
    // ATM: "ATMA475 16:29:41A47500028ATM" (HSBC machine) or "LOCAL   16:41:38BM MADINTY ELEC. BRA89813574ATM".
    const atm = rest.match(/^(?:ATM(A\d+)|LOCAL)\s+(\d{2}:\d{2}:\d{2})(.*?)A\d{6,}ATM$/);
    const where = tidy(atm ? atm[3] || (atm[1] ? `HSBC ATM ${atm[1]}` : '') : null) ?? 'ATM';
    return {
      ...base,
      date: compactDate(m[1], atm?.[2]) ?? date,
      kind: direction === 'out' ? 'atm_withdrawal' : 'cash_deposit',
      counterparty: where,
    };
  }

  return { ...base, kind: direction === 'out' ? 'other_out' : 'other_in', counterparty: tidy(desc.replace(/SYSTEM GENERATED$/, '')) };
}

/* ---------- HSBC credit card ---------- */

function parseCardRow(r: string[], index: number): StatementRow | null {
  const date = dayDate(r[0]) ?? dayDate(r[1]);
  const signed = money(r[r.length - 1]);
  if (date == null || signed == null || signed === 0) return null;
  const desc = r.slice(2, -1).join(',');
  const direction = signed < 0 ? 'out' : 'in';
  const amount = Math.abs(signed);
  const body = desc.replace(/^0?\d{16}/, '');
  const base = { index, date, amount, direction, currency: 'EGP', original: null, counterparty: null, reference: null, otherDigits: null, fee: null, raw: desc.trim() } as const;

  const payment = body.match(/TO (\d{4}) ?(\d{4}) ?(\d{4}) ?(\d{4})/);
  if (payment && direction === 'in') return { ...base, kind: 'own_transfer_in', otherDigits: null, counterparty: 'Card payment' };
  if (/cash ?back/i.test(body) && direction === 'in') return { ...base, kind: 'refund', counterparty: 'HSBC Cashback' };

  // "APPLE.COM/US           CUPERTINO     CAUSAUSD -99.00USD -99.00": merchant, city, country, original amount.
  const fx = body.match(/([A-Z]{3})\s*-?([\d.,]+)[A-Z]{3}\s*-?[\d.,]+\s*$/);
  const head = fx ? body.slice(0, fx.index) : body;
  const merchant = tidy(head.split(/\s{2,}/)[0]);
  const original = fx && fx[1] !== 'EGP' ? { amount: money(fx[2]) ?? amount, currency: fx[1] } : null;
  return { ...base, kind: direction === 'out' ? 'purchase' : 'refund', counterparty: merchant, original };
}

/* ---------- rows that cancel out ---------- */

/**
 * Drops pairs the bank booked and then undid: an ATM withdrawal followed by the same amount back
 * at the same machine minutes later, and an InstaPay transfer followed by its reversal.
 */
export function dropCancelled(rows: StatementRow[]): { kept: StatementRow[]; cancelled: number } {
  const drop = new Set<number>();
  const byTime = [...rows].sort((a, b) => a.date - b.date);
  for (const r of byTime) {
    if (drop.has(r.index)) continue;
    const reversesCash = (r.kind === 'cash_deposit' || r.kind === 'atm_withdrawal') && r.counterparty !== null;
    const reversesTransfer = r.kind === 'refund' && r.counterparty === 'Reversed transfer';
    if (!reversesCash && !reversesTransfer) continue;
    const partner = byTime.find(
      (o) =>
        !drop.has(o.index) &&
        o.index !== r.index &&
        o.amount === r.amount &&
        o.direction !== r.direction &&
        (reversesTransfer
          ? (o.kind === 'instapay_out' || o.kind === 'own_transfer_out') && Math.abs(o.date - r.date) <= 3 * 86_400_000
          : (o.kind === 'atm_withdrawal' || o.kind === 'cash_deposit') && o.counterparty === r.counterparty && Math.abs(o.date - r.date) <= 15 * 60_000),
    );
    if (partner) {
      drop.add(r.index);
      drop.add(partner.index);
    }
  }
  return { kept: rows.filter((r) => !drop.has(r.index)), cancelled: drop.size };
}
