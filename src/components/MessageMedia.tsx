import { useEffect, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import type { Message } from '../domain/models';
import { isVideoMedia } from '../data/media';

type Props = {
  message: Message;
};

export function MessageMedia({ message }: Props) {
  const uri = message.mediaReference;
  const [imageFailed, setImageFailed] = useState(false);

  if (!uri) return null;

  if (isVideoMedia(uri)) {
    return <VideoMessage uri={uri} />;
  }

  if (imageFailed) {
    return <UnavailableMedia />;
  }

  return (
    <Image
      source={{ uri }}
      style={styles.image}
      resizeMode="contain"
      onError={() => setImageFailed(true)}
    />
  );
}

function VideoMessage({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri, (instance) => {
    instance.loop = true;
  });
  const [failed, setFailed] = useState(false);

  useEffect(() => {
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
