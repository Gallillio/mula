import { format } from 'date-fns';
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';

import { useAccounts } from '../../accounts/data/accountsRepo';
import { Button } from '../../shared/components/Button';
import { toast } from '../../shared/components/Feedback';
import { Divider, ListRow, Section } from '../../shared/components/List';
import { Money } from '../../shared/components/Money';
import { Text } from '../../shared/components/Text';
import type { Account, ID } from '../../shared/db/types';
import { Screen } from '../../shared/layouts/Screen';
import { getSettings, useSettings } from '../../shared/settings/settingsStore';
import { pickTextFile } from '../../shared/utils/files';
import { goBack } from '../../shared/utils/nav';
import { AccountPicker } from '../../transactions/components/Pickers';
import { FieldRow } from '../../transactions/components/FieldRow';
import { ImportProgress, StepHeader } from '../components/StepHeader';
import { countLabel, formatCount } from '../utils/format';
import { accountForDigits, importStatement, planStatement, type RowDecision, type StatementImportResult, type StatementPlan } from '../utils/importStatement';
import { parseStatement, type StatementFile, type StatementRow } from '../utils/statements';

type Step = 'pick' | 'review' | 'importing' | 'done';

const PREVIEW_COUNT = 8;

const FORMAT_LABEL: Record<StatementFile['format'], string> = { account: 'HSBC account statement', card: 'HSBC credit card statement' };

/** The account a statement most likely belongs to: the card's digits, else the last used bank account. */
function guessAccount(file: StatementFile, accounts: Account[], lastAccountId: ID | null): ID | null {
  const active = accounts.filter((a) => !a.archived);
  if (file.format === 'card') return accountForDigits(active, file.accountDigits)?.id ?? active.find((a) => a.type === 'card')?.id ?? null;
  const banks = active.filter((a) => a.type === 'bank');
  return banks.find((a) => /hsbc/i.test(a.name))?.id ?? banks.find((a) => a.id === lastAccountId)?.id ?? banks[0]?.id ?? active[0]?.id ?? null;
}

