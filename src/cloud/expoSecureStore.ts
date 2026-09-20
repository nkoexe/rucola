import * as SecureStore from 'expo-secure-store';
import type { SecureValueStore } from './CloudIdentityStore';

export const expoSecureValueStore: SecureValueStore = {
  getItem: (key) => SecureStore.getItemAsync(key),
  setItem: (key, value) => SecureStore.setItemAsync(key, value),
  deleteItem: (key) => SecureStore.deleteItemAsync(key),
};
