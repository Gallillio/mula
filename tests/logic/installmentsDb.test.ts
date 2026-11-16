/**
 * Installment plans on a real SQLite database: migration 3's columns, the plan's planned payment
 * logging each month's (falling) interest on the card, and the purchase keeping its full price.
 */
import { saveAccount } from '../../src/modules/accounts/data/accountsRepo';
import { createInstallmentPlan, planForPurchase } from '../../src/modules/installments/data/installmentsRepo';
import { getRecurring, listUpcoming, processDueRecurring } from '../../src/modules/recurring/data/recurringRepo';
import { all } from '../../src/modules/shared/db/client';
import { bootstrap } from '../../src/modules/shared/db/bootstrap';
import { SYSTEM_CATEGORIES } from '../../src/modules/shared/db/seeds/categories';
import { createTransaction } from '../../src/modules/transactions/data/transactionsRepo';

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


const DAY = 86_400_000;

beforeAll(async () => {
  await bootstrap();
});

it('logs only the interest, month by month, on the same card', async () => {
  const card = await saveAccount({
    name: 'Mastercard Credit', type: 'card', currency: 'EGP', initialBalance: 0, color: '#2F45D0', icon: 'credit-card',
    defaultPaymentType: 'credit_card', identifiers: ['3104'], excludeFromStats: false, archived: false,
  });
  const bought = new Date(2026, 10, 14, 21, 11).getTime();
  const purchase = await createTransaction({ type: 'expense', amount: 149900, accountId: card, paymentType: 'credit_card', date: bought, source: 'sms' });

  const firstDue = new Date(2026, 11, 5, 12).getTime();
  const res = await createInstallmentPlan({ purchaseId: purchase, monthly: 27407, months: 6, total: 164440, firstDue });
  expect(res.recurringId).toBeTruthy();
  const r = (await getRecurring(res.recurringId!))!;
  expect(r.installment?.purchaseId).toBe(purchase);
  expect(r.schedule).toEqual(res.interest);
  expect(r.mode).toBe('auto');
  expect(r.categoryId).toBe(SYSTEM_CATEGORIES.loanInterest);
  expect(await planForPurchase(purchase)).not.toBeNull();
  await expect(createInstallmentPlan({ purchaseId: purchase, monthly: 27407, months: 6 })).rejects.toThrow(/already/);

  const soon = await listUpcoming(30, firstDue - 5 * DAY);
  expect(soon.find((u) => u.recurring.id === r.id)?.amount).toBe(res.interest[0]);

  await processDueRecurring(new Date(2027, 5, 1).getTime());
  const logged = await all<{ amount: number; account_id: string; type: string }>(
    'SELECT amount, account_id, type FROM transactions WHERE recurring_id = ? ORDER BY date', [r.id],
  );
  expect(logged.map((t) => t.amount)).toEqual(res.interest);
  expect(logged.every((t) => t.account_id === card && t.type === 'expense')).toBe(true);
  expect(logged.reduce((a, t) => a + t.amount, 0)).toBe(164440 - 149900);
  const purchaseRow = await all<{ amount: number }>('SELECT amount FROM transactions WHERE id = ?', [purchase]);
  expect(purchaseRow[0].amount).toBe(149900);
  expect((await getRecurring(r.id))!.nextDue).toBeNull();
});
