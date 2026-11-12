import { decideRows, type ExistingTx } from '@/modules/data-transfer/utils/importStatement';
import { detectStatement, parseStatement, splitInstapayFee } from '@/modules/data-transfer/utils/statements';
import type { Account } from '@/modules/shared/db/types';

/** Made-up rows in HSBC Egypt's exact download format (no header, details run together). */
const ACCOUNT_CSV = [
  '﻿ 06 Aug 2026,TRANSFERTO 9001 9002 9003 9004HIB- 11111111XS8EFLYWIB0000001INTERNET BANKING,"-4,694.00"',
  ' 06 Aug 2026,TRANSFERInstant Transfer from0e3eb60fnour.test@instapayYFSB24639SYSTEM GENERATED,"4,125.00"',
  ' 03 Aug 2026,SVC CHGANNUAL FEEZDD400001SYSTEM GENERATED,"-40.00"',
  ' 25 Jul 2026,TRANSFERInstant Transfer to346fed119005YFSB17895SYSTEM GENERATED,"-5,005.00"',
  ' 24 Jul 2026,TRANSFERInstant Transfer tob336c06aNOUR TEST PERSONYFSC05673SYSTEM GENERATED,"-2,002.00"',
  ' 22 Jul 2026,TRANSFERPurchase from0bf6a3a8Sample CafeYFSB11226SYSTEM GENERATED,"-385.72"',
  ' 22 Jul 2026,SALARYTRANSFER FROMSAMPLE EMPLOYER LTSALARYSALARYJUL SALARY 26ZAFA00880SYSTEM GENERATED,"8,140.00"',
  ' 21 Jul 2026,TFR REVInstant Transfer Rev45d0a5ceYFSA28924SYSTEM GENERATED,"1,001.00"',
  ' 21 Jul 2026,TRANSFERInstant Transfer to45d0a5ce9006YFSA28836SYSTEM GENERATED,"-1,001.00"',
  ' 20 Jul 2026,CARD TRANSACTION20JUL26 LOCAL   16:41:08SAMPLE BANK ATMA89813563ATM,"200.00"',
  ' 20 Jul 2026,CARD TRANSACTION20JUL26 LOCAL   16:41:02SAMPLE BANK ATMA89813562ATM,"-200.00"',
  ' 18 Jul 2026,CARD TRANSACTION18JUL26 ATMA475 16:29:41A47500028ATM,"1,800.00"',
  ' 15 Jul 2026,CARD TRANSACTION15JUL26 LOCAL   14:41:38SAMPLE ATMA89814125ATM,"-500.00"',
  ' 12 Jul 2026,CARD TRANSACTION10JUL26 V DEBIT003931EGP      1315.10PAYMOB*SAMPLE SHOPA89588979ATM,"-1,315.10"',
].join('\n');

const CARD_CSV = [
  '﻿  04 Aug 2026, 05 Aug 2026,05193790090019004APPLE.COM/US           CUPERTINO     CAUSAUSD -99.00USD -99.00,"-5,501.28"',
  ' 03 Aug 2026, 05 Aug 2026,05193790090019004Talabat                Maadi         000EGY,"-189.99"',
].join('\n');

const rule = { percent: 0.1, min: 50, max: 2000 };

const account = (id: string, identifiers: string[], type: Account['type'] = 'bank'): Account => ({
  id, name: id, type, currency: 'EGP', initialBalance: 0, color: '#000', icon: 'wallet', defaultPaymentType: 'debit_card',
  identifiers, bankBalance: null, bankBalanceAt: null, excludeFromStats: false, archived: false, sortOrder: 0, createdAt: 0,
});

