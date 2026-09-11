import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Relationship } from '../../domain/models';
import type { getRepository } from '../../data/repository';

type RepositoryPromise = ReturnType<typeof getRepository>;

type Props = {
  repositoryPromise: RepositoryPromise;
  onComplete: (relationship: Relationship) => void;
};

export function SetupScreen({ repositoryPromise, onComplete }: Props) {
  const [step, setStep] = useState<'partner' | 'own' | 'together'>('partner');
  const [partnerNickname, setPartnerNickname] = useState('');
  const [ownName, setOwnName] = useState('');
  const [dateText, setDateText] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async (togetherSince: number | null) => {
    if (!partnerNickname.trim() || !ownName.trim() || saving) return;
    setSaving(true);
    try {
      const repository = await repositoryPromise;
      await repository.saveSetup({
        partnerNickname: partnerNickname.trim(),
        ownName: ownName.trim(),
        togetherSince,
      });
      const relationship = await repository.getRelationship();
      if (relationship) onComplete(relationship);
    } finally {
      setSaving(false);
    }
  };

  if (step === 'partner') {
    return (
      <SetupStep title="who are they?" value={partnerNickname} placeholder="their nickname..." onChangeText={setPartnerNickname} button="yep!" disabled={!partnerNickname.trim()} onPress={() => setStep('own')} />
    );
  }

  if (step === 'own') {
    return (
      <SetupStep title="who are you?" value={ownName} placeholder="your name..." onChangeText={setOwnName} button="that's me!" disabled={!ownName.trim()} onPress={() => setStep('together')} />
    );
  }

  const parsed = Date.parse(dateText.trim());
  return (
    <View style={styles.container}>
      <Text style={styles.logo}>rucola</Text>
      <Text style={styles.heading}>{partnerNickname} & {ownName} have been together since...</Text>
      <TextInput
        value={dateText}
        onChangeText={setDateText}
        placeholder="YYYY-MM-DD"
        autoFocus
        style={styles.input}
      />
      <Button label={saving ? 'saving...' : 'yep!'} disabled={saving} onPress={() => void save(Number.isNaN(parsed) ? null : parsed)} />
      <Text style={styles.or}>or</Text>
      <Pressable disabled={saving} onPress={() => void save(null)}>
        <Text style={styles.link}>shh... not yet</Text>
      </Pressable>
    </View>
  );
}

function SetupStep({
  title,
  value,
  placeholder,
  onChangeText,
  button,
  disabled,
  onPress,
}: {
  title: string;
  value: string;
  placeholder: string;
  onChangeText: (value: string) => void;
  button: string;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <View style={styles.container}>
      <Text style={styles.logo}>rucola</Text>
      <Text style={styles.heading}>{title}</Text>
      <TextInput value={value} onChangeText={onChangeText} placeholder={placeholder} autoFocus style={styles.input} returnKeyType="done" onSubmitEditing={() => !disabled && onPress()} />
      <Button label={button} disabled={disabled} onPress={onPress} />
    </View>
  );
}

function Button({ label, disabled, onPress }: { label: string; disabled?: boolean; onPress: () => void }) {
  return <Pressable disabled={disabled} onPress={onPress} style={[styles.button, disabled && styles.disabled]}><Text style={styles.buttonText}>{label}</Text></Pressable>;
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 28, justifyContent: 'center' },
  logo: { fontSize: 42, fontWeight: '800', alignSelf: 'center', marginBottom: 48 },
  heading: { fontSize: 28, fontWeight: '700', lineHeight: 34, marginBottom: 28 },
  input: { borderBottomWidth: 2, borderBottomColor: '#8FC56A', fontSize: 18, paddingVertical: 12, marginBottom: 28 },
  button: { alignSelf: 'flex-start', backgroundColor: '#1D2A1B', borderRadius: 18, paddingHorizontal: 24, paddingVertical: 13 },
  disabled: { opacity: 0.35 },
  buttonText: { color: '#F3F6E9', fontSize: 18, fontWeight: '700' },
  or: { textAlign: 'center', marginVertical: 16, opacity: 0.6 },
  link: { textAlign: 'center', textDecorationLine: 'underline', fontSize: 18 },
});
