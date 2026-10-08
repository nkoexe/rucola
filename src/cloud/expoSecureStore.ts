import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import type { SecureValueStore } from './CloudIdentityStore';

function getWebStorage(): Storage {
  if (typeof globalThis.localStorage === 'undefined') {
    throw new Error('Browser localStorage is unavailable.');
  }
  return globalThis.localStorage;
}

export const expoSecureValueStore: SecureValueStore = {
  getItem: async (key) => {
    if (Platform.OS === 'web') return getWebStorage().getItem(key);
    return SecureStore.getItemAsync(key);
  },
  setItem: async (key, value) => {
    if (Platform.OS === 'web') {
      getWebStorage().setItem(key, value);
      return;
    }
    await SecureStore.setItemAsync(key, value);
  },
  deleteItem: async (key) => {
    if (Platform.OS === 'web') {
      getWebStorage().removeItem(key);
      return;
    }
    await SecureStore.deleteItemAsync(key);
  },
};
