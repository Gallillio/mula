/**
 * Bank installment plans: the implied monthly rate, the falling interest each month, and that
 * installment messages from the bank are never filed as new charges.
 */
import { buildPlan, impliedMonthlyRate, interestSchedule, planSchedule, remainingAfter } from '@/modules/installments/utils/schedule';
import { isInstallmentMessage, parseBankSms } from '@/modules/inbox/utils/parser';

// HSBC's Amazon quote: EGP 274.07 for 6 months | 2.70% interest | Total EGP 1,644.40, on a 1,499 purchase.
const SIX = { principal: 149900, monthly: 27407, months: 6, total: 164440 };

describe('installment schedule', () => {
  it('recovers the quoted monthly rate on the unpaid balance', () => {
    expect(impliedMonthlyRate(SIX.principal, SIX.monthly, SIX.months)).toBeCloseTo(0.027, 3);
    expect(buildPlan({ principal: 149900, monthly: 14790, months: 12, total: 177482 }).monthlyRate).toBeCloseTo(0.027, 3);
  });

  it('splits each installment into falling interest and principal, adding up to the quote', () => {
    const plan = buildPlan(SIX, 'tx1');
    const rows = planSchedule(plan);
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.installment).reduce((a, b) => a + b, 0)).toBe(164440);
    expect(rows[5].installment).toBe(27405);
    const interest = interestSchedule(plan);
    expect(interest.reduce((a, b) => a + b, 0)).toBe(164440 - 149900);
    expect(interest[0]).toBe(Math.round(149900 * plan.monthlyRate));
    for (let i = 1; i < interest.length; i++) expect(interest[i]).toBeLessThan(interest[i - 1]);
    expect(rows[5].remaining).toBe(0);
    expect(remainingAfter(plan, 0)).toBe(149900);
    expect(remainingAfter(plan, 6)).toBe(0);
  });

  it('logs nothing for an interest-free plan', () => {
    const plan = buildPlan({ principal: 120000, monthly: 20000, months: 6 });
    expect(plan.monthlyRate).toBe(0);
    expect(interestSchedule(plan).every((x) => x === 0)).toBe(true);
  });
});

describe('installment messages', () => {
  it('keeps them out of the charges', () => {
    const conv = 'Your purchase of EGP 1499.00 at AMAZON on your Credit Card ending with *** 3104 has been converted to an installment plan of 6 months.';
    expect(isInstallmentMessage(conv)).toBe(true);
    expect(parseBankSms(conv).status).toBe('unrecognized');
    expect(isInstallmentMessage('تم تقسيط مبلغ 1499 جم على بطاقة الائتمان')).toBe(true);
  });

  it('leaves the normal card purchase alone', () => {
    const buy = 'Your Credit Card ending with *** 3104 has been used for EGP 1499.00 on 14/11/2026 at AMAZON. Your available limit is EGP 112934.11';
    expect(isInstallmentMessage(buy)).toBe(false);
    expect(parseBankSms(buy).status).toBe('transaction');
  });
});
