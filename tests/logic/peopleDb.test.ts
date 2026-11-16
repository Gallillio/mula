/**
 * "Spent with" people on a real SQLite database: migration 4's column, saving and editing the
 * list, the inbox confirm path, filters and search, and payee merge/delete keeping lists clean.
 */
import { saveAccount } from '../../src/modules/accounts/data/accountsRepo';
import { confirmItem, ingestSms } from '../../src/modules/inbox/data/inboxRepo';
import { deletePayee, findOrCreatePayee, getPayeeUsage, mergePayees, suggestedPeople } from '../../src/modules/payees/data/payeesRepo';
import { all } from '../../src/modules/shared/db/client';
import { bootstrap } from '../../src/modules/shared/db/bootstrap';
import { SYSTEM_CATEGORIES } from '../../src/modules/shared/db/seeds/categories';
import {
  createTransaction,
  getSpentTogether,
  getTransaction,
  listTransactions,
  parsePeople,
  peopleJson,
  updateTransaction,
} from '../../src/modules/transactions/data/transactionsRepo';

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

let account: string;
let jana: string;
let khaled: string;
let feky: string;

beforeAll(async () => {
  await bootstrap();
  account = await saveAccount({
    name: 'Payroll Debit', type: 'bank', currency: 'EGP', initialBalance: 0, color: '#2F45D0', icon: 'landmark',
    defaultPaymentType: 'debit_card', identifiers: ['9999'], excludeFromStats: false, archived: false,
  });
  jana = (await findOrCreatePayee('Test Person A', 'person')).id;
  khaled = (await findOrCreatePayee('Test Person B', 'person')).id;
  feky = (await findOrCreatePayee('Test Person C', 'person')).id;
});

const expense = (amount: number, people?: string[] | null) =>
  createTransaction({ type: 'expense', amount, accountId: account, categoryId: SYSTEM_CATEGORIES.missing, paymentType: 'debit_card', date: Date.now(), people });

it('stores ids unique, and nothing when it was just you', () => {
  expect(peopleJson(['a', 'b', 'a', ''])).toBe('["a","b"]');
  expect(peopleJson([])).toBeNull();
  expect(peopleJson(null)).toBeNull();
  expect(parsePeople('not json')).toEqual([]);
  expect(parsePeople(null)).toEqual([]);
});

it('saves who you spent with, keeps it on edits that don’t mention people, and clears it', async () => {
  const id = await expense(20000, [jana, khaled]);
  expect((await getTransaction(id))!.people).toEqual([jana, khaled]);

  const t = (await getTransaction(id))!;
  const base = { type: t.type, amount: 25000, accountId: t.accountId, categoryId: t.categoryId, paymentType: t.paymentType, date: t.date };
  await updateTransaction(id, base);
  expect((await getTransaction(id))!.people).toEqual([jana, khaled]);

  await updateTransaction(id, { ...base, people: [feky] });
  expect((await getTransaction(id))!.people).toEqual([feky]);

  await updateTransaction(id, { ...base, people: [] });
  expect((await getTransaction(id))!.people).toEqual([]);
  const raw = await all<{ people: string | null }>('SELECT people FROM transactions WHERE id = ?', [id]);
  expect(raw[0].people).toBeNull();
});

it('keeps people off the InstaPay fee row', async () => {
  const id = await createTransaction({
    type: 'expense', amount: 100000, accountId: account, categoryId: SYSTEM_CATEGORIES.missing, paymentType: 'instapay',
    date: Date.now(), isInstapay: true, fee: 100, people: [jana],
  });
  const fee = await all<{ people: string | null }>('SELECT people FROM transactions WHERE parent_id = ?', [id]);
  expect(fee).toHaveLength(1);
  expect(fee[0].people).toBeNull();
});

it('files people when a bank message is confirmed from the inbox', async () => {
  const r = await ingestSms('Purchase of EGP 450.00 with card ending 9999 at TEST CAFE', 'paste');
  expect(r.result).toBe('added');
  if (r.result !== 'added') return;
  const txId = await confirmItem(r.id, {
    type: 'expense', amount: 45000, accountId: account, categoryId: SYSTEM_CATEGORIES.missing, paymentType: 'debit_card',
    date: Date.now(), people: [jana, feky],
  });
  expect((await getTransaction(txId))!.people).toEqual([jana, feky]);
});

it('finds records by person, by name in search, and totals what you spent together', async () => {
  const before = await getSpentTogether(feky);
  await expense(30000, [feky, khaled]);
  const after = await getSpentTogether(feky);
  expect(after.records).toBe(before.records + 1);
  expect(after.spent).toBe(before.spent + 30000);

  const withFeky = await listTransactions({ withPersonId: feky });
  expect(withFeky.every((t) => t.people.includes(feky))).toBe(true);
  expect(withFeky.length).toBe(after.records);

  const byName = await listTransactions({ search: 'Test Person C' });
  expect(byName.map((t) => t.id).sort()).toEqual(withFeky.map((t) => t.id).sort());

  expect((await getPayeeUsage(feky)).sharedRecords).toBe(after.records);
  expect((await suggestedPeople(5)).map((p) => p.id)).toEqual(expect.arrayContaining([jana, khaled, feky]));
});

it('swaps a merged person into every list, without duplicates', async () => {
  const dup = (await findOrCreatePayee('Test Person C2', 'person')).id;
  const both = await expense(5000, [feky, dup]);
  const onlyDup = await expense(6000, [dup, jana]);
  await mergePayees(dup, feky);
  expect((await getTransaction(both))!.people).toEqual([feky]);
  expect((await getTransaction(onlyDup))!.people.sort()).toEqual([feky, jana].sort());
});

it('drops a deleted person from lists, leaving NULL when nobody is left', async () => {
  const gone = (await findOrCreatePayee('Test Person D', 'person')).id;
  const alone = await expense(7000, [gone]);
  const shared = await expense(8000, [gone, khaled]);
  await deletePayee(gone);
  const raw = await all<{ people: string | null }>('SELECT people FROM transactions WHERE id = ?', [alone]);
  expect(raw[0].people).toBeNull();
  expect((await getTransaction(shared))!.people).toEqual([khaled]);
});