export default function StatementImportPage() {
  const lastAccountId = useSettings((s) => s.lastAccountId);
  const { data: accounts } = useAccounts();
  const [step, setStep] = useState<Step>('pick');
  const [file, setFile] = useState<{ name: string; statement: StatementFile } | null>(null);
  const [accountId, setAccountId] = useState<ID | null>(null);
  const [plan, setPlan] = useState<StatementPlan | null>(null);
  const [sheet, setSheet] = useState(false);
  const [reading, setReading] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState<StatementImportResult | null>(null);

  const account = accounts?.find((a) => a.id === accountId) ?? null;
  // The shown plan is stale until it has been worked out for this file and account.
  const planning = !plan || plan.accountId !== accountId || plan.file !== file?.statement;

  // Re-check against Mula's records whenever the file or the account changes.
  useEffect(() => {
    if (!file || !accountId) return;
    let alive = true;
    planStatement(file.statement, accountId)
      .then((p) => alive && setPlan(p))
      .catch(() => alive && toast('Couldn’t check the statement against your records'));
    return () => {
      alive = false;
    };
  }, [file, accountId]);

  const pick = async () => {
    setReading(true);
    try {
      const picked = await pickTextFile('csv');
      if (!picked) return;
      const statement = parseStatement(picked.text, getSettings().instapayFee);
      if (!statement || !statement.rows.length) {
        toast('Mula can’t read this file as a statement yet. Try Import CSV instead.');
        return;
      }
      setFile({ name: picked.name, statement });
      setPlan(null);
      setAccountId(guessAccount(statement, accounts ?? [], lastAccountId));
      setStep('review');
    } catch {
      toast('Couldn’t read that file');
    } finally {
      setReading(false);
    }
  };

  const runImport = async () => {
    if (!plan) return;
    setProgress({ done: 0, total: plan.decisions.length });
    setStep('importing');
    try {
      const res = await importStatement(plan, (done, total) => {
        if (done === total || done % 5 === 0) setProgress({ done, total });
      });
      setResult(res);
      setStep('done');
      toast(`Imported ${countLabel(res.created, 'record')}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Couldn’t import the statement');
      setStep('review');
    }
  };

  const leave = () => (router.canGoBack() ? goBack() : router.replace('/data'));
  const onBack = () => {
    if (step === 'importing') toast('Wait until the import finishes');
    else if (step === 'review') setStep('pick');
    else leave();
  };

  const newRows = useMemo(() => (plan?.decisions ?? []).filter((d) => d.action === 'new'), [plan]);
  const toSave = plan ? plan.counts.new + plan.counts.linked : 0;

  const footer =
    step === 'pick' ? (
      <Button label="Choose a statement file" size="lg" full loading={reading} onPress={pick} testID="statement-pick" />
    ) : step === 'review' ? (
      <Button
        label={!account ? 'Choose an account' : planning || !plan ? 'Checking your records…' : toSave ? `Import ${countLabel(toSave, 'record')}` : 'Nothing new to import'}
        size="lg"
        full
        disabled={!account || planning || !plan || !toSave}
        onPress={runImport}
        testID="statement-import"
      />
    ) : step === 'done' ? (
      <Button label="Done" size="lg" full onPress={leave} testID="statement-done" />
    ) : undefined;

  const s = file?.statement;

  return (
    <Screen title="Import bank statement" back={onBack} footer={footer} testID="statement-import-page">
      {step === 'pick' ? (
        <StepHeader
          step={1}
          of={2}
          title="Choose a statement file"
          body="In HSBC online banking, open an account or card, pick the dates under Search, then Download › Spreadsheet (CSV). Mula checks every row against what it already has, so nothing is added twice."
        />
      ) : null}

      {step === 'review' && s && file ? (
        <>
          <StepHeader
            step={2}
            of={2}
            title="Check before importing"
            body={`${FORMAT_LABEL[s.format]}: ${countLabel(s.rows.length, 'transaction')}${s.firstDate && s.lastDate ? `, ${format(s.firstDate, 'd MMM yyyy')} to ${format(s.lastDate, 'd MMM yyyy')}` : ''}.`}
          />

          <Section title="Account" footer={s.format === 'card' && s.accountDigits ? `The file is for the card ending ${s.accountDigits}.` : 'The account these transactions belong to.'}>
            <FieldRow
              testID="statement-account"
              label="Account"
              value={account?.name}
              needed
              left={account ? <View className="h-2 w-2 rounded-full" style={{ backgroundColor: account.color }} /> : null}
              divider={false}
              onPress={() => setSheet(true)}
            />
          </Section>

          {plan && !planning ? (
            <Section
              title="What happens"
              footer="Transfers go between your accounts when the other card or account has its digits added in Mula. Records from your other bank that are the other half of a transfer become that transfer."
            >
              <ListRow title="New records" value={formatCount(plan.counts.new - plan.counts.transfers)} testID="statement-count-new" />
              <ListRow title="Transfers between your accounts" value={formatCount(plan.counts.transfers)} testID="statement-count-transfers" />
              <ListRow title="Linked with your other bank’s records" value={formatCount(plan.counts.linked)} testID="statement-count-linked" />
              <ListRow title="Already in Mula" subtitle="From bank messages, Apple Pay or by hand" value={formatCount(plan.counts.exists)} testID="statement-count-exists" />
              <ListRow
                title="Skipped"
                subtitle="Imported before, or undone by the bank (ATM retries, reversed transfers)"
                value={formatCount(plan.counts.alreadyImported + s.cancelled)}
                divider={false}
                testID="statement-count-skipped"
              />
            </Section>
          ) : (
            <View className="px-5 pt-4">
              <Text variant="caption" tone="graphite">
                Checking against your records…
              </Text>
            </View>
          )}

          {newRows.length ? (
            <Section title="Newest to add" footer={newRows.length > PREVIEW_COUNT ? `And ${formatCount(newRows.length - PREVIEW_COUNT)} more.` : undefined}>
              {[...newRows]
                .reverse()
                .slice(0, PREVIEW_COUNT)
                .map((d, i, arr) => (
                  <PreviewRow key={d.row.index} decision={d} accounts={accounts ?? []} divider={i < arr.length - 1} />
                ))}
            </Section>
          ) : null}
        </>
      ) : null}

      {step === 'importing' ? <ImportProgress done={progress.done} total={progress.total} /> : null}

      {step === 'done' && result ? (
        <>
          <StepHeader title={`Imported ${countLabel(result.created, 'record')}`} body="Find them in Records. Anything under Others › Missing still needs a category." />
          <Section>
            <ListRow title="Added" value={formatCount(result.created)} testID="statement-result-created" />
            <ListRow title="Linked as transfers" value={formatCount(result.linked)} testID="statement-result-linked" />
            <ListRow title="Already in Mula" value={formatCount(result.skipped)} divider={Boolean(result.failed)} testID="statement-result-skipped" />
            {result.failed ? (
              <ListRow title="Couldn’t be saved" subtitle="Usually a currency without an exchange rate" value={formatCount(result.failed)} divider={false} testID="statement-result-failed" />
            ) : null}
          </Section>
        </>
      ) : null}

      <AccountPicker visible={sheet} onClose={() => setSheet(false)} selected={accountId} onSelect={setAccountId} title="Statement account" />
    </Screen>
  );
}

const KIND_LABEL: Record<StatementRow['kind'], string> = {
  purchase: 'Card payment',
  instapay_out: 'InstaPay sent',
  instapay_in: 'InstaPay received',
  own_transfer_out: 'Transfer',
  own_transfer_in: 'Transfer',
  salary: 'Salary',
  fee: 'Bank fee',
  atm_withdrawal: 'ATM withdrawal',
  cash_deposit: 'Cash deposit',
  refund: 'Refund',
  other_out: 'Money out',
  other_in: 'Money in',
};

function PreviewRow({ decision, accounts, divider }: { decision: RowDecision; accounts: Account[]; divider: boolean }) {
  const r = decision.row;
  const transfer = decision.action === 'new' ? decision.transfer : null;
  const other = transfer ? accounts.find((a) => a.id === (r.direction === 'out' ? transfer.toId : transfer.fromId)) : null;
  const title = other ? `${r.direction === 'out' ? 'To' : 'From'} ${other.name}` : (r.counterparty ?? (r.otherDigits ? `Account ending ${r.otherDigits}` : KIND_LABEL[r.kind]));
  const details = [format(r.date, 'd MMM yyyy'), KIND_LABEL[r.kind], r.original ? `${r.original.currency} ${(r.original.amount / 100).toFixed(2)}` : null].filter(Boolean).join(', ');
  return (
    <View>
      <View className="min-h-[56px] flex-row items-center px-5 py-3">
        <View className="flex-1 pr-3">
          <Text variant="body" numberOfLines={1}>
            {title}
          </Text>
          <Text variant="caption" tone="graphite" numberOfLines={1} className="mt-0.5">
            {details}
          </Text>
        </View>
        <Money minor={r.direction === 'out' ? -r.amount : r.amount} size="sm" colorIncome sign="always" />
      </View>
      {divider ? <Divider /> : null}
    </View>
  );
}
