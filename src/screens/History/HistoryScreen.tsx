import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { getRepository } from '../../data/repository';
import type { Message, Relationship } from '../../domain/models';
import { GetMessages } from '../../domain/useCases';
import { MessageMedia } from '../../components/MessageMedia';

type Props = {
  relationship: Relationship;
  repositoryPromise: ReturnType<typeof getRepository>;
  onBack: () => void;
  revision: number;
};

export function HistoryScreen({ relationship, repositoryPromise, onBack, revision }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    setError(null);
    void repositoryPromise
      .then((repository) => new GetMessages(repository).execute())
      .then((value) => {
        if (mounted) setMessages(value.filter((message) => !message.isActive));
      })
      .catch((cause) => {
        if (mounted) setError(cause instanceof Error ? cause.message : 'Could not load history.');
      });
    return () => { mounted = false; };
  }, [repositoryPromise, revision]);

  const history = [...messages].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={onBack} accessibilityRole="button"><Text style={styles.back}>‹ back</Text></Pressable>
        <Text style={styles.title}>history</Text>
        <View style={styles.spacer} />
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <ScrollView contentContainerStyle={history.length === 0 ? styles.empty : styles.list}>
        {history.length === 0 && !error ? (
          <Text style={styles.emptyText}>nothing here yet...</Text>
        ) : history.map((message) => (
          <View key={message.id} style={styles.entry}>
            <Text style={styles.sender}>{message.participant === 'ME' ? 'you' : relationship.partnerNickname}</Text>
            {message.type === 'PHOTO_VIDEO' ? <MessageMedia message={message} /> : <Text style={styles.message}>{message.body || message.type.toLowerCase()}</Text>}
            {message.body && message.type === 'PHOTO_VIDEO' ? <Text style={styles.caption}>{message.body}</Text> : null}
            <Text style={styles.date}>{new Date(message.createdAt).toLocaleString()}</Text>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F3F6E9', padding: 22 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 },
  back: { fontSize: 17, textDecorationLine: 'underline' },
  title: { fontSize: 30, fontWeight: '800' },
  spacer: { width: 50 },
  list: { gap: 14, paddingBottom: 24 },
  entry: { backgroundColor: '#E4F0D9', borderRadius: 20, padding: 18, gap: 8 },
  sender: { fontSize: 14, fontWeight: '700', marginBottom: 5, opacity: 0.65 },
  message: { fontSize: 17 },
  caption: { fontSize: 17 },
  date: { fontSize: 13, marginTop: 8, opacity: 0.55 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyText: { fontSize: 17, opacity: 0.55 },
  error: { color: '#9B2C2C', marginBottom: 10 },
});
