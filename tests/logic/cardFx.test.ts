/**
 * Foreign-currency card charges HSBC settles later, on a real SQLite database: the amount from the
 * drop in the card's available limit (the user's real texts), the market-plus-mark-up fallback,
 * the "awaiting final amount" flag and when it clears, and silent posting adjustments revealed by
 * the next EGP text.
 */
import { saveAccount } from '../../src/modules/accounts/data/accountsRepo';
import { buildSuggestion, confirmItem, getInboxItem, ingestSms } from '../../src/modules/inbox/data/inboxRepo';
import { LIMIT_DROP_RANGE, decideFxAmount, isForeignEgpMerchant, markupPercent, pickGapTarget } from '../../src/modules/inbox/utils/cardFx';
import { parseBankSms } from '../../src/modules/inbox/utils/parser';
import { all, run } from '../../src/modules/shared/db/client';
import { bootstrap } from '../../src/modules/shared/db/bootstrap';
import { SYSTEM_CATEGORIES } from '../../src/modules/shared/db/seeds/categories';
import type { Transaction } from '../../src/modules/shared/db/types';
import { getSettings, setSetting } from '../../src/modules/shared/settings/settingsStore';
import { createTransaction, getTransaction, listTransactions, updateTransaction } from '../../src/modules/transactions/data/transactionsRepo';
import type { TxInput } from '../../src/modules/transactions/types';

type MockStmt = { all: (...p: unknown[]) => unknown[]; run: (...p: unknown[]) => { changes: number; lastInsertRowid: number } };
type MockNodeDb = { exec: (s: string) => void; prepare: (s: string) => MockStmt };
type MockNodeSqlite = { DatabaseSync: new (path: string) => MockNodeDb };

