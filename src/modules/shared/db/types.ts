/** Domain records as the app sees them. Amounts are integer minor units (piastres, cents). */

export type ID = string;
export type Minor = number;

export type AccountType = 'cash' | 'bank' | 'card' | 'wallet' | 'savings' | 'other';

export type PaymentType =
  | 'cash'
  | 'debit_card'
  | 'credit_card'
  | 'apple_pay'
  | 'instapay'
  | 'bank_transfer'
  | 'mobile_wallet'
  | 'web_payment'
  | 'voucher';

export type TxType = 'expense' | 'income' | 'transfer';
export type Nature = 'need' | 'want' | 'saving' | 'none';
export type CategoryKind = 'expense' | 'income';
export type TxSource = 'manual' | 'sms' | 'applepay' | 'claude' | 'import' | 'recurring';

export type Account = {
  id: ID;
  name: string;
  type: AccountType;
  currency: string;
  initialBalance: Minor;
  color: string;
  icon: string;
  defaultPaymentType: PaymentType;
  /** Last digits of cards/accounts that belong to this account, used to route bank SMS. */
  identifiers: string[];
  bankBalance: Minor | null;
  bankBalanceAt: number | null;
  excludeFromStats: boolean;
  archived: boolean;
  sortOrder: number;
  createdAt: number;
};

export type Category = {
  id: ID;
  parentId: ID | null;
  name: string;
  kind: CategoryKind;
  icon: string;
  color: string;
  nature: Nature;
  systemKey: string | null;
  archived: boolean;
  sortOrder: number;
};

export type PayeeKind = 'person' | 'merchant';

export type Payee = {
  id: ID;
  name: string;
  kind: PayeeKind;
  defaultCategoryId: ID | null;
  defaultAccountId: ID | null;
  autoConfirm: boolean;
  note: string | null;
  createdAt: number;
  lastUsedAt: number | null;
};

export type PayeeAlias = { raw: string; payeeId: ID; createdAt: number };

export type Transaction = {
  id: ID;
  type: TxType;
  amount: Minor;
  currency: string;
  accountId: ID;
  toAccountId: ID | null;
  toAmount: Minor | null;
  categoryId: ID | null;
  payeeId: ID | null;
  paymentType: PaymentType;
  date: number;
  note: string | null;
  isInstapay: boolean;
  /** Set on generated fee rows; points at the transfer/expense that caused the fee. */
  parentId: ID | null;
  natureOverride: Nature | null;
  originalAmount: Minor | null;
  originalCurrency: string | null;
  fxRate: number | null;
  /** Amount in the base currency (EGP) at the time of the transaction. */
  baseAmount: Minor;
  recurringId: ID | null;
  debtId: ID | null;
  /** People (payees) you spent it with, e.g. a dinner with friends. Empty when it was just you. */
  people: ID[];
  /** How a card charge in another currency was turned into the account's currency (see FxMethod). */
  fxMethod: FxMethod | null;
  /**
   * The bank hasn't settled this charge yet: it converts (or adds a cross-border fee) when it
   * posts, a few days later, without a message. Cleared once the amount is edited.
   */
  awaitingFinal: boolean;
  /** Mula's notes about the bank's amount (how it was worked out, later adjustments). */
  bankNotes: string[];
  source: TxSource;
  sourceRef: string | null;
  createdAt: number;
  updatedAt: number;
};

/**
 * How a foreign-currency card charge got its amount in the account's currency:
 * - available_limit: the drop in the card's available limit between two of its messages (the bank's own hold)
 * - markup: the market rate plus the bank's usual mark-up (no usable limit drop)
 * - market: the market rate alone
 */
export type FxMethod = 'available_limit' | 'markup' | 'market';

export type InboxSource = 'sms' | 'applepay' | 'claude' | 'recurring' | 'paste';
export type InboxStatus = 'pending' | 'confirmed' | 'dismissed' | 'merged';

export type SmsKind =
  | 'card_purchase'
  | 'applepay_purchase'
  | 'instapay_out'
  | 'instapay_in'
  | 'atm_withdrawal'
  | 'cash_deposit'
  | 'refund'
  | 'unknown_debit'
  | 'unknown_credit';

