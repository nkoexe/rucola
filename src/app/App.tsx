import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { getRepository } from '../data/repository';
import type { Relationship } from '../domain/models';
import { HistoryScreen } from '../screens/History/HistoryScreen';
import { CalendarScreen } from '../screens/Calendar/CalendarScreen';
import { HomeScreen } from '../screens/Home/HomeScreen';
import { SettingsScreen } from '../screens/Settings/SettingsScreen';
import { SetupScreen } from '../screens/Setup/SetupScreen';

const repositoryPromise = getRepository();
type AppScreen = 'home' | 'history' | 'calendar' | 'settings';

export default function App() {
  const [relationship, setRelationship] = useState<Relationship | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let mounted = true;
    void repositoryPromise
      .then((repository) => repository.getRelationship())
      .then((value) => {
        if (mounted) { setRelationship(value); setReady(true); }
      })
      .catch(() => mounted && setReady(true));
    return () => { mounted = false; };
  }, []);

  if (!ready) return <LoadingScreen />;
  if (!relationship) return <SetupScreen repositoryPromise={repositoryPromise} onComplete={setRelationship} />;
  return <MainApp relationship={relationship} repositoryPromise={repositoryPromise} onRelationshipDeleted={() => setRelationship(null)} />;
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

const styles = StyleSheet.create({ safe: { flex: 1 }, loading: { flex: 1, alignItems: 'center', justifyContent: 'center' }, logo: { fontSize: 42, fontWeight: '800', marginBottom: 24 } });
