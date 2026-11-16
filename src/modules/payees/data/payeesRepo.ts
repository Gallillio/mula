import { all, bool, first, int, run, transaction, write } from '../../shared/db/client';
import { useLiveQuery } from '../../shared/db/live';
import type { ID, Payee, PayeeKind } from '../../shared/db/types';
import { newId } from '../../shared/utils/id';
import { normalizeRaw } from '../../shared/utils/text';

type PayeeRow = {
  id: string;
  name: string;
  kind: PayeeKind;
  default_category_id: string | null;
  default_account_id: string | null;
  auto_confirm: number;
  note: string | null;
  created_at: number;
  last_used_at: number | null;
};

const toPayee = (r: PayeeRow): Payee => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  defaultCategoryId: r.default_category_id,
  defaultAccountId: r.default_account_id,
  autoConfirm: bool(r.auto_confirm),
  note: r.note,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
});

export async function listPayees(): Promise<Payee[]> {
  const rows = await all<PayeeRow>('SELECT * FROM payees ORDER BY COALESCE(last_used_at, created_at) DESC');
  return rows.map(toPayee);
}

export async function getPayee(id: ID): Promise<Payee | null> {
  const r = await first<PayeeRow>('SELECT * FROM payees WHERE id = ?', [id]);
  return r ? toPayee(r) : null;
}

export async function findPayeeByName(name: string): Promise<Payee | null> {
  const r = await first<PayeeRow>('SELECT * FROM payees WHERE name = ? COLLATE NOCASE', [name.trim()]);
  return r ? toPayee(r) : null;
}

/** Returns the payee with this name, creating it on first use. */
export async function findOrCreatePayee(name: string, kind: PayeeKind = 'merchant'): Promise<Payee> {
  const existing = await findPayeeByName(name);
  if (existing) return existing;
  const id = newId();
  const now = Date.now();
  await write(
    ['payees'],
    'INSERT INTO payees (id, name, kind, auto_confirm, created_at) VALUES (?, ?, ?, 0, ?)',
    [id, name.trim(), kind, now],
  );
  return (await getPayee(id))!;
}

