import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { getRepository } from '../../data/repository';
import type { Relationship } from '../../domain/models';
import { GetRelationship, SaveSetup } from '../../domain/useCases';

type Props = {
  repositoryPromise: ReturnType<typeof getRepository>;
  onComplete: (relationship: Relationship) => void;
};

type Step = 'partner' | 'own' | 'together';

export function SetupScreen({ repositoryPromise, onComplete }: Props) {
  const [step, setStep] = useState<Step>('partner');
  const [partnerNickname, setPartnerNickname] = useState('');
  const [ownName, setOwnName] = useState('');
  const [dateText, setDateText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (togetherSince: number | null) => {
    if (!partnerNickname.trim() || !ownName.trim() || saving) return;

    setSaving(true);
    setError(null);
    try {
      const repository = await repositoryPromise;
      await new SaveSetup(repository).execute({
        partnerNickname,
        ownName,
        togetherSince,
      });
      const relationship = await new GetRelationship(repository).execute();
      if (relationship) onComplete(relationship);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save setup.');
    } finally {
      setSaving(false);
    }
  };

  const parsedDate = parseTogetherSince(dateText);

  if (step === 'partner') {
    return (
      <SetupStep
        title="who are they?"
        value={partnerNickname}
        placeholder="their nickname..."
        onChangeText={(value) => { setError(null); setPartnerNickname(value); }}
        button="yep!"
        disabled={!partnerNickname.trim()}
        onPress={() => setStep('own')}
        error={error}
      />
    );
  }

  if (step === 'own') {
    return (
      <SetupStep
        title="who are you?"
        value={ownName}
        placeholder="your name..."
        onChangeText={(value) => { setError(null); setOwnName(value); }}
        button="that's me!"
        disabled={!ownName.trim()}
        onPress={() => setStep('together')}
        error={error}
      />
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.logo}>rucola</Text>
      <Text style={styles.heading}>{partnerNickname.trim()} & {ownName.trim()} have been together since...</Text>
      <TextInput
        value={dateText}
        onChangeText={(value) => { setError(null); setDateText(value); }}
        placeholder="YYYY-MM-DD"
        autoFocus
        style={styles.input}
        keyboardType="numbers-and-punctuation"
        returnKeyType="done"
      />
      {dateText.trim() && parsedDate === null ? <Text style={styles.error}>Use a valid date in YYYY-MM-DD format.</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Button
        label={saving ? 'saving...' : 'yep!'}
        disabled={saving || (dateText.trim() !== '' && parsedDate === null)}
        onPress={() => void save(parsedDate)}
      />
      <Text style={styles.or}>or</Text>
      <Pressable disabled={saving} onPress={() => void save(null)}>
        <Text style={styles.link}>shh... not yet</Text>
      </Pressable>
    </View>
  );
}

function parseTogetherSince(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);

  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date.getTime();
}

function SetupStep({ title, value, placeholder, onChangeText, button, disabled, onPress, error }: {
  title: string;
  value: string;
  placeholder: string;
  onChangeText: (value: string) => void;
  button: string;
  disabled: boolean;
  onPress: () => void;
  error: string | null;
}) {
  return (
    <View style={styles.container}>
      <Text style={styles.logo}>rucola</Text>
      <Text style={styles.heading}>{title}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        autoFocus
        style={styles.input}
        returnKeyType="done"
        onSubmitEditing={() => !disabled && onPress()}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
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
  input: { borderBottomWidth: 2, borderBottomColor: '#8FC56A', fontSize: 18, paddingVertical: 12, marginBottom: 10 },
  button: { alignSelf: 'flex-start', backgroundColor: '#1D2A1B', borderRadius: 18, paddingHorizontal: 24, paddingVertical: 13, marginTop: 18 },
  disabled: { opacity: 0.35 },
  buttonText: { color: '#F3F6E9', fontSize: 18, fontWeight: '700' },
  or: { textAlign: 'center', marginVertical: 16, opacity: 0.6 },
  link: { textAlign: 'center', textDecorationLine: 'underline', fontSize: 18 },
  error: { color: '#9B2C2C', marginTop: 4 },
});
