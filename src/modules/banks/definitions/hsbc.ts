import type { BankDefinition } from '../types';
import { CCY, DMY4, HM, LAST4, NUM, clean, dt4, re, toMinorText } from '../utils/patterns';

/** "074-234***-001": the digits after the last dash (they match an account ending in …6001). */
const ACCOUNT_NO = '[\\d*-]*-(\\d{3,4})';
const FROM_HSBC = 'From HSBC:\\s*\\d{2}[A-Z]{3}\\d{2}\\s+';
const AVAILABLE = `Your available balance is\\s+${CCY}\\s*${NUM}`;

/** InstaPay's published fee: 0.1%, at least EGP 0.50, at most EGP 20. */
const ipnFee = (minor: number) => Math.min(2000, Math.max(50, Math.round(minor / 1000)));

/** "2,002.00" (transfer plus fee) → "2000.00". Left as written if it doesn't split exactly. */
function withoutInstapayFee(text: string): string {
  const total = toMinorText(text);
  if (total == null) return text;
  let principal = total - ipnFee(total);
  for (let i = 0; i < 3; i++) {
    const fee = ipnFee(principal);
    if (principal + fee === total) return (principal / 100).toFixed(2);
    principal = total - fee;
  }
  return text;
}

/**
 * HSBC Egypt SMS alerts (English). Credit card alerts give the card's last 4 digits and the
 * remaining credit limit (not a balance, so it isn't read as one). Account alerts come in two
 * styles: "Your HSBC Account ********9001 was credited/debited with IPN …" for InstaPay, and
 * "From HSBC: 01NOV26 … from 074-234***-001 EGP 75.00- Your available balance is …" for charges
 * and Internet Banking transfers. The examples are made up but keep HSBC's exact wording.
 */
