import { router, useLocalSearchParams } from 'expo-router';
import { addMonths } from 'date-fns';
import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';

import { Button } from '../../shared/components/Button';
import { DateTimeSheet } from '../../shared/components/DateTimeSheet';
import { toast } from '../../shared/components/Feedback';
import { TextField } from '../../shared/components/Fields';
import { ListRow, Section } from '../../shared/components/List';
import { Text } from '../../shared/components/Text';
import type { Transaction } from '../../shared/db/types';
import { Screen } from '../../shared/layouts/Screen';
import { dayLabel } from '../../shared/utils/dates';
import { formatMoney, parseAmount } from '../../shared/utils/money';
import { getTransaction } from '../../transactions/data/transactionsRepo';
import { createInstallmentPlan, planForPurchase } from '../data/installmentsRepo';
import { buildPlan, planSchedule } from '../utils/schedule';

/**
 * "Paid in installments" on a card purchase: the monthly installment and number of months as the
 * bank quoted them. The purchase keeps its full price; Mula then logs each month's interest.
 */
export default function InstallmentFormPage() {
  const { purchaseId } = useLocalSearchParams<{ purchaseId: string }>();
  const [purchase, setPurchase] = useState<Transaction | null | undefined>(undefined);
  const [hasPlan, setHasPlan] = useState(false);
  const [monthly, setMonthly] = useState('');
  const [months, setMonths] = useState('6');
  const [total, setTotal] = useState('');
  const [firstDue, setFirstDue] = useState<number | null>(null);
  const [dateOpen, setDateOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      const t = purchaseId ? await getTransaction(purchaseId) : null;
      setPurchase(t);
      if (t) {
        setFirstDue(addMonths(t.date, 1).getTime());
        setHasPlan(Boolean(await planForPurchase(t.id)));
      }
    })();
  }, [purchaseId]);

  const ccy = purchase?.currency;
  const m = parseAmount(monthly);
  const n = Math.round(Number(months));
  const tot = total.trim() ? parseAmount(total) : null;
  const valid = Boolean(purchase && m && m > 0 && Number.isFinite(n) && n >= 1 && n <= 120 && (tot ?? (m ?? 0) * n) >= (purchase?.amount ?? 0));
  const preview = useMemo(
    () => (valid && purchase ? planSchedule(buildPlan({ principal: purchase.amount, monthly: m!, months: n, total: tot })) : []),
    [valid, purchase, m, n, tot],
  );
  const interest = preview.reduce((a, r) => a + r.interest, 0);

  const save = async () => {
    if (!purchase || !valid) return;
    setSaving(true);
    try {
      const res = await createInstallmentPlan({ purchaseId: purchase.id, monthly: m!, months: n, total: tot, firstDue });
      toast(res.recurringId ? 'Installment plan added' : 'Interest-free: nothing extra to log');
      if (res.recurringId) router.replace({ pathname: '/recurring/[id]', params: { id: res.recurringId } });
      else router.back();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Couldn’t add the plan');
    } finally {
      setSaving(false);
    }
  };

  if (purchase === null) {
    return (
      <Screen title="Installments" back testID="installment-form">
        <Text variant="label" tone="graphite" className="px-5 pt-4">
          This record is gone.
        </Text>
      </Screen>
    );
  }
  if (!purchase) return <Screen title="Installments" back testID="installment-form">{null}</Screen>;

  return (
    <Screen
      title="Paid in installments"
      back
      testID="installment-form"
      footer={
        <View className="px-5 pb-1 pt-2">
          <Button label="Add plan" size="lg" full loading={saving} disabled={!valid || hasPlan} onPress={() => void save()} testID="installment-save" />
        </View>
      }
    >
      <Text variant="label" weight="regular" tone="graphite" className="px-5 pt-3">
        The {formatMoney(purchase.amount, { currency: ccy })} purchase stays as it is: that’s what your card owes. Mula adds the interest each statement
        charges on what’s still unpaid. Pay your statements as usual.
      </Text>
      {hasPlan ? (
        <Text variant="label" tone="alert" className="px-5 pt-3">
          This purchase already has an installment plan.
        </Text>
      ) : null}
      <TextField label="Monthly installment" value={monthly} onChangeText={setMonthly} placeholder="e.g. 274.07" keyboardType="decimal-pad" testID="installment-monthly" />
      <TextField label="Number of months" value={months} onChangeText={setMonths} keyboardType="number-pad" testID="installment-months" />
      <TextField
        label="Total the bank quoted"
        value={total}
        onChangeText={setTotal}
        placeholder="Optional"
        hint="Fixes the last installment’s rounding (e.g. 1,644.40)."
        keyboardType="decimal-pad"
        testID="installment-total"
      />
      <Section>
        <ListRow
          title="First installment billed"
          value={firstDue ? dayLabel(firstDue) : 'Not set'}
          onPress={() => setDateOpen(true)}
          divider={false}
          testID="installment-first-due"
        />
      </Section>
      {preview.length ? (
        <Section title="Interest by month" footer={`${formatMoney(interest, { currency: ccy })} in total.`}>
          {preview.map((r, i) => (
            <ListRow
              key={r.n}
              title={`Month ${r.n + 1}`}
              subtitle={`${formatMoney(r.remaining, { currency: ccy })} still owed after`}
              value={formatMoney(r.interest, { currency: ccy })}
              divider={i < preview.length - 1}
            />
          ))}
        </Section>
      ) : null}
      <DateTimeSheet
        visible={dateOpen}
        value={firstDue ?? Date.now()}
        withTime={false}
        title="First installment billed"
        onClose={() => setDateOpen(false)}
        onChange={(d) => setFirstDue(d)}
      />
    </Screen>
  );
}
