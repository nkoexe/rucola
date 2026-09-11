import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Message, Relationship } from '../../domain/models';
import { colors } from '../../design/colors';
import { typography } from '../../design/typography';

export function HistoryScreen({
  relationship,
  messages,
  onBack,
}: {
  relationship: Relationship;
  messages: Message[];
  onBack: () => void;
}) {
  const history = [...messages].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={onBack} accessibilityRole="button">
          <Text style={styles.back}>‹ back</Text>
        </Pressable>
        <Text style={styles.title}>history</Text>
        <View style={styles.spacer} />
      </View>

      {history.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>nothing here yet...</Text>
        </View>
      ) : (
        <View style={styles.list}>
          {history.map((message) => (
            <View key={message.id} style={styles.entry}>
              <Text style={styles.sender}>
                {message.participant === 'ME' ? 'you' : relationship.partnerNickname}
              </Text>
              <Text style={styles.message}>{message.body || message.type.toLowerCase()}</Text>
              <Text style={styles.date}>{new Date(message.createdAt).toLocaleDateString()}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, padding: 22 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 30 },
  back: { color: colors.olive, fontSize: typography.body },
  title: { color: colors.ink, fontSize: typography.heading, fontWeight: '800' },
  spacer: { width: 50 },
  list: { gap: 14 },
  entry: { backgroundColor: colors.mint, borderRadius: 20, padding: 18 },
  sender: { color: colors.olive, fontSize: typography.small, fontWeight: '700', marginBottom: 5 },
  message: { color: colors.ink, fontSize: typography.body },
  date: { color: colors.mutedInk, fontSize: typography.small, marginTop: 8 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyText: { color: colors.mutedInk, fontSize: typography.body },
});
