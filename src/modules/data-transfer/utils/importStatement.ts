import { listAccounts } from '../../accounts/data/accountsRepo';
import { convert } from '../../integrations/utils/fx';
import { findOrCreatePayee, resolveAlias, setAlias } from '../../payees/data/payeesRepo';
import { all, first } from '../../shared/db/client';
import { SYSTEM_CATEGORIES } from '../../shared/db/seeds/categories';
import type { Account, ID, Minor, PaymentType, TxType } from '../../shared/db/types';
import { normalizeRaw } from '../../shared/utils/text';
import { createTransaction, getFeeTotal, getTransaction, updateTransaction } from '../../transactions/data/transactionsRepo';
import type { TxInput } from '../../transactions/types';
import type { StatementFile, StatementRow } from './statements';

/**
 * Brings a bank statement into Mula without doubling what is already there. Every row is checked
 * against the records Mula has (from bank SMS, Apple Pay, Claude, an earlier import or by hand):
 *
 * - same account, same amount (with or without the InstaPay fee), within two days → already in Mula;
 * - a transfer to one of your own cards or accounts ("TO 5193 … 3104", or InstaPay to an account
 *   ending in digits you added) → a transfer between your accounts, and a matching record on the
 *   other side (say, an NBE "money in" SMS) becomes that transfer instead of staying a duplicate;
 * - an incoming InstaPay that matches money that left another of your accounts the same day →
 *   that record becomes a transfer between your accounts.
 *
 * Everything else is added. Re-importing the same file adds nothing (rows carry a source ref).
 */

const DAY = 86_400_000;
/** How far a statement's booking date may be from the record's date. */
const MATCH_WINDOW = 2 * DAY;
/** Both sides of a transfer between your own banks happen within a day. */
const LINK_WINDOW = 1 * DAY;

export type ExistingTx = {
  id: ID;
  type: TxType;
  amount: Minor;
  accountId: ID;
  toAccountId: ID | null;
  toAmount: Minor | null;
  date: number;
  fee: Minor;
};

export type RowDecision =
  | { action: 'exists'; row: StatementRow; matchId: ID }
  /** A record on another account is really the other half of this transfer. */
  | { action: 'link'; row: StatementRow; matchId: ID; fromId: ID; toId: ID }
  | { action: 'new'; row: StatementRow; transfer: { fromId: ID; toId: ID } | null };

export type StatementPlan = {
  file: StatementFile;
  accountId: ID;
  decisions: RowDecision[];
  counts: { new: number; exists: number; transfers: number; linked: number; alreadyImported: number };
};

export const statementRef = (file: StatementFile, accountId: ID, r: StatementRow) =>
  `statement:${file.bank}:${accountId}:${new Date(r.date).toISOString().slice(0, 10)}:${r.direction}:${r.amount}:${r.reference ?? r.raw.slice(0, 40)}`;

/** The account whose added card/account digits end with (or are the end of) `digits`. */
export function accountForDigits(accounts: Account[], digits: string | null, except?: ID): Account | null {
  if (!digits) return null;
  return accounts.find((a) => a.id !== except && a.identifiers.some((i) => i.length >= 3 && (i.endsWith(digits) || digits.endsWith(i)))) ?? null;
}

/** Amounts a record could show for this row: the bank's total, or the total without the InstaPay fee. */
function sameMoney(row: StatementRow, amount: Minor, fee: Minor): boolean {
  if (amount === row.amount || amount + fee === row.amount) return true;
  return row.fee != null && amount === row.amount - row.fee;
}

/**
 * Pure matching: decides what to do with each row given the records already in Mula. Each existing
 * record is used once, closest date first.
 */
