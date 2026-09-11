import * as ImagePicker from 'expo-image-picker';
import { Alert, Linking } from 'react-native';

export async function launchCameraWithPermission(): Promise<ImagePicker.ImagePickerResult> {
  let permission = await ImagePicker.getCameraPermissionsAsync();

  if (!permission.granted && permission.canAskAgain) {
    permission = await ImagePicker.requestCameraPermissionsAsync();
  }

  if (!permission.granted) {
    Alert.alert(
      'Camera permission needed',
      permission.canAskAgain
        ? 'Allow camera access to take a photo or video.'
        : 'Camera access is blocked. Enable it in the app settings to use the camera.',
      permission.canAskAgain
        ? [{ text: 'OK' }]
        : [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Open settings', onPress: () => void Linking.openSettings() },
          ],
    );
    return { canceled: true, assets: null };
  }

  return ImagePicker.launchCameraAsync({
    mediaTypes: ['images', 'videos'],
    quality: 0.9,
  });
}
