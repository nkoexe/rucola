import { StatusBar } from 'expo-status-bar';
import { AppState, Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { useEffect, useState } from 'react';
import { getRepository } from '../data/repository';
import { recoverPendingPickerResult } from '../data/pendingPicker';
import type { Relationship } from '../domain/models';
import { GetRelationship } from '../domain/useCases';
import { CalendarScreen } from '../screens/Calendar/CalendarScreen';
import { HistoryScreen } from '../screens/History/HistoryScreen';
import { HomeScreen } from '../screens/Home/HomeScreen';
import { PairingScreen } from '../screens/Pairing/PairingScreen';
import { SettingsScreen } from '../screens/Settings/SettingsScreen';
import { SetupScreen } from '../screens/Setup/SetupScreen';
import { cloudRuntime } from '../cloud/CloudRuntime';
import { checkCloudRuntime } from '../cloud/runtime';

type AppScreen = 'home' | 'history' | 'calendar' | 'settings' | 'pairing';
type RepositoryPromise = ReturnType<typeof getRepository>;

export default function App() {
  const [repositoryPromise, setRepositoryPromise] = useState<RepositoryPromise>(() => getRepository());
  const [relationship, setRelationship] = useState<Relationship | null>(null);
  const [pairingComplete, setPairingComplete] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void checkCloudRuntime().then((status) => {
      if (!status.reachable) console.warn(`[rucola] dev cloud is unreachable: ${status.baseUrl}`);
    });

    let mounted = true;
    setReady(false);
    setError(null);

    void repositoryPromise
      .then(async (repository) => {
        const currentRelationship = await new GetRelationship(repository).execute();
        if (!currentRelationship) return { relationship: null, paired: false };

        await recoverPendingPickerResult(repository);

        const localIdentity = await cloudRuntime.loadIdentity();
        let identity = localIdentity;
        if (localIdentity) {
          try {
            identity = await cloudRuntime.refreshRelationshipState();
          } catch (cause) {
            console.warn('[rucola] startup cloud refresh failed:', cause instanceof Error ? cause.message : 'unknown error');
          }
        }

        if (identity?.state === 'ACTIVE') {
          void cloudRuntime.sync(repository).catch((cause) => {
            console.warn('[rucola] startup sync failed:', cause instanceof Error ? cause.message : 'unknown error');
          });
        }

        return { relationship: currentRelationship, paired: identity?.state === 'ACTIVE' };
      })
      .then((value) => {
        if (!mounted) return;
        setRelationship(value.relationship);
        setPairingComplete(value.paired);
        setReady(true);
      })
      .catch((cause) => {
        if (!mounted) return;
        setError(cause instanceof Error ? cause.message : 'Could not initialize Rucola.');
        setReady(true);
      });

    return () => { mounted = false; };
  }, [repositoryPromise]);

  useEffect(() => {
    if (!relationship || !pairingComplete) return;

    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      void repositoryPromise
        .then((repository) => cloudRuntime.refreshAndSync(repository))
        .then((identity) => {
          if (!identity) setPairingComplete(false);
        })
        .catch((cause) => {
          console.warn('[rucola] foreground sync failed:', cause instanceof Error ? cause.message : 'unknown error');
        });
    });

    return () => subscription.remove();
  }, [relationship, pairingComplete, repositoryPromise]);

  const retry = () => {
    setRelationship(null);
    setPairingComplete(false);
    setRepositoryPromise(getRepository());
  };

  const completePairing = (value: Relationship) => {
    setRelationship(value);
    setPairingComplete(true);
    void repositoryPromise
      .then((repository) => cloudRuntime.sync(repository))
      .catch((cause) => {
        console.warn('[rucola] post-pair sync failed:', cause instanceof Error ? cause.message : 'unknown error');
      });
  };

  const resetToSetup = () => {
    setRelationship(null);
    setPairingComplete(false);
  };

  if (!ready) return <LoadingScreen />;
  if (error && !relationship) return <ErrorScreen message={error} onRetry={retry} />;
  if (!relationship) return <SetupScreen repositoryPromise={repositoryPromise} onComplete={completePairing} />;
  if (!pairingComplete) return <PairingScreen relationship={relationship} onComplete={completePairing} />;

  return (
    <MainApp
      relationship={relationship}
      repositoryPromise={repositoryPromise}
      onRelationshipDeleted={resetToSetup}
    />
  );
}

function MainApp({ relationship, repositoryPromise, onRelationshipDeleted }: {
  relationship: Relationship;
  repositoryPromise: RepositoryPromise;
  onRelationshipDeleted: () => void;
}) {
  const [screen, setScreen] = useState<AppScreen>('home');
  const [revision, setRevision] = useState(0);

  const refresh = () => {
    setRevision((value) => value + 1);
    void repositoryPromise
      .then((repository) => cloudRuntime.sync(repository))
      .catch((cause) => {
        console.warn('[rucola] after-send sync failed:', cause instanceof Error ? cause.message : 'unknown error');
      });
  };

  return (
    <SafeAreaView style={styles.safe}>
      {screen === 'home' && <HomeScreen relationship={relationship} repositoryPromise={repositoryPromise} onOpenHistory={() => setScreen('history')} onOpenCalendar={() => setScreen('calendar')} onOpenSettings={() => setScreen('settings')} onChanged={refresh} revision={revision} />}
      {screen === 'history' && <HistoryScreen relationship={relationship} repositoryPromise={repositoryPromise} onBack={() => setScreen('home')} revision={revision} />}
      {screen === 'calendar' && <CalendarScreen relationship={relationship} repositoryPromise={repositoryPromise} onBack={() => setScreen('home')} />}
      {screen === 'settings' && <SettingsScreen relationship={relationship} repositoryPromise={repositoryPromise} onBack={() => setScreen('home')} onRelationshipDeleted={onRelationshipDeleted} onOpenPairing={() => setScreen('pairing')} />}
      {screen === 'pairing' && (
        <PairingScreen
          relationship={relationship}
          onComplete={() => {
            setScreen('home');
            void repositoryPromise.then((repository) => cloudRuntime.sync(repository)).catch(() => {});
          }}
          onBack={() => setScreen('settings')}
        />
      )}
      <StatusBar style="dark" />
    </SafeAreaView>
  );
}

function LoadingScreen() {
  return <SafeAreaView style={styles.safe}><View style={styles.loading}><Text style={styles.logo}>rucola</Text><Text>getting things ready...</Text></View><StatusBar style="dark" /></SafeAreaView>;
}

function ErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.loading}>
        <Text style={styles.logo}>rucola</Text>
        <Text style={styles.error}>Could not start the app.</Text>
        <Text>{message}</Text>
        <Pressable onPress={onRetry} style={styles.retry}><Text style={styles.retryText}>Try again</Text></Pressable>
      </View>
      <StatusBar style="dark" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28 },
  logo: { fontSize: 42, fontWeight: '800', marginBottom: 24 },
  error: { fontSize: 18, fontWeight: '700', marginBottom: 8 },
  retry: { marginTop: 20, backgroundColor: '#1D2A1B', borderRadius: 14, paddingHorizontal: 20, paddingVertical: 11 },
  retryText: { color: '#F3F6E9', fontWeight: '700' },
});
