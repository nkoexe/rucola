import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { getRepository } from '../../data/repository';
import type { Message, Relationship } from '../../domain/models';

type Props = {
  relationship: Relationship;
  repositoryPromise: ReturnType<typeof getRepository>;
  onBack: () => void;
};

export function CalendarScreen({ relationship, repositoryPromise, onBack }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  useEffect(() => {
    void repositoryPromise.then((repository) => repository.getMessages()).then(setMessages);
  }, [repositoryPromise]);

  const dates = [...new Set(messages.filter((message) => !message.isActive).map((message) => new Date(message.createdAt).toLocaleDateString()))];

  return (
    <View style={styles.container}>
      <Pressable onPress={onBack}><Text style={styles.back}>‹ back</Text></Pressable>
      <Text style={styles.title}>calendar</Text>
      <Text style={styles.subtitle}>{relationship.partnerNickname}</Text>
      <Text style={styles.note}>Messages with history dates:</Text>
      {dates.length === 0 ? <Text style={styles.muted}>no message history yet...</Text> : dates.map((date) => <Text key={date} style={styles.date}>{date}</Text>)}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 22, backgroundColor: '#F3F6E9' },
  back: { fontSize: 17, textDecorationLine: 'underline', marginBottom: 28 },
  title: { fontSize: 32, fontWeight: '800' },
  subtitle: { marginTop: 4, opacity: 0.6 },
  note: { marginTop: 36, marginBottom: 14, fontWeight: '700' },
  date: { paddingVertical: 10, fontSize: 18 },
  muted: { opacity: 0.55 },
});
