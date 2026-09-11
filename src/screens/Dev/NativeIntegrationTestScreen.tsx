import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { runNativeIntegrationTests, type NativeIntegrationResult } from '../../data/__tests__/nativeIntegration';

export function NativeIntegrationTestScreen({ onBack }: { onBack: () => void }) {
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<NativeIntegrationResult[] | null>(null);

  const run = async () => {
    if (running) return;
    setRunning(true);
    try {
      setResults(await runNativeIntegrationTests());
    } finally {
      setRunning(false);
    }
  };

  const passed = results?.filter((result) => result.passed).length ?? 0;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Pressable onPress={onBack}><Text style={styles.back}>‹ back</Text></Pressable>
      <Text style={styles.title}>native tests</Text>
      <Text style={styles.description}>
        Disposable SQLite databases only. The normal rucola.db is never used.
      </Text>

      <Pressable onPress={run} disabled={running} style={[styles.button, running && styles.disabled]}>
        <Text style={styles.buttonText}>{running ? 'running...' : 'Run integration tests'}</Text>
      </Pressable>

      {results ? (
        <View style={styles.results}>
          <Text style={styles.summary}>{passed}/{results.length} passed</Text>
          {results.map((result) => (
            <View key={result.name} style={styles.result}>
              <Text style={styles.resultName}>{result.passed ? '✓' : '✗'} {result.name}</Text>
              {result.error ? <Text style={styles.error}>{result.error}</Text> : null}
            </View>
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, padding: 22, backgroundColor: '#F3F6E9' },
  back: { fontSize: 17, textDecorationLine: 'underline', marginBottom: 28 },
  title: { fontSize: 32, fontWeight: '800' },
  description: { marginTop: 12, lineHeight: 22, opacity: 0.65 },
  button: { alignSelf: 'flex-start', marginTop: 24, backgroundColor: '#1D2A1B', borderRadius: 14, paddingHorizontal: 16, paddingVertical: 12 },
  buttonText: { color: '#F3F6E9', fontWeight: '700' },
  disabled: { opacity: 0.4 },
  results: { marginTop: 28 },
  summary: { fontSize: 20, fontWeight: '800', marginBottom: 12 },
  result: { paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#1D2A1B' },
  resultName: { fontWeight: '700' },
  error: { marginTop: 5, color: '#9B2C2C' },
});