describe('bank statements (HSBC Egypt)', () => {
  it('tells account and card downloads apart', () => {
    expect(detectStatement(ACCOUNT_CSV)).toEqual({ bank: 'hsbc-eg', format: 'account' });
    expect(detectStatement(CARD_CSV)).toEqual({ bank: 'hsbc-eg', format: 'card' });
    expect(detectStatement('date,amount\n2026-01-01,5')).toBeNull();
  });

  it('splits InstaPay totals into amount and fee', () => {
    expect(splitInstapayFee(500500, rule)).toEqual({ principal: 500000, fee: 500 });
    expect(splitInstapayFee(20050, rule)).toEqual({ principal: 20000, fee: 50 });
    expect(splitInstapayFee(7050, rule)).toEqual({ principal: 7000, fee: 50 });
  });

  it('reads every kind of account row and drops what the bank undid', () => {
    const s = parseStatement(ACCOUNT_CSV, rule)!;
    expect(s.cancelled).toBe(4); // ATM -200/+200 and the reversed 1,001 transfer
    const by = (raw: string) => s.rows.find((r) => r.raw.includes(raw))!;
    expect(by('TO 9001')).toMatchObject({ kind: 'own_transfer_out', otherDigits: '9004', amount: 469400 });
    expect(by('nour.test')).toMatchObject({ kind: 'instapay_in', counterparty: 'nour.test@instapay', reference: '0e3eb60f', direction: 'in' });
    expect(by('346fed11')).toMatchObject({ kind: 'own_transfer_out', otherDigits: '9005', fee: 500 });
    expect(by('NOUR TEST PERSON')).toMatchObject({ kind: 'instapay_out', counterparty: 'NOUR TEST PERSON', fee: 200 });
    expect(by('Sample Cafe')).toMatchObject({ kind: 'instapay_out', counterparty: 'Sample Cafe', fee: null });
    expect(by('SALARY')).toMatchObject({ kind: 'salary', counterparty: 'SAMPLE EMPLOYER LT' });
    expect(by('ANNUAL FEE')).toMatchObject({ kind: 'fee', amount: 4000 });
    expect(by('ATMA475')).toMatchObject({ kind: 'cash_deposit', amount: 180000 });
    expect(new Date(by('ATMA475').date)).toEqual(new Date(2026, 6, 18, 16, 29));
    expect(by('SAMPLE ATM')).toMatchObject({ kind: 'atm_withdrawal', counterparty: 'SAMPLE ATM' });
    expect(by('V DEBIT')).toMatchObject({ kind: 'purchase', counterparty: 'PAYMOB*SAMPLE SHOP' });
    expect(new Date(by('V DEBIT').date)).toEqual(new Date(2026, 6, 10, 12, 0));
  });

  it('reads card rows with merchant, card digits and the original currency', () => {
    const s = parseStatement(CARD_CSV, rule)!;
    expect(s.accountDigits).toBe('9004');
    expect(s.rows.map((r) => [r.counterparty, r.amount, r.original])).toEqual([
      ['Talabat', 18999, null],
      ['APPLE.COM/US', 550128, { amount: 9900, currency: 'USD' }],
    ]);
  });
});

describe('statement matching', () => {
  const hsbc = account('hsbc', ['9001']);
  const card = account('card', ['9004'], 'card');
  const nbe = account('nbe', ['9005']);
  const cash = account('cash', [], 'cash');
  const accounts = [hsbc, card, nbe, cash];
  const rows = parseStatement(ACCOUNT_CSV, rule)!.rows;
  const at = (d: number, h = 14) => new Date(2026, 6, d, h, 0).getTime();
  const tx = (p: Partial<ExistingTx> & { id: string }): ExistingTx => ({ type: 'expense', amount: 0, accountId: 'hsbc', toAccountId: null, toAmount: null, date: at(1), fee: 0, ...p });

  it('skips rows Mula already has, with or without the InstaPay fee', () => {
    const existing = [tx({ id: 'sms-cafe', amount: 38572, date: at(22, 9) }), tx({ id: 'sms-ipn', amount: 200000, fee: 200, date: at(24, 0) })];
    const d = decideRows(rows, 'hsbc', accounts, existing, cash.id);
    expect(d.find((x) => x.row.counterparty === 'Sample Cafe')).toMatchObject({ action: 'exists', matchId: 'sms-cafe' });
    expect(d.find((x) => x.row.counterparty === 'NOUR TEST PERSON')).toMatchObject({ action: 'exists', matchId: 'sms-ipn' });
  });

  it('makes transfers between your own accounts, and ATM rows go to cash', () => {
    const d = decideRows(rows, 'hsbc', accounts, [], cash.id);
    expect(d.find((x) => x.row.otherDigits === '9004')).toMatchObject({ action: 'new', transfer: { fromId: 'hsbc', toId: 'card' } });
    expect(d.find((x) => x.row.kind === 'atm_withdrawal')).toMatchObject({ action: 'new', transfer: { fromId: 'hsbc', toId: 'cash' } });
    expect(d.find((x) => x.row.kind === 'salary')).toMatchObject({ action: 'new', transfer: null });
  });

  it('links the other bank’s record of the same transfer instead of adding a twin', () => {
    const existing = [
      tx({ id: 'nbe-in', type: 'income', accountId: 'nbe', amount: 500000, date: at(25, 11) }),
      tx({ id: 'nbe-out', type: 'expense', accountId: 'nbe', amount: 412500, fee: 400, date: new Date(2026, 7, 6, 16, 33).getTime() }),
    ];
    const d = decideRows(rows, 'hsbc', accounts, existing, cash.id);
    expect(d.find((x) => x.row.otherDigits === '9005')).toMatchObject({ action: 'link', matchId: 'nbe-in', fromId: 'hsbc', toId: 'nbe' });
    expect(d.find((x) => x.row.kind === 'instapay_in')).toMatchObject({ action: 'link', matchId: 'nbe-out', fromId: 'nbe', toId: 'hsbc' });
  });

  it('uses each existing record once', () => {
    const twins = [...rows.filter((r) => r.counterparty === 'Sample Cafe'), { ...rows.find((r) => r.counterparty === 'Sample Cafe')!, index: 99 }];
    const d = decideRows(twins, 'hsbc', accounts, [tx({ id: 'one', amount: 38572, date: at(22) })], cash.id);
    expect(d.map((x) => x.action)).toEqual(['exists', 'new']);
  });
});
