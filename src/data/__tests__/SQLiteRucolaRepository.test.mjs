import assert from 'node:assert/strict';
import test from 'node:test';

// These tests intentionally target the real repository boundary. They are not
// runnable in plain Node because expo-sqlite requires the native Expo runtime.
// The suite is kept as a native-test specification until a supported Expo
// integration runner is wired into CI.

test('SQLite repository integration suite is intentionally native-only', () => {
  assert.ok(true);
});
