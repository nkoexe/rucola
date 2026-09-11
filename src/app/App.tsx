import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { getRepository } from '../data/repository';
import type { Message, Relationship } from '../domain/models';
import { colors } from '../design/colors';
import { typography } from '../design/typography';

const repoPromise = getRepository();
type SetupStep = 'partner' | 'own' | 'together';

export default function App() {
  const [relationship, setRelationship] = useState<Relationship | null>(null);
  const [partnerMessage, setPartnerMessage] = useState<Message | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let mounted = true;
    repoPromise
      .then(async (repository) => {
        const value = await repository.getRelationship();
        const message = value ? await repository.getActiveMessage('PARTNER') : null;
        if (mounted) {
          setRelationship(value);
          setPartnerMessage(message);
          setReady(true);
        }
      })
      .catch(() => mounted && setReady(true));
    return () => { mounted = false; };
  }, []);

  if (!ready) return <LoadingScreen />;
  if (!relationship) return <Setup onComplete={setRelationship} />;
  return <Home relationship={relationship} partnerMessage={partnerMessage} />;
}

function LoadingScreen() {
  return <Screen><Text style={styles.logo}>rucola</Text><Text style={styles.muted}>getting things ready...</Text></Screen>;
}

function Setup({ onComplete }: { onComplete: (relationship: Relationship) => void }) {
  const [step, setStep] = useState<SetupStep>('partner');
  const [partnerNickname, setPartnerNickname] = useState('');
  const [ownName, setOwnName] = useState('');
  const [dateText, setDateText] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async (togetherSince: number | null) => {
    if (!partnerNickname.trim() || !ownName.trim()) return;
    setSaving(true);
    const repository = await repoPromise;
    await repository.saveSetup({ partnerNickname: partnerNickname.trim(), ownName: ownName.trim(), togetherSince });
    const relationship = await repository.getRelationship();
    if (relationship) onComplete(relationship);
    setSaving(false);
  };

  const continueFromTogether = () => {
    const parsed = dateText.trim() ? Date.parse(dateText.trim()) : NaN;
    void save(Number.isNaN(parsed) ? null : parsed);
  };

  return (
    <Screen>
      <Text style={styles.logo}>rucola</Text>
      {step === 'partner' && <SetupStepView title="who are they?" placeholder="their nickname..." value={partnerNickname} onChangeText={setPartnerNickname} button="yep!" disabled={!partnerNickname.trim()} onPress={() => setStep('own')} />}
      {step === 'own' && <SetupStepView title="who are you?" placeholder="your name..." value={ownName} onChangeText={setOwnName} button="that's me!" disabled={!ownName.trim()} onPress={() => setStep('together')} />}
      {step === 'together' && (
        <View style={styles.step}>
          <Text style={styles.heading}>{partnerNickname} & {ownName} have been together since...</Text>
          <TextInput value={dateText} onChangeText={setDateText} placeholder="YYYY-MM-DD" placeholderTextColor={colors.mutedInk} style={styles.input} autoFocus />
          <Button label={saving ? 'saving...' : 'yep!'} onPress={continueFromTogether} disabled={saving} />
          <Text style={styles.or}>or</Text>
          <Pressable onPress={() => void save(null)} disabled={saving}><Text style={styles.link}>shh... not yet</Text></Pressable>
        </View>
      )}
    </Screen>
  );
}

function SetupStepView({ title, placeholder, value, onChangeText, button, disabled, onPress }: {
  title: string; placeholder: string; value: string; onChangeText: (value: string) => void; button: string; disabled: boolean; onPress: () => void;
}) {
  return (
    <View style={styles.step}>
      <Text style={styles.heading}>{title}</Text>
      <TextInput value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={colors.mutedInk} style={styles.input} autoFocus returnKeyType="done" onSubmitEditing={() => !disabled && onPress()} />
      <Button label={button} onPress={onPress} disabled={disabled} />
    </View>
  );
}

