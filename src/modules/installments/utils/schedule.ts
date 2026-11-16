import type { InstallmentPlan, Minor } from '../../shared/db/types';

/**
 * Bank installment plans (e.g. "EGP 274.07 for 6 months | 2.70% interest | Total EGP 1,644.40"
 * on a 1,499 purchase). Banks quote a monthly rate charged on the balance still unpaid, so each
 * installment is part principal and part interest, and the interest falls month by month.
 */

export type PlanTerms = { principal: Minor; monthly: Minor; months: number; total?: Minor | null };

/** The monthly rate that makes `months` payments of `monthly` repay `principal` (0 when interest-free). */
export function impliedMonthlyRate(principal: Minor, monthly: Minor, months: number): number {
  if (principal <= 0 || monthly <= 0 || months < 1 || monthly * months <= principal) return 0;
  const pv = (r: number) => (monthly * (1 - (1 + r) ** -months)) / r;
  let lo = 1e-9;
  let hi = 1;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (pv(mid) > principal) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export function buildPlan(terms: PlanTerms, purchaseId: string | null = null): InstallmentPlan {
  const months = Math.max(1, Math.round(terms.months));
  const total = terms.total && terms.total > 0 ? terms.total : terms.monthly * months;
  return {
    purchaseId,
    principal: terms.principal,
    monthly: terms.monthly,
    months,
    total,
    monthlyRate: impliedMonthlyRate(terms.principal, terms.monthly, months),
  };
}

export type ScheduleRow = { n: number; installment: Minor; interest: Minor; principal: Minor; remaining: Minor };

/**
 * Month-by-month split. Every installment is `monthly` except the last, which absorbs the
 * bank's rounding so the installments add up to `total`; the interest adds up to total − principal.
 */
export function planSchedule(plan: InstallmentPlan): ScheduleRow[] {
  const { months, monthly, principal, total, monthlyRate } = plan;
  const totalInterest = Math.max(0, total - principal);
  const rows: ScheduleRow[] = [];
  let balance = principal;
  let interestSoFar = 0;
  for (let n = 0; n < months; n++) {
    const last = n === months - 1;
    const installment = last ? total - monthly * (months - 1) : monthly;
    let interest = last ? totalInterest - interestSoFar : Math.round(balance * monthlyRate);
    interest = Math.max(0, Math.min(interest, installment, totalInterest - interestSoFar));
    const paid = last ? balance : installment - interest;
    balance = Math.max(0, balance - paid);
    interestSoFar += interest;
    rows.push({ n, installment, interest, principal: paid, remaining: balance });
  }
  return rows;
}

/** The interest each statement adds, in order: what the plan's planned payment logs. */
export const interestSchedule = (plan: InstallmentPlan): Minor[] => planSchedule(plan).map((r) => r.interest);

/** Unpaid principal after `done` installments. */
export function remainingAfter(plan: InstallmentPlan, done: number): Minor {
  if (done <= 0) return plan.principal;
  const rows = planSchedule(plan);
  return rows[Math.min(done, rows.length) - 1]?.remaining ?? 0;
}
