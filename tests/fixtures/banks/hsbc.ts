/**
 * Made-up HSBC Egypt messages in the exact formats HSBC sends: amounts, digits, names and
 * references are invented, the wording is HSBC's. Never paste real messages here.
 */
export const HSBC_SMS = {
  card: 'Your Credit Card ending with *** 9002 has been used for EGP 510.00 on 20/08/2026 at sample market. Your available limit is EGP 11053.22',
  cardDotInName: 'Your Credit Card ending with *** 9002 has been used for USD 99.00 on 20/08/2026 at APPLE.COM/US. Your available limit is EGP 78078.29',
  cardBrackets: 'Your Credit Card ending with *** 9003 has been used for EGP 29.00 on 20/08/2026 at NOON (INSTANT). Your available limit is EGP 1108.22',
  ipnIn:
    'Your HSBC Account ********9001 was credited with IPN inward transfer for EGP 41,250.00 on 06-08-2026 16:33 from nour.test@instapay with reference a1b2c3d4. For further details, please contact HSBC call centre',
  ipnOut:
    'Your HSBC Account ********9001 was debited with IPN outward transfer for EGP 2,002.00 on 22-08-2026 00:09 to NOUR TEST PERSON with reference b2c3d4e5. For further details, please contact HSBC call centre',
  ipnPurchase:
    'Your HSBC Account ********9001 was debited with IPN purchase for EGP 385.72 on 22-08-2026 09:33 from Sample Cafe with reference c3d4e5f6. For further details, please contact HSBC call centre',
  charges: 'From HSBC: 31AUG26 Charges from 074-234***-001 EGP 75.00- Your available balance is EGP 7,719.28',
  transfer: 'From HSBC: 01AUG26 Internet Banking Transfer from 074-234***-001 EGP 1,985.00- Your available balance is EGP 5,734.28',
  cardNoMerchant: 'Your Credit Card ending with *** 9002 has been used for EGP 45.00 on 20/08/2026 at . Your available limit is EGP 11008.22',
  ipnReversed:
    'Your HSBC Account ********9001 was reversed with IPN outward transfer for EGP 2,002.00 on 22-08-2026 00:15 from NOUR TEST PERSON with reference b2c3d4e6. For further details, please contact HSBC call centre',
  atm: 'From HSBC: 20AUG26 ATM Cash Withdrawal from 074-234***-001 EGP 500.00- Your available balance is EGP 6,719.28',
  atmDeposit: 'From HSBC: 20AUG26 ATM Cash Deposit to 074-234***-001 EGP 1,800.00+ Your available balance is EGP 8,519.28',
  atmReversal: 'From HSBC: 20AUG26 ATM Reversal of Cash Withdrawal from 074-234***-001 EGP 200.00+ Your available balance is EGP 8,719.28',
  salary: 'From HSBC: 25AUG26 Salary to 074-234***-001 EGP 8,140.00+ Your available balance is EGP 16,859.28',
  debitPurchase: 'From HSBC: 05AUG26 SAMPLE STORE Purchase from 074-234***-001 EGP 1,234.50- Your available balance is EGP 5,484.78',
  cardPayment:
    'From HSBC: 20AUG26 Transfer from 074-234***-001 EGP 20,797.09- to your Credit Card ending with 9002 as per your instruction. Your available balance is EGP 1,234.56',
  refundNotice: 'A refund of USD 12.34 from SAMPLE STORE on card *** 9002 should be credited within 30 days. Call HSBC Contact center for queries.',
  marketing:
    'Enjoy up to 12 months installment plans at discounted interest rate & no processing fees for purchases of EGP 5000 or more with HSBC Credit Card. Call 19007 to place your request. T&Cs apply',
  cashback:
    'You have earned Cashback of EGP 173.76 credited to your card ending with *** 9003.Check your statement or log on to Online Banking for details.',
  pin: "Use PIN 000000 to pay EGP 1980.00 at SAMPLE TICKETS with HSBC card ending 9002. Call the number on the card's back if you didn't do this transaction. T&C apply",
  declined: 'Transaction EGP 1700.00 on Card ending *** 9003 was declined due to invalid PIN. Enter the correct PIN or call the number at the back of your Card to reset it.',
  failed: 'From HSBC: This is to notify you that your transaction via HSBC Online/Mobile Banking was  not successful. Kindly contact us for further details.',
  statement:
    'HSBC Credit Card ending *** 9003 Statement Date 03/08/2026. Total Amt Due EGP 54,938.49, Due Date 28/08/2026. Min. Amt Due EGP 3,893.93. Please ignore if paid.',
} as const;
