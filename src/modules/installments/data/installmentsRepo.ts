import { addMonths } from 'date-fns';

import { listCategories } from '../../categories/data/categoriesRepo';
import { getPayee } from '../../payees/data/payeesRepo';
import { deleteRecurring, listRecurring, saveRecurring, skipMissedRecurring } from '../../recurring/data/recurringRepo';
import { SYSTEM_CATEGORIES } from '../../shared/db/seeds/categories';
import type { ID, InstallmentPlan, Minor, Recurring, RecurringMode } from '../../shared/db/types';
import { getTransaction } from '../../transactions/data/transactionsRepo';
import { buildPlan, interestSchedule, type PlanTerms } from '../utils/schedule';

export type InstallmentInput = {
  /** The card purchase the bank converted (it stays one expense for its full price). */
  purchaseId: ID;
  monthly: Minor;
  months: number;
  /** The bank's quoted total; months × monthly when omitted. */
  total?: Minor | null;
  /** Principal; the purchase's amount when omitted. */
  principal?: Minor | null;
  /** First statement that bills an installment; a month after the purchase when omitted. */
  firstDue?: number | null;
  mode?: RecurringMode;
};

export type InstallmentResult = { recurringId: ID | null; plan: InstallmentPlan; interest: Minor[] };

/** The category interest is filed under: "Loan, interests" when it exists, else "Charges, Fees". */
async function interestCategory(): Promise<ID> {
  const cats = await listCategories(true);
  const loan = cats.find((c) => c.id === SYSTEM_CATEGORIES.loanInterest && !c.archived);
  return loan?.id ?? SYSTEM_CATEGORIES.fees;
}

/**
 * Records that a card purchase was converted into monthly installments. The purchase keeps its
 * full price (what the card owes, and what the bank took off the available limit); a planned
 * payment on the same card logs each month's interest on the unpaid balance. Statement payments
 * stay transfers, so nothing is counted twice. Interest-free plans need no series.
 */
export async function createInstallmentPlan(input: InstallmentInput): Promise<InstallmentResult> {
  const purchase = await getTransaction(input.purchaseId);
  if (!purchase || purchase.type !== 'expense') throw new Error('The purchase must be an expense');
  if (await planForPurchase(purchase.id)) throw new Error('This purchase already has an installment plan');
  const terms: PlanTerms = {
    principal: input.principal ?? purchase.amount,
    monthly: input.monthly,
    months: input.months,
    total: input.total ?? null,
  };
  if (terms.monthly <= 0 || terms.months < 1) throw new Error('Give the monthly amount and the number of months');
  if ((terms.total ?? terms.monthly * terms.months) < terms.principal) throw new Error('The plan totals less than the purchase');
  const plan = buildPlan(terms, purchase.id);
  const interest = interestSchedule(plan);
  if (!interest.some((x) => x > 0)) return { recurringId: null, plan, interest };

  const payee = purchase.payeeId ? await getPayee(purchase.payeeId) : null;
  const label = payee?.name ?? 'card purchase';
  const id = await saveRecurring({
    name: `Installment interest – ${label}`,
    type: 'expense',
    amount: interest[0] || interest.find((x) => x > 0) || null,
    currency: purchase.currency,
    accountId: purchase.accountId,
    toAccountId: null,
    categoryId: await interestCategory(),
    payeeId: purchase.payeeId,
    paymentType: purchase.paymentType === 'debit_card' ? 'credit_card' : purchase.paymentType,
    note: `Installment interest on ${label}`,
    isInstapay: false,
    frequency: 'monthly',
    interval: 1,
    startDate: input.firstDue ?? addMonths(purchase.date, 1).getTime(),
    endType: 'count',
    endDate: null,
    endCount: plan.months,
    mode: input.mode ?? 'auto',
    remindDaysBefore: 0,
    active: true,
    schedule: interest,
    installment: plan,
  });
  // A first statement already behind us was billed outside Mula; don't back-log it.
  await skipMissedRecurring(id);
  return { recurringId: id, plan, interest };
}

export async function listInstallmentPlans(): Promise<Recurring[]> {
  return (await listRecurring()).filter((r) => r.installment);
}

export async function planForPurchase(purchaseId: ID): Promise<Recurring | null> {
  return (await listInstallmentPlans()).find((r) => r.installment?.purchaseId === purchaseId) ?? null;
}

export async function deleteInstallmentPlan(recurringId: ID): Promise<void> {
  await deleteRecurring(recurringId);
}