export function decideRows(rows: StatementRow[], accountId: ID, accounts: Account[], existing: ExistingTx[], cashAccountId: ID | null): RowDecision[] {
  const used = new Set<ID>();
  const near = (r: StatementRow, window: number) => (t: ExistingTx) => !used.has(t.id) && Math.abs(t.date - r.date) <= window;
  const closest = (r: StatementRow, list: ExistingTx[]) => [...list].sort((a, b) => Math.abs(a.date - r.date) - Math.abs(b.date - r.date))[0] ?? null;

  const ownSide = (r: StatementRow): { fromId: ID; toId: ID } | null => {
    if (r.kind === 'atm_withdrawal' && cashAccountId && cashAccountId !== accountId) return { fromId: accountId, toId: cashAccountId };
    if (r.kind === 'cash_deposit' && cashAccountId && cashAccountId !== accountId) return { fromId: cashAccountId, toId: accountId };
    if (r.kind !== 'own_transfer_out' && r.kind !== 'own_transfer_in') return null;
    const other = accountForDigits(accounts, r.otherDigits, accountId);
    if (!other) return null;
    return r.direction === 'out' ? { fromId: accountId, toId: other.id } : { fromId: other.id, toId: accountId };
  };

  return rows.map((r): RowDecision => {
    // 1. Already in this account?
    const here = existing.filter(near(r, MATCH_WINDOW)).filter((t) =>
      r.direction === 'out'
        ? t.accountId === accountId && (t.type === 'expense' || t.type === 'transfer') && sameMoney(r, t.amount, t.fee)
        : (t.type === 'income' && t.accountId === accountId && sameMoney(r, t.amount, 0)) ||
          (t.type === 'transfer' && t.toAccountId === accountId && sameMoney(r, t.toAmount ?? t.amount, 0)),
    );
    const hit = closest(r, here);
    if (hit) {
      used.add(hit.id);
      return { action: 'exists', row: r, matchId: hit.id };
    }

    // 2. A transfer between your own accounts: does the other side already have it?
    const transfer = ownSide(r);
    if (transfer && (r.kind === 'own_transfer_out' || r.kind === 'own_transfer_in')) {
      const otherId = r.direction === 'out' ? transfer.toId : transfer.fromId;
      const principal = r.amount - (r.fee ?? 0);
      const twin = closest(
        r,
        existing
          .filter(near(r, LINK_WINDOW))
          .filter((t) => t.accountId === otherId && (r.direction === 'out' ? t.type === 'income' : t.type === 'expense') && (t.amount === principal || t.amount === r.amount)),
      );
      if (twin) {
        used.add(twin.id);
        return { action: 'link', row: r, matchId: twin.id, ...transfer };
      }
    }

    // 3. Money in by InstaPay that left another of your accounts the same day.
    if (r.kind === 'instapay_in') {
      const sent = existing
        .filter(near(r, LINK_WINDOW))
        .filter((t) => t.type === 'expense' && t.accountId !== accountId && t.accountId !== cashAccountId && (t.amount === r.amount || t.amount + t.fee === r.amount));
      if (sent.length === 1) {
        used.add(sent[0].id);
        return { action: 'link', row: r, matchId: sent[0].id, fromId: sent[0].accountId, toId: accountId };
      }
    }

    return { action: 'new', row: r, transfer };
  });
}

/** Records in these accounts around the statement's dates (fee rows folded into their parent). */
async function loadExisting(from: number, to: number): Promise<ExistingTx[]> {
  const rows = await all<{
    id: string;
    type: TxType;
    amount: number;
    account_id: string;
    to_account_id: string | null;
    to_amount: number | null;
    date: number;
    fee: number;
  }>(
    `SELECT t.id, t.type, t.amount, t.account_id, t.to_account_id, t.to_amount, t.date,
            COALESCE((SELECT SUM(f.amount) FROM transactions f WHERE f.parent_id = t.id), 0) AS fee
       FROM transactions t
      WHERE t.parent_id IS NULL AND t.date BETWEEN ? AND ?`,
    [from - 3 * DAY, to + 3 * DAY],
  );
  return rows.map((r) => ({ id: r.id, type: r.type, amount: r.amount, accountId: r.account_id, toAccountId: r.to_account_id, toAmount: r.to_amount, date: r.date, fee: r.fee }));
}

export async function planStatement(file: StatementFile, accountId: ID): Promise<StatementPlan> {
  const accounts = await listAccounts(true);
  const cash = accounts.find((a) => a.type === 'cash' && !a.archived) ?? null;
  const existing = file.firstDate != null && file.lastDate != null ? await loadExisting(file.firstDate, file.lastDate) : [];

  // Rows saved by an earlier import of this statement are skipped outright.
  const fresh: StatementRow[] = [];
  let alreadyImported = 0;
  for (const r of file.rows) {
    if (await first<{ x: number }>('SELECT 1 AS x FROM transactions WHERE source_ref = ?', [statementRef(file, accountId, r)])) alreadyImported++;
    else fresh.push(r);
  }

  const decisions = decideRows(fresh, accountId, accounts, existing, cash?.id ?? null);
  return {
    file,
    accountId,
    decisions,
    counts: {
      new: decisions.filter((d) => d.action === 'new').length,
      exists: decisions.filter((d) => d.action === 'exists').length,
      transfers: decisions.filter((d) => d.action === 'new' && d.transfer).length,
      linked: decisions.filter((d) => d.action === 'link').length,
      alreadyImported,
    },
  };
}

export type StatementImportResult = { created: number; linked: number; skipped: number; failed: number };

const PAYMENT: Partial<Record<StatementRow['kind'], PaymentType>> = {
  instapay_out: 'instapay',
  instapay_in: 'instapay',
  own_transfer_out: 'bank_transfer',
  own_transfer_in: 'bank_transfer',
  salary: 'bank_transfer',
  atm_withdrawal: 'cash',
  cash_deposit: 'cash',
};

