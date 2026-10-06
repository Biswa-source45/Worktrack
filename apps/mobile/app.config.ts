import { withInfoPlist, type ConfigPlugin } from 'expo/config-plugins';
import type { ConfigContext, ExpoConfig } from 'expo/config';

// expo-task-manager's plugin adds the iOS "fetch" background mode. Nothing here uses background
// fetch (tracking needs only "location"), and an unused mode can hold up an App Store review.
// Add it back when a feature really needs it.
const withoutBackgroundFetch: ConfigPlugin = (config) =>
  withInfoPlist(config, (c) => {
    c.modResults.UIBackgroundModes = (c.modResults.UIBackgroundModes ?? []).filter(
      (mode: string) => mode !== 'fetch',
    );
    return c;
  });

// `config` is the static app.json. `eas init` writes extra.eas.projectId there (it cannot edit a
// dynamic config), so spreading it keeps the project ID out of this file.
export default ({ config }: ConfigContext): ExpoConfig =>
  withoutBackgroundFetch({
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
          'WorkTrack uses the camera to enroll your face and to verify it when you punch in or out.',
        NSLocationWhenInUseUsageDescription:
          'WorkTrack uses your location to check you are inside your branch when you punch in or out, and to show your position while you work on a field task.',
        NSLocationAlwaysAndWhenInUseUsageDescription:
          'WorkTrack tracks your location in the background only while you have an active field task or an approved visit. It never tracks you at any other time.',
        UIBackgroundModes: ['location'],
      },
    },
    android: {
      package: 'com.biswabhusan.worktrack',
      // Set only in .env / EAS (never committed). Without a key the map shows its address-only
      // fallback; without the Firebase file push stays off until M8 supplies it.
      ...(process.env.GOOGLE_SERVICES_JSON
        ? { googleServicesFile: process.env.GOOGLE_SERVICES_JSON }
        : {}),
      ...(process.env.GOOGLE_MAPS_ANDROID_API_KEY
        ? { config: { googleMaps: { apiKey: process.env.GOOGLE_MAPS_ANDROID_API_KEY } } }
        : {}),
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
    plugins: [
      'expo-router',
      'expo-dev-client',
      // The usage strings and permissions above stay as written: the plugin reuses the Info.plist
      // strings it finds and only adds the fine and coarse location permissions already listed.
      // The two keys it would add on its own (the old "always" string, motion) are switched off.
      ['expo-location', { locationAlwaysPermission: false, motionUsagePermission: false }],
      // M8 push; M6 also asks for the Android 13+ notification permission for its tracking notice.
      'expo-notifications',
    ],
    experiments: { typedRoutes: true },
  });
