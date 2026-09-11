import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { getRepository } from '../data/repository';
import type { Relationship } from '../domain/models';

export default function App() {
  const [relationship, setRelationship] = useState<Relationship | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let mounted = true;

    getRepository()
      .then(async (repository) => {
        const value = await repository.getRelationship();
        if (mounted) {
          setRelationship(value);
          setReady(true);
        }
      })
      .catch(() => {
        if (mounted) setReady(true);
      });

    return () => {
      mounted = false;
    };
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.logo}>rucola</Text>
      <Text style={styles.label}>
        {!ready
          ? 'getting things ready...'
          : relationship
            ? `hi ${relationship.ownName}`
            : 'local storage is ready.'}
      </Text>
      <StatusBar style="dark" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F4FAF1',
    padding: 24,
  },
  logo: {
    fontSize: 52,
    color: '#10130F',
    transform: [{ rotate: '-4deg' }],
  },
  label: {
    marginTop: 20,
    fontSize: 16,
    color: '#7F887B',
  },
});
