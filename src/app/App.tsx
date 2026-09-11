import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { getRepository } from '../data/repository';
import type { Relationship } from '../domain/models';
import { GetRelationship } from '../domain/useCases';
import { CalendarScreen } from '../screens/Calendar/CalendarScreen';
import { HistoryScreen } from '../screens/History/HistoryScreen';
import { HomeScreen } from '../screens/Home/HomeScreen';
import { SettingsScreen } from '../screens/Settings/SettingsScreen';
import { SetupScreen } from '../screens/Setup/SetupScreen';

const repositoryPromise = getRepository();
type AppScreen = 'home' | 'history' | 'calendar' | 'settings';

export default function App() {
  const [relationship, setRelationship] = useState<Relationship | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    void repositoryPromise
      .then((repository) => new GetRelationship(repository).execute())
      .then((value) => {
        if (mounted) {
          setRelationship(value);
          setReady(true);
        }
      })
      .catch((cause) => {
        if (mounted) {
          setError(cause instanceof Error ? cause.message : 'Could not initialize Rucola.');
          setReady(true);
        }
      });
    return () => { mounted = false; };
  }, []);

  if (!ready) return <LoadingScreen />;
  if (error && !relationship) return <ErrorScreen message={error} />;
  if (!relationship) return <SetupScreen repositoryPromise={repositoryPromise} onComplete={setRelationship} />;

  return (
    <MainApp
      relationship={relationship}
      repositoryPromise={repositoryPromise}
      onRelationshipDeleted={() => setRelationship(null)}
    />
  );
}

function MainApp({ relationship, repositoryPromise, onRelationshipDeleted }: {
  relationship: Relationship;
  repositoryPromise: ReturnType<typeof getRepository>;
  onRelationshipDeleted: () => void;
}) {
  const [screen, setScreen] = useState<AppScreen>('home');
  const [revision, setRevision] = useState(0);

  const refresh = () => setRevision((value) => value + 1);

  return (
    <SafeAreaView style={styles.safe}>
      {screen === 'home' && <HomeScreen relationship={relationship} repositoryPromise={repositoryPromise} onOpenHistory={() => setScreen('history')} onOpenCalendar={() => setScreen('calendar')} onOpenSettings={() => setScreen('settings')} onChanged={refresh} revision={revision} />}
      {screen === 'history' && <HistoryScreen relationship={relationship} repositoryPromise={repositoryPromise} onBack={() => setScreen('home')} revision={revision} />}
      {screen === 'calendar' && <CalendarScreen relationship={relationship} repositoryPromise={repositoryPromise} onBack={() => setScreen('home')} />}
      {screen === 'settings' && <SettingsScreen relationship={relationship} repositoryPromise={repositoryPromise} onBack={() => setScreen('home')} onRelationshipDeleted={onRelationshipDeleted} />}
      <StatusBar style="dark" />
    </SafeAreaView>
  );
}

function LoadingScreen() {
  return <SafeAreaView style={styles.safe}><View style={styles.loading}><Text style={styles.logo}>rucola</Text><Text>getting things ready...</Text></View><StatusBar style="dark" /></SafeAreaView>;
}

function ErrorScreen({ message }: { message: string }) {
  return <SafeAreaView style={styles.safe}><View style={styles.loading}><Text style={styles.logo}>rucola</Text><Text style={styles.error}>Could not start the app.</Text><Text>{message}</Text></View><StatusBar style="dark" /></SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28 },
  logo: { fontSize: 42, fontWeight: '800', marginBottom: 24 },
  error: { fontSize: 18, fontWeight: '700', marginBottom: 8 },
});