export const HSBC: BankDefinition = {
  id: 'hsbc-eg',
  name: 'HSBC',
  country: 'EG',
  senders: ['HSBC', 'HSBC EGYPT'],
  templates: [
    {
      // Your Credit Card ending with *** 9002 has been used for EGP 123.45 on 20/08/2026 at SAMPLE STORE. Your available limit is EGP 12345.67
      kind: 'card_purchase',
      // The limit is kept apart from the balance: for charges in another currency, its drop since the
      // card's previous message is the amount HSBC actually held in EGP (see cardLimitRepo).
      regex: re(`Your (?:Credit |Debit |Prepaid )?Card ending with\\s*${LAST4}\\s+has been used for\\s+${CCY}\\s*${NUM}\\s+on\\s+[\\d/]+\\s+at\\s*(.*?)\\.\\s*Your available limit(?:\\s+is\\s+${CCY}\\s*${NUM})?`),
      map: (m) => ({
        last4: m[1],
        ccy: m[2],
        amountText: m[3],
        counterparty: clean(m[4]),
        availableLimit: toMinorText(m[6]),
        availableLimitCurrency: m[6] ? m[5] : null,
      }),
    },
    {
      // Your HSBC Account ********9001 was credited with IPN inward transfer for EGP 1,500.00 on 20-08-2026 16:33 from nour.test@instapay with reference a1b2c3d4. …
      kind: 'instapay_in',
      regex: re(`Your HSBC Account\\s*${LAST4}\\s+was credited with IPN inward transfer for\\s+${CCY}\\s*${NUM}\\s+on\\s+${DMY4}\\s+${HM}\\s+from\\s+(.+?)\\s+with reference\\s+([A-Za-z0-9]+)`),
      map: (m) => ({ last4: m[1], ccy: m[2], amountText: m[3], occurredAt: dt4(m, 4), counterparty: clean(m[9]), reference: m[10] }),
    },
    {
      // Your HSBC Account ********9001 was debited with IPN outward transfer for EGP 2,002.00 on 20-08-2026 00:09 to NOUR TEST PERSON with reference b2c3d4e5. …
      // HSBC's amount includes InstaPay's fee (2,000.00 + 2.00); Mula books the fee as its own record.
      kind: 'instapay_out',
      regex: re(`Your HSBC Account\\s*${LAST4}\\s+was debited with IPN outward transfer for\\s+${CCY}\\s*${NUM}\\s+on\\s+${DMY4}\\s+${HM}\\s+to\\s+(.+?)\\s+with reference\\s+([A-Za-z0-9]+)`),
      map: (m) => ({ last4: m[1], ccy: m[2], amountText: withoutInstapayFee(m[3]), occurredAt: dt4(m, 4), counterparty: clean(m[9]), reference: m[10] }),
    },
    {
      // Your HSBC Account ********9001 was debited with IPN purchase for EGP 385.72 on 20-08-2026 09:33 from Sample Cafe with reference c3d4e5f6. …
      kind: 'instapay_out',
      regex: re(`Your HSBC Account\\s*${LAST4}\\s+was debited with IPN purchase for\\s+${CCY}\\s*${NUM}\\s+on\\s+${DMY4}\\s+${HM}\\s+from\\s+(.+?)\\s+with reference\\s+([A-Za-z0-9]+)`),
      map: (m) => ({ last4: m[1], ccy: m[2], amountText: m[3], occurredAt: dt4(m, 4), counterparty: clean(m[9]), reference: m[10] }),
    },
    {
      // Your HSBC Account ********9001 was reversed with IPN outward transfer for EGP 2,000.00 on 20-08-2026 00:15 from NOUR TEST PERSON with reference b2c3d4e6. …
      kind: 'refund',
      regex: re(`Your HSBC Account\\s*${LAST4}\\s+was reversed with IPN [a-z ]+? for\\s+${CCY}\\s*${NUM}\\s+on\\s+${DMY4}\\s+${HM}\\s+(?:to|from)\\s+(.+?)\\s+with reference\\s+([A-Za-z0-9]+)`),
      map: (m) => ({ last4: m[1], ccy: m[2], amountText: m[3], occurredAt: dt4(m, 4), counterparty: clean(m[9]), reference: m[10] }),
    },
    {
      // From HSBC: 20AUG26 ATM Cash Withdrawal from 074-234***-001 EGP 500.00- Your available balance is EGP 6,719.28
      kind: 'atm_withdrawal',
      regex: re(`${FROM_HSBC}ATM Cash Withdrawal from\\s+${ACCOUNT_NO}\\s+${CCY}\\s*${NUM}\\s*-\\s*${AVAILABLE}`),
      map: (m) => ({ last4: m[1], ccy: m[2], amountText: m[3], counterparty: 'ATM', balanceCurrency: m[4], balance: toMinorText(m[5]) }),
    },
    {
      // From HSBC: 20AUG26 ATM Cash Deposit to 074-234***-001 EGP 1,800.00+ Your available balance is EGP 8,519.28
      kind: 'cash_deposit',
      regex: re(`${FROM_HSBC}ATM Cash Deposit to\\s+${ACCOUNT_NO}\\s+${CCY}\\s*${NUM}\\s*\\+\\s*${AVAILABLE}`),
      map: (m) => ({ last4: m[1], ccy: m[2], amountText: m[3], counterparty: 'ATM', balanceCurrency: m[4], balance: toMinorText(m[5]) }),
    },
    {
      // From HSBC: 20AUG26 ATM Reversal of Cash Withdrawal from 074-234***-001 EGP 200.00+ Your available balance is EGP 8,719.28
      kind: 'refund',
      regex: re(`${FROM_HSBC}ATM Reversal of Cash Withdrawal from\\s+${ACCOUNT_NO}\\s+${CCY}\\s*${NUM}\\s*\\+\\s*${AVAILABLE}`),
      map: (m) => ({ last4: m[1], ccy: m[2], amountText: m[3], counterparty: 'ATM reversal', balanceCurrency: m[4], balance: toMinorText(m[5]) }),
    },
    {
      // From HSBC: 25AUG26 Salary to 074-234***-001 EGP 8,140.00+ Your available balance is EGP 16,859.28
      kind: 'unknown_credit',
      regex: re(`${FROM_HSBC}Salary to\\s+${ACCOUNT_NO}\\s+${CCY}\\s*${NUM}\\s*\\+\\s*${AVAILABLE}`),
      map: (m) => ({ last4: m[1], ccy: m[2], amountText: m[3], counterparty: 'Salary', balanceCurrency: m[4], balance: toMinorText(m[5]) }),
    },
    {
      // From HSBC: 05OCT26 SAMPLE STORE Purchase from 074-234***-001 EGP 1,234.50- Your available balance is EGP 5,484.78
      kind: 'card_purchase',
      regex: re(`${FROM_HSBC}(.+?)\\s+Purchase from\\s+${ACCOUNT_NO}\\s+${CCY}\\s*${NUM}\\s*-\\s*${AVAILABLE}`),
      map: (m) => ({ counterparty: clean(m[1]), last4: m[2], ccy: m[3], amountText: m[4], balanceCurrency: m[5], balance: toMinorText(m[6]) }),
    },
    {
      // From HSBC: 20JAN26 Transfer from 074-234***-001 EGP 20,797.09- to your Credit Card ending with 9002 as per your instruction. Your available balance is EGP 1,234.56
      kind: 'unknown_debit',
      regex: re(`${FROM_HSBC}Transfer from\\s+${ACCOUNT_NO}\\s+${CCY}\\s*${NUM}\\s*-\\s*to your Credit Card ending with\\s*(\\d{4}).*?${AVAILABLE}`),
      map: (m) => ({ last4: m[1], ccy: m[2], amountText: m[3], counterparty: `Credit card ${m[4]}`, balanceCurrency: m[5], balance: toMinorText(m[6]) }),
    },
    {
      // A refund of USD 12.34 from SAMPLE STORE on card *** 9002 should be credited within 30 days. …
      kind: 'refund',
      regex: re(`A refund of\\s+${CCY}\\s*${NUM}\\s+from\\s+(.+?)\\s+on card\\s*${LAST4}`),
      map: (m) => ({ ccy: m[1], amountText: m[2], counterparty: clean(m[3]), last4: m[4] }),
    },
    {
      // From HSBC: 20AUG26 Charges from 074-234***-001 EGP 75.00- Your available balance is EGP 7,719.28
      kind: 'unknown_debit',
      regex: re(`From HSBC:\\s*\\d{2}[A-Z]{3}\\d{2}\\s+Charges from\\s+${ACCOUNT_NO}\\s+${CCY}\\s*${NUM}\\s*-\\s*Your available balance is\\s+${CCY}\\s*${NUM}`),
      map: (m) => ({ last4: m[1], ccy: m[2], amountText: m[3], counterparty: 'HSBC charges', balanceCurrency: m[4], balance: toMinorText(m[5]) }),
    },
    {
      // From HSBC: 20AUG26 Internet Banking Transfer from 074-234***-001 EGP 1,985.00- Your available balance is EGP 5,734.28
      kind: 'unknown_debit',
      regex: re(`From HSBC:\\s*\\d{2}[A-Z]{3}\\d{2}\\s+Internet Banking Transfer from\\s+${ACCOUNT_NO}\\s+${CCY}\\s*${NUM}\\s*-\\s*Your available balance is\\s+${CCY}\\s*${NUM}`),
      map: (m) => ({ last4: m[1], ccy: m[2], amountText: m[3], counterparty: 'Internet Banking Transfer', balanceCurrency: m[4], balance: toMinorText(m[5]) }),
    },
    {
      // You have earned Cashback of EGP 173.76 credited to your card ending with *** 9002.Check your statement or log on to Online Banking for details.
      kind: 'refund',
      regex: re(`earned Cashback of\\s+${CCY}\\s*${NUM}\\s+credited to your card ending with\\s*${LAST4}`),
      map: (m) => ({ ccy: m[1], amountText: m[2], last4: m[3], counterparty: 'HSBC Cashback' }),
    },
  ],
  ignore: [
    { reason: 'declined', regex: /was declined|not successful/i },
    { reason: 'otp', regex: /Use PIN \d+ to pay/i },
    { reason: 'info', regex: /Statement Date|Amt Due/i },
    { reason: 'info', regex: /place your request|T&Cs apply/i },
  ],
  // Card alerts and cashback both say "ending with"; every account alert says "HSBC".
  shortcutKeywords: [
    { word: 'ending with', label: 'Cards', testID: 'copy-keyword-hsbc-card' },
    { word: 'HSBC', label: 'Account and InstaPay', testID: 'copy-keyword-hsbc-account' },
  ],
  example: 'Your Credit Card ending with *** 9002 has been used for EGP 123.45 on 20/08/2026 at SAMPLE STORE. Your available limit is EGP 12345.67',
  notes: 'Card alerts show the remaining credit limit, not a balance. Charges and Internet Banking alerts show only the last 3 digits of the account.',
};