function categoryFor(r: StatementRow): ID | null {
  switch (r.kind) {
    case 'salary':
      return SYSTEM_CATEGORIES.wage;
    case 'fee':
      return SYSTEM_CATEGORIES.fees;
    case 'refund':
      return SYSTEM_CATEGORIES.refunds;
    default:
      return null;
  }
}

export async function importStatement(plan: StatementPlan, onProgress?: (done: number, total: number) => void): Promise<StatementImportResult> {
  const accounts = new Map((await listAccounts(true)).map((a) => [a.id, a]));
  const account = accounts.get(plan.accountId);
  if (!account) throw new Error('Choose an account for the import');
  const result: StatementImportResult = { created: 0, linked: 0, skipped: 0, failed: 0 };
  const payeeIds = new Map<string, ID>();

  const payeeFor = async (r: StatementRow): Promise<ID | null> => {
    const name = r.counterparty;
    if (!name || r.kind === 'fee' || r.kind === 'atm_withdrawal' || r.kind === 'cash_deposit') return null;
    const key = normalizeRaw(name);
    if (!key) return null;
    const known = payeeIds.get(key);
    if (known) return known;
    const aliased = await resolveAlias(name);
    const payee = aliased ?? (await findOrCreatePayee(name, r.kind === 'instapay_in' || r.kind === 'instapay_out' ? 'person' : 'merchant'));
    if (!aliased) await setAlias(name, payee.id);
    payeeIds.set(key, payee.id);
    return payee.id;
  };

  const inAccountCurrency = async (r: StatementRow, target: Account) => {
    if (r.currency === target.currency) return { amount: r.amount, original: r.original ? { ...r.original, rate: r.amount / r.original.amount } : null };
    const fx = await convert(r.amount, r.currency, target.currency, r.date);
    return fx ? { amount: fx.amount, original: { amount: r.amount, currency: r.currency, rate: fx.rate } } : null;
  };

  for (let i = 0; i < plan.decisions.length; i++) {
    const d = plan.decisions[i];
    const r = d.row;
    try {
      if (d.action === 'exists') {
        result.skipped++;
        continue;
      }
      const principal = r.amount - (r.fee ?? 0);

      if (d.action === 'link') {
        // Turn the other bank's record into the transfer, keeping its date when it has a time.
        const twin = await getTransaction(d.matchId);
        const from = accounts.get(d.fromId);
        if (!twin || !from) {
          result.failed++;
          continue;
        }
        const twinIsSender = twin.accountId === d.fromId;
        const amount = twinIsSender ? twin.amount : principal;
        const twinFee = twinIsSender ? await getFeeTotal(twin.id) : 0;
        const input: TxInput = {
          type: 'transfer',
          amount,
          accountId: d.fromId,
          toAccountId: d.toId,
          toAmount: null,
          categoryId: null,
          payeeId: null,
          paymentType: r.kind.startsWith('instapay') || r.fee ? 'instapay' : 'bank_transfer',
          date: twin.date,
          note: twin.note,
          isInstapay: twin.isInstapay || Boolean(r.fee) || r.kind === 'instapay_in',
          fee: twinIsSender ? twinFee || null : r.fee,
          original: null,
          source: twin.source,
          sourceRef: twin.sourceRef,
        };
        await updateTransaction(twin.id, input);
        result.linked++;
        continue;
      }

      const ref = statementRef(plan.file, plan.accountId, r);
      if (d.transfer) {
        const from = accounts.get(d.transfer.fromId)!;
        const money = await inAccountCurrency({ ...r, amount: principal }, from);
        if (!money) {
          result.failed++;
          continue;
        }
        await createTransaction({
          type: 'transfer',
          amount: money.amount,
          accountId: d.transfer.fromId,
          toAccountId: d.transfer.toId,
          toAmount: null,
          categoryId: null,
          payeeId: null,
          paymentType: PAYMENT[r.kind] ?? 'bank_transfer',
          date: r.date,
          note: r.kind === 'atm_withdrawal' || r.kind === 'cash_deposit' ? r.counterparty : null,
          isInstapay: Boolean(r.fee),
          fee: r.fee,
          original: null,
          source: 'import',
          sourceRef: ref,
        });
        result.created++;
        continue;
      }

      const out = r.direction === 'out';
      const money = await inAccountCurrency(r.fee ? { ...r, amount: principal } : r, account);
      if (!money) {
        result.failed++;
        continue;
      }
      // Transfers to digits that aren't one of your accounts are payments to someone else.
      const counterparty = r.counterparty ?? (r.otherDigits ? `Account ending ${r.otherDigits}` : null);
      const row = { ...r, counterparty };
      const instapay = r.kind === 'instapay_out' || r.kind === 'instapay_in' || Boolean(r.fee);
      await createTransaction({
        type: out ? 'expense' : 'income',
        amount: money.amount,
        accountId: account.id,
        categoryId: categoryFor(r) ?? SYSTEM_CATEGORIES.missing,
        payeeId: await payeeFor(row),
        paymentType: instapay ? 'instapay' : (PAYMENT[r.kind] ?? account.defaultPaymentType),
        date: r.date,
        note: r.kind === 'fee' ? r.reference : r.kind === 'atm_withdrawal' || r.kind === 'cash_deposit' ? r.counterparty : null,
        isInstapay: instapay,
        fee: r.fee,
        original: money.original,
        source: 'import',
        sourceRef: ref,
      });
      result.created++;
    } catch (e) {
      console.warn('[mula] statement import', e);
      result.failed++;
    } finally {
      onProgress?.(i + 1, plan.decisions.length);
    }
  }
  return result;
}

