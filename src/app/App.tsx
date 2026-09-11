import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';

export default function App() {
  return (
    <View style={styles.container}>
      <Text style={styles.logo}>rucola</Text>
      <Text style={styles.label}>React Native foundation is alive.</Text>
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