/** Payee ids for people picked by name or id; new names are saved as people. */
export async function idsForPeople(choices: readonly { payeeId: ID | null; name: string }[]): Promise<ID[]> {
  const ids: ID[] = [];
  for (const c of choices) {
    const id = c.payeeId ?? (c.name.trim() ? (await findOrCreatePayee(c.name, 'person')).id : null);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

export type PayeeInput = {
  id: ID;
  name: string;
  kind: PayeeKind;
  defaultCategoryId: ID | null;
  defaultAccountId: ID | null;
  autoConfirm: boolean;
  note: string | null;
};

export async function updatePayee(p: PayeeInput): Promise<void> {
  await write(
    ['payees'],
    `UPDATE payees SET name = ?, kind = ?, default_category_id = ?, default_account_id = ?, auto_confirm = ?, note = ? WHERE id = ?`,
    [p.name.trim(), p.kind, p.defaultCategoryId, p.defaultAccountId, int(p.autoConfirm), p.note, p.id],
  );
}

/** Remembers the last category and account used with a payee so the next entry pre-fills. */
export async function learnFromUse(payeeId: ID, categoryId: ID | null, accountId: ID | null): Promise<void> {
  await write(
    ['payees'],
    `UPDATE payees SET last_used_at = ?,
       default_category_id = COALESCE(?, default_category_id),
       default_account_id = COALESCE(?, default_account_id)
     WHERE id = ?`,
    [Date.now(), categoryId, accountId, payeeId],
  );
}

/** Records that list `id` among the people they were spent with. */
const LISTS_PERSON = `EXISTS (SELECT 1 FROM json_each(COALESCE(transactions.people, '[]')) WHERE value = ?)`;

/**
 * Rewrites the people lists that mention `fromId`: drops it, or swaps in `intoId` (merge).
 * Lists stay unique and become NULL when nobody is left.
 */
async function rewritePeople(fromId: ID, intoId: ID | null): Promise<void> {
  await run(
    `UPDATE transactions SET people = (
       SELECT CASE WHEN COUNT(*) = 0 THEN NULL ELSE json_group_array(v) END FROM (
         SELECT DISTINCT CASE WHEN value = ? THEN ? ELSE value END AS v FROM json_each(transactions.people)
       ) WHERE v IS NOT NULL
     ) WHERE ${LISTS_PERSON}`,
    [fromId, intoId, fromId],
  );
}

export async function deletePayee(id: ID): Promise<void> {
  await transaction(['payees', 'payee_aliases', 'transactions', 'templates', 'recurring'], async () => {
    await rewritePeople(id, null);
    await run('UPDATE transactions SET payee_id = NULL WHERE payee_id = ?', [id]);
    await run('UPDATE templates SET payee_id = NULL WHERE payee_id = ?', [id]);
    await run('UPDATE recurring SET payee_id = NULL WHERE payee_id = ?', [id]);
    await run('DELETE FROM payee_aliases WHERE payee_id = ?', [id]);
    await run('DELETE FROM payees WHERE id = ?', [id]);
  });
}

/** Moves everything from `fromId` to `intoId` (transactions, aliases, debts) and deletes `fromId`. */
export async function mergePayees(fromId: ID, intoId: ID): Promise<void> {
  if (fromId === intoId) return;
  await transaction(['payees', 'payee_aliases', 'transactions', 'debts', 'templates', 'recurring'], async () => {
    await rewritePeople(fromId, intoId);
    await run('UPDATE transactions SET payee_id = ? WHERE payee_id = ?', [intoId, fromId]);
    await run('UPDATE payee_aliases SET payee_id = ? WHERE payee_id = ?', [intoId, fromId]);
    await run('UPDATE debts SET payee_id = ? WHERE payee_id = ?', [intoId, fromId]);
    await run('UPDATE templates SET payee_id = ? WHERE payee_id = ?', [intoId, fromId]);
    await run('UPDATE recurring SET payee_id = ? WHERE payee_id = ?', [intoId, fromId]);
    await run('DELETE FROM payees WHERE id = ?', [fromId]);
  });
}

/* ---------- Aliases: raw bank names -> payees ---------- */

export async function resolveAlias(raw: string | null): Promise<Payee | null> {
  if (!raw) return null;
  const key = normalizeRaw(raw);
  if (!key) return null;
  const r = await first<PayeeRow>(
    'SELECT p.* FROM payee_aliases a JOIN payees p ON p.id = a.payee_id WHERE a.raw = ?',
    [key],
  );
  return r ? toPayee(r) : null;
}

export async function listAliases(payeeId: ID): Promise<string[]> {
  const rows = await all<{ raw: string }>('SELECT raw FROM payee_aliases WHERE payee_id = ? ORDER BY raw', [payeeId]);
  return rows.map((r) => r.raw);
}

/**
 * Points a raw bank name at a payee. With `relabelPast`, transactions that were filed under
 * the payee this alias used to point at move over too, and that payee is removed if empty.
 */
export async function setAlias(raw: string, payeeId: ID, opts: { relabelPast?: boolean } = {}): Promise<void> {
  const key = normalizeRaw(raw);
  if (!key) return;
  await transaction(['payee_aliases', 'payees', 'transactions'], async () => {
    const prev = await first<{ payee_id: string }>('SELECT payee_id FROM payee_aliases WHERE raw = ?', [key]);
    await run('INSERT OR REPLACE INTO payee_aliases (raw, payee_id, created_at) VALUES (?, ?, ?)', [key, payeeId, Date.now()]);
    if (opts.relabelPast && prev && prev.payee_id !== payeeId) {
      await run('UPDATE transactions SET payee_id = ? WHERE payee_id = ?', [payeeId, prev.payee_id]);
      const left = await first<{ n: number }>(
        `SELECT (SELECT COUNT(*) FROM transactions WHERE payee_id = ?) + (SELECT COUNT(*) FROM payee_aliases WHERE payee_id = ?)
           + (SELECT COUNT(*) FROM debts WHERE payee_id = ?) + (SELECT COUNT(*) FROM transactions WHERE ${LISTS_PERSON}) AS n`,
        [prev.payee_id, prev.payee_id, prev.payee_id, prev.payee_id],
      );
      if (!left?.n) await run('DELETE FROM payees WHERE id = ?', [prev.payee_id]);
    }
  });
}

export async function removeAlias(raw: string): Promise<void> {
  await write(['payee_aliases'], 'DELETE FROM payee_aliases WHERE raw = ?', [normalizeRaw(raw)]);
}

/** Recent payees used with InstaPay, for the "who did you send it to?" chips. */
export async function recentInstapayPayees(limit = 8): Promise<Payee[]> {
  const rows = await all<PayeeRow>(
    `SELECT p.* FROM payees p JOIN transactions t ON t.payee_id = p.id
     WHERE t.is_instapay = 1 AND t.parent_id IS NULL
     GROUP BY p.id ORDER BY MAX(t.date) DESC LIMIT ?`,
    [limit],
  );
  return rows.map(toPayee);
}

/**
 * People to offer for "spent with": the ones you tag most recently first, then other people
 * (payees marked as a person) you've dealt with lately.
 */
export async function suggestedPeople(limit = 8): Promise<Payee[]> {
  const tagged = await all<PayeeRow>(
    `SELECT p.* FROM transactions t, json_each(t.people) j JOIN payees p ON p.id = j.value
     WHERE t.people IS NOT NULL AND t.parent_id IS NULL
     GROUP BY p.id ORDER BY MAX(t.date) DESC LIMIT ?`,
    [limit],
  );
  if (tagged.length >= limit) return tagged.map(toPayee);
  const seen = new Set(tagged.map((r) => r.id));
  const others = await all<PayeeRow>(
    "SELECT * FROM payees WHERE kind = 'person' ORDER BY COALESCE(last_used_at, created_at) DESC LIMIT ?",
    [limit * 2],
  );
  return [...tagged, ...others.filter((r) => !seen.has(r.id))].slice(0, limit).map(toPayee);
}

export function useSuggestedPeople(limit = 8) {
  return useLiveQuery(['payees', 'transactions'], () => suggestedPeople(limit), [limit]);
}

export type PayeeUsage = { records: number; debts: number; sharedRecords: number };

/** How many records and debts point at a payee (fee rows not counted), and records spent with them. */
export async function getPayeeUsage(id: ID): Promise<PayeeUsage> {
  const r = await first<PayeeUsage>(
    `SELECT (SELECT COUNT(*) FROM transactions WHERE payee_id = ? AND parent_id IS NULL) AS records,
            (SELECT COUNT(*) FROM debts WHERE payee_id = ?) AS debts,
            (SELECT COUNT(*) FROM transactions WHERE parent_id IS NULL AND ${LISTS_PERSON}) AS sharedRecords`,
    [id, id, id],
  );
  return { records: r?.records ?? 0, debts: r?.debts ?? 0, sharedRecords: r?.sharedRecords ?? 0 };
}

export function usePayees() {
  return useLiveQuery(['payees'], listPayees);
}

export function usePayee(id: ID | null | undefined) {
  return useLiveQuery(['payees'], async () => (id ? getPayee(id) : null), [id]);
}

export function usePayeeAliases(id: ID | null | undefined) {
  return useLiveQuery(['payee_aliases'], async () => (id ? listAliases(id) : []), [id]);
}

export function usePayeeUsage(id: ID | null | undefined) {
  return useLiveQuery(['transactions', 'debts', 'payees'], async () => (id ? getPayeeUsage(id) : { records: 0, debts: 0, sharedRecords: 0 }), [id]);
}