export type ParsedMessage = {
  kind: SmsKind;
  amount: Minor;
  currency: string;
  counterparty: string | null;
  last4: string | null;
  reference: string | null;
  occurredAt: number | null;
  balance: Minor | null;
  balanceCurrency: string | null;
  /** Credit cards: the available limit the message reports after this charge (not a balance). */
  availableLimit?: Minor | null;
  availableLimitCurrency?: string | null;
  /** Set when the message arrived: the card's limit didn't move by this message's amount alone. */
  limitCheck?: LimitCheck | null;
  /** A name for the account when there are no digits to go by (Wallet card name, Claude). */
  accountHint?: string | null;
  /** Category name suggested by the source (Claude). */
  categoryHint?: string | null;
  /** For transfers from Claude: the account the money went to. */
  toAccountHint?: string | null;
  note?: string | null;
};

/** What the available limit on a card message said about earlier charges (see cardLimitRepo). */
export type LimitCheck = {
  /** Expected limit minus the reported one: positive when the bank took more than this message's amount. */
  gap: Minor;
  /** The awaiting record the gap was added to (positive gap) or noted on (negative gap). */
  appliedTo: ID | null;
  note: string;
};

export type InboxItem = {
  id: ID;
  source: InboxSource;
  rawText: string;
  parsed: ParsedMessage | null;
  receivedAt: number;
  status: InboxStatus;
  transactionId: ID | null;
  recurringId: ID | null;
  note: string | null;
  resolvedAt: number | null;
};

export type Frequency = 'daily' | 'weekly' | 'monthly' | 'yearly';
export type RecurringEnd = 'never' | 'until' | 'count';
export type RecurringMode = 'auto' | 'confirm';

/** Fields shared by templates, recurring payments and drafts. */
export type TxPreset = {
  type: TxType;
  amount: Minor | null;
  currency: string | null;
  accountId: ID | null;
  toAccountId: ID | null;
  categoryId: ID | null;
  payeeId: ID | null;
  paymentType: PaymentType | null;
  note: string | null;
  isInstapay: boolean;
};

export type Recurring = TxPreset & {
  id: ID;
  name: string;
  frequency: Frequency;
  interval: number;
  startDate: number;
  endType: RecurringEnd;
  endDate: number | null;
  endCount: number | null;
  occurrences: number;
  nextDue: number | null;
  mode: RecurringMode;
  remindDaysBefore: number;
  active: boolean;
  createdAt: number;
  /** Amount of each occurrence (0-based); `amount` applies past its end or when absent. */
  schedule: Minor[] | null;
  /** Set when this series is the interest of a bank installment plan. */
  installment: InstallmentPlan | null;
};

/**
 * A card purchase the bank turned into monthly installments. The purchase itself stays one
 * expense for its full price (that's what the card owes); the plan's series logs only the
 * interest each statement adds, on the balance still unpaid.
 */
export type InstallmentPlan = {
  purchaseId: ID | null;
  principal: Minor;
  monthly: Minor;
  months: number;
  /** What the bank quoted in total; months × monthly when not given. */
  total: Minor;
  /** Monthly rate on the unpaid balance, as a fraction (0.027 for 2.7%). */
  monthlyRate: number;
};

export type Template = TxPreset & { id: ID; name: string; sortOrder: number; createdAt: number };

export type DebtDirection = 'lent' | 'borrowed';
export type DebtStatus = 'open' | 'closed';

export type Debt = {
  id: ID;
  direction: DebtDirection;
  payeeId: ID;
  accountId: ID | null;
  amount: Minor;
  currency: string;
  date: number;
  dueDate: number | null;
  note: string | null;
  status: DebtStatus;
  closedAt: number | null;
  createdAt: number;
};

export type TableName =
  | 'accounts'
  | 'categories'
  | 'payees'
  | 'payee_aliases'
  | 'transactions'
  | 'inbox_items'
  | 'recurring'
  | 'templates'
  | 'debts'
  | 'fx_rates'
  | 'settings';
