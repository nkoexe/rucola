import { useEffect, useState } from 'react';
import { Image, Platform, StyleSheet, Text, View } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import type { Message } from '../domain/models';
import { isVideoMedia, resolveMediaUri } from '../data/media';

type Props = {
  message: Message;
};

export function MessageMedia({ message }: Props) {
  const uri = message.mediaReference;
  const [resolvedUri, setResolvedUri] = useState<string | null>(Platform.OS === 'web' ? null : uri ?? null);

  useEffect(() => {
    if (!uri) {
      setResolvedUri(null);
      return;
    }

    let mounted = true;
    let objectUrl: string | null = null;
    setResolvedUri(Platform.OS === 'web' ? null : uri);

    void resolveMediaUri(uri).then((value) => {
      if (!mounted) {
        if (value && value !== uri && Platform.OS === 'web') URL.revokeObjectURL(value);
        return;
      }
      if (value && value !== uri) objectUrl = value;
      setResolvedUri(value);
    });

    return () => {
      mounted = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [uri]);

  if (!uri || !resolvedUri) {
    return uri ? <LoadingMedia /> : null;
  }

  if (isVideoMedia(uri)) {
    return <VideoMessage uri={resolvedUri} />;
  }

  return <Image source={{ uri: resolvedUri }} style={styles.image} resizeMode="contain" onError={() => undefined} />;
}

function LoadingMedia() {
  return (
    <View style={styles.unavailable}>
      <Text style={styles.unavailableTitle}>loading media...</Text>
    </View>
  );
}

function VideoMessage({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri, (instance) => {
    instance.loop = true;
  });
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    return player.addListener('statusChange', ({ status, error }) => {
      if (status === 'error' || error) setFailed(true);
    }).remove;
  }, [player]);

  if (failed) return <UnavailableMedia />;

  return (
    <View style={styles.videoContainer}>
      <VideoView player={player} style={styles.video} nativeControls />
      <Text style={styles.videoHint}>video</Text>
    </View>
  );
}

function UnavailableMedia() {
  return (
    <View style={styles.unavailable}>
      <Text style={styles.unavailableTitle}>media unavailable</Text>
      <Text style={styles.unavailableText}>The local file is missing or could not be opened.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  image: { width: 280, height: 280, borderRadius: 18, backgroundColor: '#E4F0D9' },
  videoContainer: { width: 280, height: 280, borderRadius: 18, overflow: 'hidden', backgroundColor: '#1D2A1B' },
  video: { width: '100%', height: '100%' },
  videoHint: { position: 'absolute', top: 8, left: 10, color: '#F3F6E9', opacity: 0.8 },
  unavailable: { width: 280, minHeight: 120, borderRadius: 18, padding: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: '#E4F0D9' },
  unavailableTitle: { fontSize: 17, fontWeight: '700' },
  unavailableText: { marginTop: 6, textAlign: 'center', opacity: 0.65 },
});
