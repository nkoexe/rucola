import { Image, StyleSheet, Text, View } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import type { Message } from '../domain/models';
import { isVideoMedia } from '../data/media';

type Props = {
  message: Message;
};

export function MessageMedia({ message }: Props) {
  if (!message.mediaReference) return null;

  if (isVideoMedia(message.mediaReference)) {
    return <VideoMessage uri={message.mediaReference} />;
  }

  return <Image source={{ uri: message.mediaReference }} style={styles.image} resizeMode="contain" />;
}

function VideoMessage({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri, (instance) => {
    instance.loop = true;
  });

  return (
    <View style={styles.videoContainer}>
      <VideoView player={player} style={styles.video} nativeControls />
      <Text style={styles.videoHint}>video</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  image: { width: 280, height: 280, borderRadius: 18, backgroundColor: '#E4F0D9' },
  videoContainer: { width: 280, height: 280, borderRadius: 18, overflow: 'hidden', backgroundColor: '#1D2A1B' },
  video: { width: '100%', height: '100%' },
  videoHint: { position: 'absolute', top: 8, left: 10, color: '#F3F6E9', opacity: 0.8 },
});
