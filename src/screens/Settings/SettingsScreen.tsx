import { useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import type { getRepository } from '../../data/repository';
import type { Relationship } from '../../domain/models';
import { DeleteRelationship } from '../../domain/useCases';
import { cloudRuntime } from '../../cloud/CloudRuntime';

type NativeIntegrationTestScreenComponent = typeof import('../Dev/NativeIntegrationTestScreen')['NativeIntegrationTestScreen'];

type Props = {
  relationship: Relationship;
  repositoryPromise: ReturnType<typeof getRepository>;
  onBack: () => void;
  onRelationshipDeleted: () => void;
  onOpenPairing?: () => void;
};

export function SettingsScreen({ relationship, repositoryPromise, onBack, onRelationshipDeleted, onOpenPairing }: Props) {
  const [cloudState, setCloudState] = useState<'loading' | 'active' | 'not-paired'>('loading');
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNativeTests, setShowNativeTests] = useState(false);
  const [nativeIntegrationTestScreen, setNativeIntegrationTestScreen] = useState<NativeIntegrationTestScreenComponent | null>(null);

  useEffect(() => {
    let mounted = true;
    void cloudRuntime.loadIdentity().then((identity) => {
      if (mounted) setCloudState(identity?.state === 'ACTIVE' ? 'active' : 'not-paired');
    }).catch(() => {
      if (mounted) setCloudState('not-paired');
    });
    return () => { mounted = false; };
  }, []);

  if (__DEV__ && showNativeTests) {
    if (!nativeIntegrationTestScreen) {
      return <View style={styles.container}><Text>Loading native tests...</Text></View>;
    }
    const NativeIntegrationTestScreen = nativeIntegrationTestScreen;
    return <NativeIntegrationTestScreen onBack={() => setShowNativeTests(false)} />;
  }

  const openNativeTests = () => {
    setShowNativeTests(true);
    void import('../Dev/NativeIntegrationTestScreen').then(({ NativeIntegrationTestScreen }) => {
      setNativeIntegrationTestScreen(() => NativeIntegrationTestScreen);
    });
  };

  const syncNow = async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncMessage(null);
    try {
      const repository = await repositoryPromise;
      const result = await cloudRuntime.refreshAndSync(repository);
      const identity = await cloudRuntime.loadIdentity();
      setCloudState(identity?.state === 'ACTIVE' ? 'active' : 'not-paired');
      setSyncMessage(identity && result ? `sync finished: ${result.pushed} sent, ${result.pulled} received.` : 'this phone is not paired online.');
    } catch (cause) {
      setSyncMessage(cause instanceof Error ? cause.message : 'sync failed.');
    } finally {
      setSyncing(false);
    }
  };

  const clearLocalData = () => {
    Alert.alert('Clear local data?', 'This removes the relationship, local messages, and cloud pairing secrets from this device.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear data', style: 'destructive', onPress: () => void confirmClear() },
    ]);
  };

  const confirmClear = async () => {
    if (deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await cloudRuntime.clear();
      const repository = await repositoryPromise;
      await new DeleteRelationship(repository).execute();
      onRelationshipDeleted();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not clear local data.');
    } finally {
      setDeleting(false);
    }
  };

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
        <Text style={styles.label}>local data</Text>
        <Text style={styles.muted}>Messages stay on this device. Online sync only carries the encrypted mailbox data needed to reach your person.</Text>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Pressable onPress={clearLocalData} disabled={deleting} style={[styles.dangerButton, deleting && styles.disabled]}>
          <Text style={styles.dangerText}>{deleting ? 'clearing...' : 'Clear local data'}</Text>
        </Pressable>
      </View>
      <View style={styles.section}>
        <Text style={styles.label}>online</Text>
        {cloudState === 'active' ? (
          <>
            <Text style={styles.muted}>connected to your person. Messages sync when the app is open.</Text>
            <Pressable onPress={() => void syncNow()} disabled={syncing} style={[styles.devButton, syncing && styles.disabled]}>
              <Text style={styles.devText}>{syncing ? 'syncing...' : 'sync now'}</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text style={styles.muted}>Connect this phone to your person's phone to exchange messages over the internet.</Text>
            {onOpenPairing ? (
              <Pressable onPress={onOpenPairing} style={styles.devButton}>
                <Text style={styles.devText}>Connect online</Text>
              </Pressable>
            ) : null}
          </>
        )}
        {syncMessage ? <Text style={styles.muted}>{syncMessage}</Text> : null}
      </View>
      {__DEV__ ? (
        <View style={styles.section}>
          <Text style={styles.label}>development</Text>
          <Pressable onPress={openNativeTests} style={styles.devButton}>
            <Text style={styles.devText}>Open native SQLite tests</Text>
          </Pressable>
        </View>
      ) : null}
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
  error: { marginTop: 12, color: '#9B2C2C' },
  dangerButton: { alignSelf: 'flex-start', marginTop: 18, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10 },
  dangerText: { fontWeight: '700' },
  devButton: { alignSelf: 'flex-start', borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10 },
  devText: { color: '#1D2A1B', fontWeight: '700' },
  disabled: { opacity: 0.35 },
  version: { marginTop: 'auto', opacity: 0.45 },
});
