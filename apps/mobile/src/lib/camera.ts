import Constants, { ExecutionEnvironment } from 'expo-constants';

/**
 * False in Expo Go, which has no VisionCamera or ML Kit. The face screens then say they need the
 * development build instead of crashing on a missing native module.
 */
export const cameraAvailable = Constants.executionEnvironment !== ExecutionEnvironment.StoreClient;
