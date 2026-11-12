import type { BankDefinition } from '../types';
import { CCY, ENDING, LAST4, NUM, clean, re, toMinorText } from '../utils/patterns';

const ADDED = '(?:إضافة|اضافة|اضافه|إضافه)';
const TO = '(?:إلى|الى|إلي|الي)';
const DEBIT_CARD = `تم خصم\\s*${NUM}\\s*${CCY}\\s*من بطاقة الخصم المباشر\\s*رقم\\s*(\\d{3,4})\\s*عند\\s+`;
const AVAILABLE = `(?:.*?المتاح\\s*${NUM})?`;

/**
 * National Bank of Egypt (البنك الأهلي المصري) SMS alerts, Arabic. Account alerts name the
 * account by its last 4 digits ("حسابكم رقم 9001"), card alerts by "المنتهية بـ 9002". Dates are
 * month-day without a year ("يوم 08-20 الساعة 22:10"), so the time the SMS arrived is used.
 * Spacing is irregular (words run into numbers), which every regex tolerates. The examples are
 * made up but keep NBE's exact wording.
 */
export const NBE: BankDefinition = {
  id: 'nbe',
  name: 'NBE',
  country: 'EG',
  senders: ['BanK-AlAhly', 'NBE'],
  templates: [
    {
      // تم إضافة تحويل لحظي لحسابكم رقم 9001 بمبلغ 200.00 جم من NOUR TEST PERSON رقم مرجعي 123456789012 يوم 08-20 الساعة 22:10 للمزيد اتصل بـ 19623
      kind: 'instapay_in',
      regex: re(`تم ${ADDED} تحويل لحظي\\s*لحساب\\S*\\s*رقم\\s*(\\d{3,4})\\s*بمبلغ\\s*${NUM}\\s*جم\\s*من\\s+(.+?)\\s*رقم مرجعي\\s*(\\d+)`),
      map: (m) => ({ last4: m[1], amountText: m[2], ccy: 'EGP', counterparty: clean(m[3]), reference: m[4] }),
    },
    {
      // تم إضافة تحويل لحظي لبطاقتكم المنتهية بـ  9002 بمبلغ  1000.00جم من نور تجربة رقم مرجعي  308596576147يوم 08-20الساعة 12:04 للمزيد اتصل بـ 19623
      kind: 'instapay_in',
      regex: re(`تم ${ADDED} تحويل لحظي\\s*لبطاقت\\S*\\s*${ENDING}\\s*${LAST4}\\s*بمبلغ\\s*${NUM}\\s*جم\\s*من\\s+(.+?)\\s*رقم مرجعي\\s*(\\d+)`),
      map: (m) => ({ last4: m[1], amountText: m[2], ccy: 'EGP', counterparty: clean(m[3]), reference: m[4] }),
    },
    {
      // تم تنفيذ تحويل لحظي من حسابكم رقم 9001 بمبلغ 200.00 جم إلى NOUR T****** P***** رقم مرجعي 123456789013 يوم 08-20 الساعة 00:46 للمزيد اتصل بـ 19623
      kind: 'instapay_out',
      regex: re(`تم تنفيذ تحويل لحظي\\s*من\\s*حساب\\S*\\s*رقم\\s*(\\d{3,4})\\s*بمبلغ\\s*${NUM}\\s*جم\\s*${TO}\\s+(.+?)\\s*رقم مرجعي\\s*(\\d+)`),
      map: (m) => ({ last4: m[1], amountText: m[2], ccy: 'EGP', counterparty: clean(m[3]), reference: m[4] }),
    },
    {
      // تم خصم مبلغ 385.72 جم لحظيا باستخدام (شبكة المدفوعات اللحظية) من حسابكم رقم 9001 عند Sample Cafe يوم 08-20 الساعة09:48 مرجع التاجر 1497523288 للمزيد اتصل بـ 19623.
      kind: 'instapay_out',
      regex: re(`تم خصم مبلغ\\s*${NUM}\\s*جم\\s*لحظيا.*?من\\s*حساب\\S*\\s*رقم\\s*(\\d{3,4})\\s*عند\\s+(.+?)\\s*يوم.*?مرجع التاجر\\s*(\\d+)`),
      map: (m) => ({ amountText: m[1], ccy: 'EGP', last4: m[2], counterparty: clean(m[3]), reference: m[4] }),
    },
    {
      // تم خصم 500.00EGP من بطاقة الخصم المباشر رقم 9002 عند NBE ATM123 يوم 08/20 الساعه 13:20 المتاح 669.61 للمزيد إتصل ب 19623
      kind: 'atm_withdrawal',
      regex: re(`${DEBIT_CARD}([^\\n]*?ATM.*?)\\s*يوم${AVAILABLE}`),
      map: (m) => ({ amountText: m[1], ccy: m[2], last4: m[3], counterparty: 'ATM', ...(m[5] ? { balanceCurrency: m[2], balance: toMinorText(m[5]) } : {}) }),
    },
    {
      // تم خصم 123.45EGP من بطاقة الخصم المباشر رقم 9002 عند SAMPLE STORE يوم 08/20 الساعه 13:20 المتاح 546.16 للمزيد إتصل ب 19623
      kind: 'card_purchase',
      regex: re(`${DEBIT_CARD}(.+?)\\s*يوم${AVAILABLE}`),
      map: (m) => ({ amountText: m[1], ccy: m[2], last4: m[3], counterparty: clean(m[4]), ...(m[5] ? { balanceCurrency: m[2], balance: toMinorText(m[5]) } : {}) }),
    },
    {
      // تم رد تحويل لحظي لحسابكم رقم 9001 بمبلغ 200.00 جم رقم مرجعي 123456789014 يوم 08-20 الساعة 10:15
      kind: 'refund',
      regex: re(`تم رد تحويل لحظي\\s*لحساب\\S*\\s*رقم\\s*(\\d{3,4})\\s*بمبلغ\\s*${NUM}\\s*جم(?:.*?رقم مرجعي\\s*(\\d+))?`),
      map: (m) => ({ last4: m[1], amountText: m[2], ccy: 'EGP', counterparty: 'Returned InstaPay transfer', reference: m[3] ?? null }),
    },
    {
      // تم اضافه تحويل  52053 EGP   لحساب  9003  مرجع  599INTA000000ABC
      kind: 'unknown_credit',
      regex: re(`تم ${ADDED} تحويل\\s+${NUM}\\s*${CCY}\\s*لحساب\\S*\\s*(\\d{3,4})(?:\\s*مرجع\\s*([A-Za-z0-9]+))?`),
      map: (m) => ({ amountText: m[1], ccy: m[2], last4: m[3], reference: m[4] ?? null, counterparty: 'Bank transfer' }),
    },
    {
      // تم إيداع   1500  جنيه مصرى بفرع سامبل بحساب 9001 يوم 08/20/2026
      kind: 'cash_deposit',
      regex: re(`تم (?:إيداع|ايداع)\\s*${NUM}\\s*جنيه\\s*مصر\\S*\\s*(?:بفرع\\s*(.+?)\\s*)?بحساب\\S*\\s*(\\d{3,4})`),
      map: (m) => ({ amountText: m[1], ccy: 'EGP', counterparty: m[2] ? `Branch ${clean(m[2])}` : 'Branch deposit', last4: m[3] }),
    },
    {
      // تم اضافه تحويل   EGP 52053   لحساب  9003  مرجع  599INTA000000ABC
      kind: 'unknown_credit',
      regex: re(`تم ${ADDED} تحويل\\s+${CCY}\\s*${NUM}\\s*لحساب\\S*\\s*(\\d{3,4})(?:\\s*مرجع\\s*([A-Za-z0-9]+))?`),
      map: (m) => ({ ccy: m[1], amountText: m[2], last4: m[3], reference: m[4] ?? null, counterparty: 'Bank transfer' }),
    },
  ],
  ignore: [
    { reason: 'declined', regex: /تم رفض|مرفوضة/ },
    { reason: 'otp', regex: /كود التفعيل|الرقم السري|كلمة المرور|OTP/i },
    { reason: 'info', regex: /تركيد|ركود/ },
  ],
  // Every transfer says تحويل; instant payments to shops say لحظيا; debit card and ATM alerts say بطاقة الخصم.
  shortcutKeywords: [
    { word: 'تحويل', label: 'Transfers', testID: 'copy-keyword-nbe-transfer' },
    { word: 'لحظيا', label: 'Instant payments', testID: 'copy-keyword-nbe-payment' },
    { word: 'بطاقة الخصم', label: 'Debit card and ATM', testID: 'copy-keyword-nbe-card' },
  ],
  example: 'تم تنفيذ تحويل لحظي من حسابكم رقم 9001 بمبلغ 200.00 جم إلى NOUR T****** P***** رقم مرجعي 123456789013 يوم 08-20 الساعة 00:46 للمزيد اتصل بـ 19623',
  notes: 'Dates have no year, so the time the SMS arrived is used. Outgoing transfers mask the recipient name.',
};