function Home({ relationship, partnerMessage }: { relationship: Relationship; partnerMessage: Message | null }) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState(partnerMessage);

  const send = async () => {
    if (!draft.trim() || sending) return;
    setSending(true);
    const repository = await repoPromise;
    await repository.sendMessage({ type: 'TEXT', body: draft.trim() });
    setDraft('');
    setSending(false);
    setMessage(message);
  };

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView style={styles.home} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.homeHeader}><Text style={styles.logoSmall}>rucola</Text><Text style={styles.partnerName}>{relationship.partnerNickname}</Text></View>
        <View style={styles.messageArea}>
          {message ? <><Text style={styles.message}>{message.body}</Text><Text style={styles.messageMeta}>sent with love</Text></> : <Text style={styles.muted}>nothing here yet...</Text>}
        </View>
        <View style={styles.composer}>
          <TextInput value={draft} onChangeText={setDraft} placeholder={`see what ${relationship.partnerNickname} sent you...`} placeholderTextColor={colors.mutedInk} multiline style={styles.composerInput} />
          <View style={styles.composerRow}>
            <Pressable style={styles.iconButton} accessibilityLabel="photo or video"><Text style={styles.icon}>＋</Text></Pressable>
            <Pressable style={styles.iconButton} accessibilityLabel="drawing"><Text style={styles.icon}>✎</Text></Pressable>
            <Button label={sending ? '...' : 'Send!'} onPress={() => void send()} disabled={!draft.trim() || sending} compact />
          </View>
        </View>
      </KeyboardAvoidingView>
      <StatusBar style="dark" />
    </SafeAreaView>
  );
}

function Screen({ children }: { children: React.ReactNode }) {
  return <SafeAreaView style={styles.safe}><View style={styles.screen}>{children}</View><StatusBar style="dark" /></SafeAreaView>;
}

function Button({ label, onPress, disabled = false, compact = false }: { label: string; onPress: () => void; disabled?: boolean; compact?: boolean }) {
  return <Pressable onPress={onPress} disabled={disabled} style={({ pressed }) => [styles.button, compact && styles.buttonCompact, disabled && styles.buttonDisabled, pressed && !disabled && styles.buttonPressed]}><Text style={styles.buttonText}>{label}</Text></Pressable>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  screen: { flex: 1, padding: 28, justifyContent: 'center' },
  logo: { fontSize: typography.display, fontWeight: '800', letterSpacing: -2, color: colors.ink, transform: [{ rotate: '-4deg' }], alignSelf: 'center', marginBottom: 48 },
  logoSmall: { fontSize: 25, fontWeight: '800', color: colors.ink, transform: [{ rotate: '-3deg' }] },
  muted: { color: colors.mutedInk, fontSize: typography.body, textAlign: 'center' },
  step: { width: '100%', maxWidth: 420, alignSelf: 'center' },
  heading: { color: colors.ink, fontSize: typography.heading, fontWeight: '700', lineHeight: 34, marginBottom: 28 },
  input: { borderBottomWidth: 2, borderBottomColor: colors.sage, color: colors.ink, fontSize: typography.body, paddingVertical: 12, marginBottom: 28 },
  button: { alignSelf: 'flex-start', backgroundColor: colors.ink, borderRadius: 18, paddingHorizontal: 24, paddingVertical: 13 },
  buttonCompact: { paddingHorizontal: 20, paddingVertical: 11 },
  buttonDisabled: { opacity: 0.3 },
  buttonPressed: { transform: [{ scale: 0.97 }] },
  buttonText: { color: colors.background, fontSize: typography.body, fontWeight: '700' },
  or: { color: colors.mutedInk, textAlign: 'center', marginVertical: 16 },
  link: { color: colors.olive, fontSize: typography.body, textAlign: 'center', textDecorationLine: 'underline' },
  home: { flex: 1, padding: 22, justifyContent: 'space-between' },
  homeHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  partnerName: { fontSize: typography.title, fontWeight: '700', color: colors.ink },
  messageArea: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 20 },
  message: { color: colors.ink, fontSize: 42, fontWeight: '700', textAlign: 'center', lineHeight: 50 },
  messageMeta: { marginTop: 14, color: colors.mutedInk, fontSize: typography.small },
  composer: { paddingTop: 18 },
  composerInput: { minHeight: 54, maxHeight: 120, backgroundColor: colors.mint, borderRadius: 20, paddingHorizontal: 18, paddingVertical: 14, color: colors.ink, fontSize: typography.body },
  composerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 },
  iconButton: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.sage, alignItems: 'center', justifyContent: 'center' },
  icon: { fontSize: 23, color: colors.ink },
});
