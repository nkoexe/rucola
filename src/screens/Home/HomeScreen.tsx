import { useEffect, useRef, useState } from 'react';
import * as ImagePicker from 'expo-image-picker';
import { Alert, KeyboardAvoidingView, PanResponder, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { getRepository } from '../../data/repository';
import { launchCameraWithPermission } from '../../data/camera';
import { deleteOwnedMedia, persistPickedMedia } from '../../data/media';
import { runNativeIntegrationTests } from '../../data/nativeIntegration';
import type { Message, Relationship } from '../../domain/models';
import { GetActiveMessage, SendMessage } from '../../domain/useCases';
import { MessageMedia } from '../../components/MessageMedia';

type RepositoryPromise = ReturnType<typeof getRepository>;
type ComposerType = 'TEXT' | 'EMOJI';

const QUICK_EMOJIS = ['❤️', '😘', '🥰', '🫶', '💋', '💕', '🥹', '✨'];
const SWIPE_THRESHOLD = 60;

type Props = {
  relationship: Relationship;
  repositoryPromise: RepositoryPromise;
  revision: number;
  onChanged: () => void;
  onOpenHistory: () => void;
  onOpenCalendar: () => void;
  onOpenSettings: () => void;
};

export function HomeScreen({ relationship, repositoryPromise, revision, onChanged, onOpenHistory, onOpenCalendar, onOpenSettings }: Props) {
  const [message, setMessage] = useState<Message | null>(null);
  const [draft, setDraft] = useState('');
  const [composerType, setComposerType] = useState<ComposerType>('TEXT');
  const [sending, setSending] = useState(false);
  const [pickingMedia, setPickingMedia] = useState(false);
  const [runningTests, setRunningTests] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const historyPanResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) > Math.abs(gesture.dy) && Math.abs(gesture.dx) > 10,
      onPanResponderRelease: (_, gesture) => {
        if (gesture.dx < -SWIPE_THRESHOLD) onOpenHistory();
      },
    }),
  ).current;

  useEffect(() => {
    let mounted = true;
    setError(null);
    void repositoryPromise
      .then((repository) => new GetActiveMessage(repository).execute('PARTNER'))
      .then((value) => {
        if (mounted) setMessage(value);
      })
      .catch((cause) => {
        if (mounted) setError(cause instanceof Error ? cause.message : 'Could not load the message.');
      });
    return () => { mounted = false; };
  }, [repositoryPromise, revision]);

  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;

    setSending(true);
    setError(null);
    try {
      const repository = await repositoryPromise;
      await new SendMessage(repository).execute({ type: composerType, body });
      setDraft('');
      setComposerType('TEXT');
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not send the message.');
    } finally {
      setSending(false);
    }
  };

  const sendMedia = async (launch: () => Promise<ImagePicker.ImagePickerResult>) => {
    if (sending || pickingMedia) return;
    setPickingMedia(true);
    setError(null);
    try {
      const result = await launch();
      if (result.canceled || !result.assets[0]) return;

      const mediaReference = await persistPickedMedia(result.assets[0]);
      try {
        const repository = await repositoryPromise;
        await new SendMessage(repository).execute({
          type: 'PHOTO_VIDEO',
          body: draft.trim(),
          mediaReference,
        });
      } catch (cause) {
        await deleteOwnedMedia(mediaReference);
        throw cause;
      }

      setDraft('');
      setComposerType('TEXT');
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not add the media message.');
    } finally {
      setPickingMedia(false);
    }
  };

  const openMediaPicker = () => {
    Alert.alert('send something', undefined, [
      {
        text: 'Photo / video library',
        onPress: () => void sendMedia(() => ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images', 'videos'],
          allowsMultipleSelection: false,
          quality: 0.9,
        })),
      },
      {
        text: 'Take photo',
        onPress: () => void sendMedia(() => launchCameraWithPermission(['images'])),
      },
      {
        text: 'Record video',
        onPress: () => void sendMedia(() => launchCameraWithPermission(['videos'])),
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const runAllTests = async () => {
    if (runningTests || !__DEV__) return;

    setRunningTests(true);
    try {
      const results = await runNativeIntegrationTests();
      const passed = results.filter((result) => result.passed).length;
      const failed = results.length - passed;
      const failures = results.filter((result) => !result.passed).map((result) => result.name);
      Alert.alert(
        failed === 0 ? 'All tests passed' : 'Tests failed',
        failed === 0
          ? `${passed}/${results.length} passed`
          : `${passed}/${results.length} passed\n\nFailed:\n${failures.join('\n')}`,
      );
    } catch (cause) {
      Alert.alert('Test runner failed', cause instanceof Error ? cause.message : 'Could not run tests.');
    } finally {
      setRunningTests(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.header}>
        <Text style={styles.logo}>rucola</Text>
        <View style={styles.headerActions}>
          <Pressable onPress={onOpenCalendar}><Text style={styles.action}>calendar</Text></Pressable>
          <Pressable onPress={onOpenSettings}><Text style={styles.action}>settings</Text></Pressable>
          <Pressable onPress={onOpenHistory}><Text style={styles.action}>history</Text></Pressable>
        </View>
      </View>

      <View style={styles.messageArea} {...historyPanResponder.panHandlers}>
        <Text style={styles.partner}>{relationship.partnerNickname}</Text>
        {message ? (
          <>
            {message.type === 'PHOTO_VIDEO' ? <MessageMedia message={message} /> : <Text style={styles.message}>{message.body || message.type.toLowerCase()}</Text>}
            {message.body && message.type === 'PHOTO_VIDEO' ? <Text style={styles.mediaCaption}>{message.body}</Text> : null}
            <Text style={styles.meta}>{new Date(message.createdAt).toLocaleString()}</Text>
          </>
        ) : (
          <Text style={styles.muted}>nothing here yet...</Text>
        )}
      </View>

      <View style={styles.composer}>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <View style={styles.typeRow}>
          <Pressable onPress={() => { setComposerType('TEXT'); setError(null); }} style={[styles.typeButton, composerType === 'TEXT' && styles.typeButtonActive]}>
            <Text style={composerType === 'TEXT' ? styles.typeTextActive : styles.typeText}>Text</Text>
          </Pressable>
          <Pressable onPress={() => { setComposerType('EMOJI'); setError(null); }} style={[styles.typeButton, composerType === 'EMOJI' && styles.typeButtonActive]}>
            <Text style={composerType === 'EMOJI' ? styles.typeTextActive : styles.typeText}>Emoji</Text>
          </Pressable>
        </View>
        {composerType === 'EMOJI' ? (
          <View style={styles.emojiRow}>
            {QUICK_EMOJIS.map((emoji) => (
              <Pressable key={emoji} onPress={() => { setError(null); setDraft(emoji); }} style={styles.emojiButton} accessibilityLabel={`Choose ${emoji}`}>
                <Text style={styles.emoji}>{emoji}</Text>
              </Pressable>
            ))}
          </View>
        ) : (
          <TextInput
            value={draft}
            onChangeText={(value) => { setError(null); setDraft(value); }}
            placeholder={`message ${relationship.partnerNickname}...`}
            multiline
            style={styles.input}
          />
        )}
        <View style={styles.composerRow}>
          <Pressable style={[styles.secondaryButton, pickingMedia && styles.disabled]} disabled={pickingMedia} onPress={openMediaPicker}>
            <Text>{pickingMedia ? 'Picking...' : 'Photo / Video'}</Text>
          </Pressable>
          <Pressable style={styles.secondaryButton} onPress={() => setError('Drawing is not implemented yet.')}><Text>Draw</Text></Pressable>
          <Pressable disabled={!draft.trim() || sending} onPress={() => void send()} style={[styles.send, (!draft.trim() || sending) && styles.disabled]}>
            <Text style={styles.sendText}>{sending ? '...' : 'Send'}</Text>
          </Pressable>
        </View>
        {__DEV__ ? (
          <Pressable
            onPress={() => void runAllTests()}
            disabled={runningTests}
            style={[styles.devTestButton, runningTests && styles.disabled]}
          >
            <Text style={styles.devTestButtonText}>{runningTests ? 'Running tests…' : 'Run all tests'}</Text>
          </Pressable>
        ) : null}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 22, backgroundColor: '#F3F6E9' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  logo: { fontSize: 28, fontWeight: '800' },
  headerActions: { flexDirection: 'row', gap: 12 },
  action: { textDecorationLine: 'underline' },
  messageArea: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18 },
  partner: { fontSize: 16, fontWeight: '700', marginBottom: 12, opacity: 0.65 },
  message: { fontSize: 38, fontWeight: '700', textAlign: 'center' },
  mediaCaption: { fontSize: 17, marginTop: 10, textAlign: 'center' },
  meta: { marginTop: 12, opacity: 0.55 },
  muted: { opacity: 0.55, fontSize: 18 },
  composer: { paddingTop: 12 },
  error: { marginBottom: 8, color: '#9B2C2C' },
  typeRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  typeButton: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 7 },
  typeButtonActive: { backgroundColor: '#1D2A1B' },
  typeText: { fontWeight: '600' },
  typeTextActive: { color: '#F3F6E9', fontWeight: '700' },
  input: { minHeight: 54, maxHeight: 120, backgroundColor: '#E4F0D9', borderRadius: 18, paddingHorizontal: 16, paddingVertical: 12, fontSize: 17 },
  emojiRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, backgroundColor: '#E4F0D9', borderRadius: 18, padding: 10 },
  emojiButton: { minWidth: 38, minHeight: 38, alignItems: 'center', justifyContent: 'center' },
  emoji: { fontSize: 26 },
  composerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
  secondaryButton: { padding: 10, borderWidth: 1, borderRadius: 12 },
  send: { marginLeft: 'auto', backgroundColor: '#1D2A1B', borderRadius: 16, paddingHorizontal: 20, paddingVertical: 11 },
  sendText: { color: '#F3F6E9', fontWeight: '700' },
  devTestButton: { width: '100%', marginTop: 16, minHeight: 64, alignItems: 'center', justifyContent: 'center', backgroundColor: '#1D2A1B', borderRadius: 16 },
  devTestButtonText: { color: '#F3F6E9', fontSize: 20, fontWeight: '800' },
  disabled: { opacity: 0.35 },
});
