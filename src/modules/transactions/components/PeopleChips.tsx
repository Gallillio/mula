import { useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';

import { useSuggestedPeople } from '../../payees/data/payeesRepo';
import { Chip } from '../../shared/components/Chip';
import { Text } from '../../shared/components/Text';
import { PeoplePicker, type PayeeChoice } from './Pickers';

const keyOf = (c: PayeeChoice) => c.payeeId ?? `new:${c.name.toLowerCase()}`;

/**
 * "Spent with" as one row of chips: who's picked, then the people you tag most, then a chip
 * that opens the full picker. Tapping a chip adds or removes that person.
 */
export function PeopleChips({ value, onChange, testID = 'people-chips' }: { value: PayeeChoice[]; onChange: (people: PayeeChoice[]) => void; testID?: string }) {
  const { data: suggested } = useSuggestedPeople(8);
  const [open, setOpen] = useState(false);
  const scroller = useRef<ScrollView>(null);
  // Picked people are listed first; bring them into view whenever the choice changes.
  useEffect(() => {
    scroller.current?.scrollTo({ x: 0, animated: true });
  }, [value.length]);
  const picked = new Set(value.map(keyOf));
  const others = (suggested ?? []).map((p) => ({ payeeId: p.id, name: p.name })).filter((c) => !picked.has(keyOf(c)));
  const toggle = (c: PayeeChoice) => onChange(picked.has(keyOf(c)) ? value.filter((v) => keyOf(v) !== keyOf(c)) : [...value, c]);

  return (
    <View testID={testID}>
      <Text variant="label" tone="graphite">
        {value.length ? 'Spent with' : 'Spent with anyone?'}
      </Text>
      <ScrollView ref={scroller} horizontal showsHorizontalScrollIndicator={false} className="mt-2 flex-grow-0" contentContainerStyle={{ gap: 8 }} keyboardShouldPersistTaps="handled">
        <Chip label="Add" icon="plus" onPress={() => setOpen(true)} testID={`${testID}-more`} />
        {value.map((c) => (
          <Chip key={keyOf(c)} label={c.name} selected trailingIcon="x" onPress={() => toggle(c)} testID={`people-chip-on-${c.name}`} />
        ))}
        {others.slice(0, 6).map((c) => (
          <Chip key={keyOf(c)} label={c.name} onPress={() => toggle(c)} testID={`people-chip-${c.name}`} />
        ))}
      </ScrollView>
      <PeoplePicker visible={open} onClose={() => setOpen(false)} selected={value} onDone={onChange} />
    </View>
  );
}
