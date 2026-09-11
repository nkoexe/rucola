import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Relationship } from '../../domain/models';

type Props = { relationship: Relationship; onBack: () => void };

export function SettingsScreen({ relationship, onBack }: Props) {
  return (
    <View style={styles.container}>
      <Pressable onPress={onBack}><Text style={styles.back}>‹ back</Text></Pressable>
      <Text style={styles.title}>settings</Text>
      <View style={styles.section}>
        <Text style={styles.label}>relationship</Text>
        <Text style={styles.value}>{relationship.ownName} & {relationship.partnerNickname}</Text>
        {relationship.togetherSince ? <Text style={styles.muted}>together since {new Date(relationship.togetherSince).toLocaleDateString()}</Text> : null}
      </View>
      <View style={styles.section}>
        <Text style={styles.label}>account</Text>
        <Text style={styles.muted}>Pairing, notifications, and data management will be implemented here.</Text>
      </View>
      <Text style={styles.version}>Rucola 0.1.0</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 22, backgroundColor: '#F3F6E9' },
  back: { fontSize: 17, textDecorationLine: 'underline', marginBottom: 28 },
  title: { fontSize: 32, fontWeight: '800' },
  section: { marginTop: 34 },
  label: { fontSize: 14, fontWeight: '700', opacity: 0.6, marginBottom: 8 },
  value: { fontSize: 20, fontWeight: '600' },
  muted: { marginTop: 6, opacity: 0.6, lineHeight: 22 },
  version: { marginTop: 'auto', opacity: 0.45 },
});
