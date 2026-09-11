import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { getRepository } from '../../data/repository';
import type { Message, Relationship } from '../../domain/models';

type RepositoryPromise = ReturnType<typeof getRepository>;

type Props = {
  relationship: Relationship;
  repositoryPromise: RepositoryPromise;
  revision: number;
  onChanged: () => void;
  onOpenHistory: () => void;
  onOpenCalendar: () => void;
  onOpenSettings: () => void;
};

export function HomeScreen({ relationship, repositoryPromise, revision, onChanged, onOpenHistory, onOpenCalendar, onOpenSettings }: Props) {
  const [message, setMessage] = useState<Message | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let mounted = true;
    void repositoryPromise.then((repository) => repository.getActiveMessage('PARTNER')).then((value) => {
      if (mounted) setMessage(value);
    });
    return () => { mounted = false; };
  }, [repositoryPromise, revision]);

  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const repository = await repositoryPromise;
      await repository.sendMessage({ type: 'TEXT', body });
      setDraft('');
      onChanged();
    } finally {
      setSending(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.header}>
        <Text style={styles.logo}>rucola</Text>
        <View style={styles.headerActions}>
          <Pressable onPress={onOpenCalendar}><Text style={styles.action}>calendar</Text></Pressable>
          <Pressable onPress={onOpenSettings}><Text style={styles.action}>settings</Text></Pressable>
          <Pressable onPress={onOpenHistory}><Text style={styles.action}>history</Text></Pressable>
        </View>
      </View>

      <View style={styles.messageArea}>
        <Text style={styles.partner}>{relationship.partnerNickname}</Text>
        {message ? (
          <>
            <Text style={styles.message}>{message.body}</Text>
            <Text style={styles.meta}>{new Date(message.createdAt).toLocaleString()}</Text>
          </>
        ) : (
          <Text style={styles.muted}>nothing here yet...</Text>
        )}
      </View>

      <View style={styles.composer}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder={`message ${relationship.partnerNickname}...`}
          multiline
          style={styles.input}
        />
        <View style={styles.composerRow}>
          <Pressable style={styles.secondaryButton} onPress={() => {}}><Text>Photo / Video</Text></Pressable>
          <Pressable style={styles.secondaryButton} onPress={() => {}}><Text>Draw</Text></Pressable>
          <Pressable disabled={!draft.trim() || sending} onPress={() => void send()} style={[styles.send, (!draft.trim() || sending) && styles.disabled]}>
            <Text style={styles.sendText}>{sending ? '...' : 'Send'}</Text>
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 22, backgroundColor: '#F3F6E9' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  logo: { fontSize: 28, fontWeight: '800' },
  headerActions: { flexDirection: 'row', gap: 12 },
  action: { textDecorationLine: 'underline' },
  messageArea: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18 },
  partner: { fontSize: 16, fontWeight: '700', marginBottom: 12, opacity: 0.65 },
  message: { fontSize: 38, fontWeight: '700', textAlign: 'center' },
  meta: { marginTop: 12, opacity: 0.55 },
  muted: { opacity: 0.55, fontSize: 18 },
  composer: { paddingTop: 12 },
  input: { minHeight: 54, maxHeight: 120, backgroundColor: '#E4F0D9', borderRadius: 18, paddingHorizontal: 16, paddingVertical: 12, fontSize: 17 },
  composerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
  secondaryButton: { padding: 10, borderWidth: 1, borderRadius: 12 },
  send: { marginLeft: 'auto', backgroundColor: '#1D2A1B', borderRadius: 16, paddingHorizontal: 20, paddingVertical: 11 },
  sendText: { color: '#F3F6E9', fontWeight: '700' },
  disabled: { opacity: 0.35 },
});