jest.mock('expo-sqlite', () => {
  const { DatabaseSync } = (process as unknown as { getBuiltinModule: (m: string) => MockNodeSqlite }).getBuiltinModule('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const args = (p?: unknown[]) => (p ?? []).map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
  const api = {
    execAsync: async (sql: string) => db.exec(sql.replace(/PRAGMA journal_mode = WAL;/, '')),
    getAllAsync: async (sql: string, p?: unknown[]) => db.prepare(sql).all(...args(p)),
    getFirstAsync: async (sql: string, p?: unknown[]) => db.prepare(sql).all(...args(p))[0] ?? null,
    runAsync: async (sql: string, p?: unknown[]) => {
      const r = db.prepare(sql).run(...args(p));
      return { changes: r.changes, lastInsertRowId: Number(r.lastInsertRowid) };
    },
    withTransactionAsync: async (fn: () => Promise<void>) => {
      db.exec('BEGIN');
      try {
        await fn();
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
  return { openDatabaseAsync: async () => api };
});
jest.mock('expo-crypto', () => ({ randomUUID: () => `id-${Math.random().toString(36).slice(2)}` }));

// Market rates below what HSBC charges, as in real life (its texts imply ~55.4 EGP per USD, ~75.3 per GBP).
const fx = { offline: false };
const RATES: Record<string, number> = { 'USD-EGP': 50, 'GBP-EGP': 66, 'AED-EGP': 13.6 };
jest.mock('../../src/modules/integrations/utils/fx', () => {
  const getRate = async (from: string, to: string) => (from === to ? 1 : fx.offline ? null : (RATES[`${from}-${to}`] ?? null));
  return {
    getRate,
    convert: async (minor: number, from: string, to: string) => {
      const rate = await getRate(from, to);
      return rate == null ? null : { amount: Math.round(minor * rate), rate };
    },
    refreshTodayRates: async () => undefined,
  };
});

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = new Date(2026, 10, 3, 10, 0).getTime();

const card = (last4: string, ccy: string, amount: string, merchant: string, limit: string) =>
  `Your Credit Card ending with *** ${last4} has been used for ${ccy} ${amount} on 03/11/2026 at ${merchant}. Your available limit is EGP ${limit}`;

const account = (name: string, type: 'card' | 'bank', identifiers: string[]) =>
  saveAccount({ name, type, currency: 'EGP', initialBalance: 0, color: '#2F45D0', icon: 'credit-card', defaultPaymentType: 'credit_card', identifiers, excludeFromStats: false, archived: false });

let payroll: string;
let mastercard: string;

/** Ingests a text and files its suggestion, like a swipe in the review inbox. */
async function receive(text: string, at: number): Promise<{ itemId: string; tx: Transaction }> {
  const r = await ingestSms(text, 'sms', at, 'HSBC');
  if (r.result !== 'added') throw new Error(`not added: ${JSON.stringify(r)}`);
  const item = (await getInboxItem(r.id))!;
  const s = await buildSuggestion(item);
  const txId = await confirmItem(item.id, { ...(s.draft as TxInput), categoryId: SYSTEM_CATEGORIES.missing });
  return { itemId: item.id, tx: (await getTransaction(txId))! };
}

const payment = (amount: number, to: string, at: number) =>
  createTransaction({ type: 'transfer', amount, accountId: payroll, toAccountId: to, paymentType: 'bank_transfer', date: at });

beforeAll(async () => {
  await bootstrap();
  payroll = await account('Payroll Debit', 'bank', ['6001']);
  mastercard = await account('Mastercard Credit', 'card', ['3104']);
});

beforeEach(() => {
  fx.offline = false;
});

describe('rules', () => {
  it('uses the limit drop only within 0.95–1.20× the market conversion, else market plus mark-up', () => {
    expect(decideFxAmount({ drop: 27705, market: 25000, markup: 3 })).toEqual({ amount: 27705, method: 'available_limit', withinRange: true });
    expect(decideFxAmount({ drop: 25000 * LIMIT_DROP_RANGE.max + 1, market: 25000, markup: 3 })).toEqual({ amount: 25750, method: 'markup', withinRange: false });
    expect(decideFxAmount({ drop: 23000, market: 25000, markup: 6 })).toEqual({ amount: 26500, method: 'markup', withinRange: false });
    expect(decideFxAmount({ drop: null, market: 25000, markup: 3 })).toEqual({ amount: 25750, method: 'markup', withinRange: null });
    expect(decideFxAmount({ drop: 27705, market: null, markup: 3 })).toEqual({ amount: 27705, method: 'available_limit', withinRange: null });
    expect(decideFxAmount({ drop: null, market: null, markup: 3 })).toBeNull();
  });

  it('looks up mark-ups by currency with "other" as the fallback', () => {
    const table = getSettings().cardFxMarkup;
    expect(table).toEqual({ USD: 3, GBP: 6, other: 3 });
    expect(markupPercent(table, 'USD')).toBe(3);
    expect(markupPercent(table, 'gbp')).toBe(6);
    expect(markupPercent(table, 'AED')).toBe(3);
    expect(markupPercent({}, 'EUR')).toBe(0);
  });

  it('recognizes foreign merchants that bill in EGP', () => {
    expect(isForeignEgpMerchant('REGUS BUSINESS CENTRE', ['REGUS'])).toBe(true);
    expect(isForeignEgpMerchant('Regus Business Centre', ['regus'])).toBe(true);
    expect(isForeignEgpMerchant('TALABAT', ['REGUS'])).toBe(false);
    expect(isForeignEgpMerchant(null, ['REGUS'])).toBe(false);
  });

  it('matches a gap only to the one waiting record it plausibly fits', () => {
    const scifier = { id: 's', amount: 4438335 };
    const railway = { id: 'r', amount: 27705 };
    const apple = { id: 'a', amount: 548559 };
    expect(pickGapTarget([scifier, railway, apple], 85803)?.id).toBe('s');
    expect(pickGapTarget([railway], 85803)).toBeNull(); // 3× the charge: not a posting adjustment
    expect(pickGapTarget([railway, apple], 1648)).toBeNull(); // fits both: ambiguous
    expect(pickGapTarget([railway, apple], -27705)?.id).toBe('r'); // a whole hold released
    expect(pickGapTarget([], 100)).toBeNull();
  });

  it('reads the available limit from HSBC card texts', () => {
    const r = parseBankSms('Your Credit Card ending with *** 3104 has been used for USD 114.00 on 09/11/2026 at ANTHROPIC* CLAUDE SUB. Your available limit is EGP 117322.40', T0, { sender: 'HSBC' });
    expect(r).toMatchObject({ status: 'transaction', parsed: { kind: 'card_purchase', amount: 11400, currency: 'USD', last4: '3104', counterparty: 'ANTHROPIC* CLAUDE SUB', availableLimit: 11732240, availableLimitCurrency: 'EGP', balance: null } });
  });
});

describe('your HSBC texts', () => {
  // One timeline on card 3104: (c), then (a) and (b), then the Talabat text that reveals SciFier posting.
  let scifier: Transaction;
  let railway: Transaction;
  let apple: Transaction;

  it('(c) Rabbit EGP 384.54 → SciFier GBP 589.22 is EGP 44,383.35', async () => {
    const rabbit = await receive(card('3104', 'EGP', '384.54', 'RABBIT', '127215.26'), T0);
    expect(rabbit.tx).toMatchObject({ amount: 38454, fxMethod: null, awaitingFinal: false, bankNotes: [] });
    ({ tx: scifier } = await receive(card('3104', 'GBP', '589.22', 'SCIFIER', '82831.91'), T0 + HOUR));
    expect(scifier).toMatchObject({ amount: 4438335, currency: 'EGP', originalAmount: 58922, originalCurrency: 'GBP', fxMethod: 'available_limit', awaitingFinal: true });
    expect(scifier.fxRate).toBeCloseTo(4438335 / 58922, 8);
    expect(scifier.bankNotes[0]).toMatch(/GBP 589\.22 held as EGP 44,383\.35/);
  });

  it('(a) Talabat EGP 189.99 → Railway USD 5.00 is EGP 277.05', async () => {
    // A payment between SciFier and this Talabat text explains the higher limit, so no gap here.
    await payment(119901, mastercard, T0 + 2 * HOUR);
    const talabat = await receive(card('3104', 'EGP', '189.99', 'TALABAT', '83840.93'), T0 + 3 * HOUR);
    expect(talabat.tx.bankNotes).toEqual([]);
    ({ tx: railway } = await receive(card('3104', 'USD', '5.00', 'RAILWAY', '83563.88'), T0 + 4 * HOUR));
    expect(railway).toMatchObject({ amount: 27705, originalAmount: 500, originalCurrency: 'USD', fxMethod: 'available_limit', awaitingFinal: true });
  });

  it('(b) the next text, Apple.com/US USD 99.00, is EGP 5,485.59', async () => {
    ({ tx: apple } = await receive(card('3104', 'USD', '99.00', 'APPLE.COM/US', '78078.29'), T0 + 5 * HOUR));
    expect(apple).toMatchObject({ amount: 548559, originalAmount: 9900, fxMethod: 'available_limit', awaitingFinal: true });
  });

  it('Talabat EGP 189.99 with the limit 858.03 lower than expected: SciFier posts at 45,241.38', async () => {
    const talabat = await receive(card('3104', 'EGP', '189.99', 'TALABAT', '77030.27'), T0 + 6 * HOUR);
    const item = await getInboxItem(talabat.itemId);
    expect(item?.parsed?.limitCheck).toMatchObject({ gap: 85803, appliedTo: scifier.id });
    expect(talabat.tx.amount).toBe(18999);
    expect(talabat.tx.awaitingFinal).toBe(false);
    expect(talabat.tx.bankNotes[0]).toMatch(/858\.03 lower than expected: added to the charge of GBP 589\.22/);

    const after = (await getTransaction(scifier.id))!;
    expect(after).toMatchObject({ amount: 4524138, awaitingFinal: true, originalAmount: 58922, originalCurrency: 'GBP', fxMethod: 'available_limit' });
    expect(after.baseAmount).toBe(4524138);
    expect(after.fxRate).toBeCloseTo(4524138 / 58922, 8);
    expect(after.bankNotes[1]).toMatch(/posted EGP 858\.03 more.*now EGP 45,241\.38, still awaiting/);
    // The others are untouched.
    expect((await getTransaction(railway.id))?.amount).toBe(27705);
    expect((await getTransaction(apple.id))?.amount).toBe(548559);
  });

  it('lists the records still awaiting the final amount', async () => {
    const waiting = await listTransactions({ awaitingFinal: true });
    expect(waiting.map((t) => t.id).sort()).toEqual([scifier.id, railway.id, apple.id].sort());
  });

  it('editing the amount clears the flag, keeps what was charged and notes it; other edits keep it', async () => {
    const t = (await getTransaction(apple.id))!;
    const base: TxInput = { type: 'expense', amount: t.amount, accountId: t.accountId, categoryId: SYSTEM_CATEGORIES.missing, paymentType: t.paymentType, date: t.date, original: { amount: 9900, currency: 'USD', rate: t.fxRate! } };
    await updateTransaction(apple.id, { ...base, note: 'App Store' });
    expect(await getTransaction(apple.id)).toMatchObject({ amount: 548559, awaitingFinal: true, fxMethod: 'available_limit', note: 'App Store' });

    await updateTransaction(apple.id, { ...base, amount: 550128, original: { amount: 9900, currency: 'USD', rate: 550128 / 9900 } });
    const settled = (await getTransaction(apple.id))!;
    expect(settled).toMatchObject({ amount: 550128, awaitingFinal: false, originalAmount: 9900, originalCurrency: 'USD', fxMethod: 'available_limit' });
    expect(settled.bankNotes[settled.bankNotes.length - 1]).toMatch(/amount changed from EGP 5,485\.59 to EGP 5,501\.28, taken as the final amount/);
  });
});

describe('the Anthropic charge', () => {
  let visa: string;
  beforeAll(async () => {
    visa = await account('Second card', 'card', ['7001']);
  });

  it('(d) Rabbit EGP 347.94, a 46,940 payment, then Anthropic USD 114.00 is EGP 6,141.18', async () => {
    const t = T0 + 2 * 86_400_000;
    await receive(card('7001', 'EGP', '347.94', 'RABBIT', '76523.58'), t);
    await payment(4694000, visa, t + HOUR);
    const { tx } = await receive(card('7001', 'USD', '114.00', 'ANTHROPIC* CLAUDE SUB', '117322.40'), t + 2 * HOUR);
    expect(tx).toMatchObject({ amount: 614118, originalAmount: 11400, originalCurrency: 'USD', fxMethod: 'available_limit', awaitingFinal: true });
    expect(tx.bankNotes[0]).toMatch(/76,523\.58 → 117,322\.40 with 46,940\.00 paid in/);
  });
});

describe('fallbacks and flags', () => {
  let cardId: string;
  const day = T0 + 4 * 86_400_000;
  beforeAll(async () => {
    cardId = await account('Third card', 'card', ['7002']);
    await account('Fourth card', 'card', ['7003']);
    await account('Fifth card', 'card', ['7004']);
    await account('Sixth card', 'card', ['7005']);
  });

  it('without an earlier text, books market plus the USD mark-up', async () => {
    const { tx } = await receive(card('7002', 'USD', '10.00', 'GITHUB', '50000.00'), day);
    expect(tx).toMatchObject({ amount: 51500, originalAmount: 1000, fxMethod: 'markup', awaitingFinal: true });
    expect(tx.bankNotes[0]).toMatch(/market EGP 500\.00 \+ 3% mark-up = EGP 515\.00; no earlier message/);
  });

  it('with a limit drop outside the range, books market plus the GBP mark-up', async () => {
    // Drop 49,000 − 47,000 = 2,000 against a market 660.00: far outside 0.95–1.20×.
    await receive(card('7002', 'EGP', '1.00', 'SHOP', '49000.00'), day + HOUR);
    const { tx } = await receive(card('7002', 'GBP', '10.00', 'BOOKS UK', '47000.00'), day + 2 * HOUR);
    expect(tx).toMatchObject({ amount: 69960, fxMethod: 'markup', awaitingFinal: true });
    expect(tx.bankNotes[0]).toMatch(/outside 0\.95–1\.2× market/);
  });

  it('uses the mark-up settings', async () => {
    await setSetting('cardFxMarkup', { USD: 3, GBP: 6, other: 5 });
    const { tx } = await receive(card('7003', 'AED', '100.00', 'DUBAI SHOP', '1000.00'), day + 3 * HOUR);
    // AED 100 at 13.60 = 1,360.00, plus "other" 5%.
    expect(tx).toMatchObject({ amount: 142800, originalCurrency: 'AED', fxMethod: 'markup', awaitingFinal: true });
    await setSetting('cardFxMarkup', { USD: 3, GBP: 6, other: 3 });
  });

  it('flags foreign merchants billing in EGP without converting', async () => {
    const regus = await receive(card('7002', 'EGP', '1529.08', 'REGUS BUSINESS CENTRE', '45470.92'), day + 4 * HOUR);
    expect(regus.tx).toMatchObject({ amount: 152908, fxMethod: null, awaitingFinal: true });
    expect(regus.tx.bankNotes[0]).toMatch(/Merchant abroad billing in EGP/);
  });

  it('a negative gap only adds a note', async () => {
    // Expected 45,470.92 − 100.00 = 45,370.92; reported 45,400.00 → 29.08 higher (released hold).
    const waitingBefore = await listTransactions({ awaitingFinal: true, accountId: cardId });
    const { itemId, tx } = await receive(card('7002', 'EGP', '100.00', 'CAFE', '45400.00'), day + 5 * HOUR);
    const check = (await getInboxItem(itemId))?.parsed?.limitCheck;
    expect(check?.gap).toBe(-2908);
    expect(tx.bankNotes[0]).toMatch(/29\.08 higher than expected/);
    const waitingAfter = await listTransactions({ awaitingFinal: true, accountId: cardId });
    expect(waitingAfter.map((t) => t.amount)).toEqual(waitingBefore.map((t) => t.amount));
  });

  it('an ambiguous gap changes nothing and notes the candidates', async () => {
    // 30.00 is a plausible adjustment of the 515.00, 699.60 and 1,529.08 records alike.
    const before = await listTransactions({ awaitingFinal: true, accountId: cardId });
    const { itemId } = await receive(card('7002', 'EGP', '50.00', 'KIOSK', '45320.00'), day + 6 * HOUR);
    const check = (await getInboxItem(itemId))?.parsed?.limitCheck;
    expect(check).toMatchObject({ gap: 3000, appliedTo: null });
    const after = await listTransactions({ awaitingFinal: true, accountId: cardId });
    expect(after.map((t) => t.amount)).toEqual(before.map((t) => t.amount));
    expect(after.every((t) => t.bankNotes.some((n) => /unexplained EGP 30\.00 available-limit gap/.test(n)))).toBe(true);
  });

  it('reads the limit of texts stored before Mula kept it', async () => {
    const first = await receive(card('7004', 'EGP', '10.00', 'OLD SHOP', '20000.00'), day + 7 * HOUR);
    await run("UPDATE inbox_items SET parsed = json_remove(parsed, '$.availableLimit', '$.availableLimitCurrency') WHERE id = ?", [first.itemId]);
    const { tx } = await receive(card('7004', 'USD', '2.00', 'NEW SHOP', '19889.00'), day + 8 * HOUR);
    expect(tx).toMatchObject({ amount: 11100, fxMethod: 'available_limit' });
  });

  it('confirming from the form keeps the flag; a different amount makes it final', async () => {
    const r1 = await ingestSms(card('7005', 'USD', '1.00', 'FORM SHOP', '1000.00'), 'sms', day + 9 * HOUR, 'HSBC');
    const r2 = await ingestSms(card('7005', 'USD', '3.00', 'FORM SHOP', '840.00'), 'sms', day + 10 * HOUR, 'HSBC');
    if (r1.result !== 'added' || r2.result !== 'added') throw new Error('not added');
    const s1 = await buildSuggestion((await getInboxItem(r1.id))!);
    const form = (s: typeof s1, amount: number): TxInput => ({ type: 'expense', amount, accountId: s.draft.accountId!, categoryId: SYSTEM_CATEGORIES.missing, paymentType: 'credit_card', date: s.draft.date, original: s.original });
    const kept = (await getTransaction(await confirmItem(r1.id, form(s1, s1.draft.amount + 1))))!;
    expect(kept).toMatchObject({ amount: s1.draft.amount, awaitingFinal: true, fxMethod: 'markup' });

    const s2 = await buildSuggestion((await getInboxItem(r2.id))!);
    expect(s2.draft).toMatchObject({ amount: 16000, fxMethod: 'available_limit' });
    const final = (await getTransaction(await confirmItem(r2.id, form(s2, 16500))))!;
    expect(final).toMatchObject({ amount: 16500, awaitingFinal: false, fxMethod: null });
    expect(final.bankNotes[final.bankNotes.length - 1]).toMatch(/entered by hand when confirming \(Mula suggested 160\.00\)/);
  });

  it('syncs the new settings', async () => {
    await run('DELETE FROM sync_outbox');
    await setSetting('foreignEgpMerchants', ['REGUS', 'WEWORK']);
    await setSetting('lastAccountId', cardId);
    const rows = await all<{ pk: string }>("SELECT pk FROM sync_outbox WHERE tbl = 'settings'");
    expect(rows.map((r) => r.pk)).toEqual(['foreignEgpMerchants']);
  });
});