/**
 * For other importers (SMS history): a record already in this account with this amount within two
 * days, that didn't come from the same kind of import, and isn't in `used`. Its id, or null.
 */
export async function findMatchingRecord(
  accountId: ID,
  direction: 'out' | 'in',
  amount: Minor,
  date: number,
  opts: { exceptRefPrefix: string; used: Set<ID> },
): Promise<ID | null> {
  const window = [date - MATCH_WINDOW, date + MATCH_WINDOW, `${opts.exceptRefPrefix}%`];
  const rows =
    direction === 'out'
      ? await all<{ id: string; date: number }>(
          `SELECT t.id, t.date FROM transactions t
            WHERE t.parent_id IS NULL AND t.account_id = ? AND t.type IN ('expense', 'transfer')
              AND (t.amount = ? OR t.amount + COALESCE((SELECT SUM(f.amount) FROM transactions f WHERE f.parent_id = t.id), 0) = ?)
              AND t.date BETWEEN ? AND ? AND COALESCE(t.source_ref, '') NOT LIKE ?`,
          [accountId, amount, amount, ...window],
        )
      : await all<{ id: string; date: number }>(
          `SELECT t.id, t.date FROM transactions t
            WHERE t.parent_id IS NULL
              AND ((t.type = 'income' AND t.account_id = ? AND t.amount = ?) OR (t.type = 'transfer' AND t.to_account_id = ? AND COALESCE(t.to_amount, t.amount) = ?))
              AND t.date BETWEEN ? AND ? AND COALESCE(t.source_ref, '') NOT LIKE ?`,
          [accountId, amount, accountId, amount, ...window],
        );
  const hit = rows.filter((r) => !opts.used.has(r.id)).sort((a, b) => Math.abs(a.date - date) - Math.abs(b.date - date))[0];
  if (!hit) return null;
  opts.used.add(hit.id);
  return hit.id;
}

/**
 * For other importers (SMS history): when money left (or reached) this account and the other side of
 * the same transfer is already in Mula on another of your accounts (say, the HSBC statement shows
 * "received 41,250" and this NBE text says "sent 41,250"), turns that record into one transfer
 * between the two accounts. Only when exactly one record fits. Returns its id, or null.
 */
export async function linkOwnTransfer(
  accountId: ID,
  direction: 'out' | 'in',
  amount: Minor,
  date: number,
  opts: { used: Set<ID>; cashAccountId: ID | null },
): Promise<ID | null> {
  const window = [date - LINK_WINDOW, date + LINK_WINDOW];
  const rows = await all<{ id: string; amount: number; account_id: string; fee: number }>(
    `SELECT t.id, t.amount, t.account_id,
            COALESCE((SELECT SUM(f.amount) FROM transactions f WHERE f.parent_id = t.id), 0) AS fee
       FROM transactions t
      WHERE t.parent_id IS NULL AND t.type = ? AND t.account_id <> ? AND COALESCE(t.account_id = ?, 0) = 0
        AND t.date BETWEEN ? AND ?`,
    [direction === 'out' ? 'income' : 'expense', accountId, opts.cashAccountId, ...window],
  );
  const fits = rows.filter((r) => !opts.used.has(r.id) && (r.amount === amount || r.amount + r.fee === amount || amount - r.amount === r.fee));
  if (fits.length !== 1) return null;
  const twin = await getTransaction(fits[0].id);
  if (!twin) return null;
  const twinIsSender = direction === 'in';
  await updateTransaction(twin.id, {
    type: 'transfer',
    amount: twin.amount,
    accountId: twinIsSender ? twin.accountId : accountId,
    toAccountId: twinIsSender ? accountId : twin.accountId,
    toAmount: null,
    categoryId: null,
    payeeId: null,
    paymentType: 'instapay',
    date: twin.date,
    note: twin.note,
    isInstapay: true,
    fee: twinIsSender ? (await getFeeTotal(twin.id)) || null : null,
    original: null,
    source: twin.source,
    sourceRef: twin.sourceRef,
  });
  opts.used.add(twin.id);
  return twin.id;
}
