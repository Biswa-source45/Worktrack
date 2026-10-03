import type { ConfigContext, ExpoConfig } from 'expo/config';

// `config` is the static app.json. `eas init` writes extra.eas.projectId there (it cannot edit a
// dynamic config), so spreading it keeps the project ID out of this file.
export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'WorkTrack',
  slug: 'worktrack',
  owner: 'biswasource45',
  scheme: 'worktrack',
  version: '0.1.0',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  ios: {
    bundleIdentifier: 'com.biswabhusan.worktrack',
    infoPlist: {
      NSCameraUsageDescription:
        'WorkTrack uses the camera to verify your face when you punch in or out.',
      NSLocationWhenInUseUsageDescription:
        'WorkTrack uses your location to check you are inside your branch when you punch in or out, and to show your position while you work on a field task.',
      NSLocationAlwaysAndWhenInUseUsageDescription:
        'WorkTrack tracks your location in the background only while you have an active field task or an approved visit. It never tracks you at any other time.',
      UIBackgroundModes: ['location'],
    },
  },
  android: {
    package: 'com.biswabhusan.worktrack',
    permissions: [
      'CAMERA',
      'ACCESS_FINE_LOCATION',
      'ACCESS_COARSE_LOCATION',
      'ACCESS_BACKGROUND_LOCATION',
      'FOREGROUND_SERVICE',
      'FOREGROUND_SERVICE_LOCATION',
      'POST_NOTIFICATIONS',
    ],
  },
  plugins: ['expo-router', 'expo-dev-client'],
  experiments: { typedRoutes: true },
});
