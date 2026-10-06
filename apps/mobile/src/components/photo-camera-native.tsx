// The only file that imports VisionCamera for task photos (back camera, shutter button). Loaded on
// demand by photo-camera.tsx, never in Expo Go. A task photo is a deliberate act, unlike the
// auto-captured selfie in face-camera.tsx. The caller owns the file it is given (D68).
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Linking, StyleSheet, View } from 'react-native';
import {
  Camera,
  CommonResolutions,
  useCameraDevice,
  useCameraPermission,
  usePhotoOutput,
} from 'react-native-vision-camera';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Camera as CameraIcon, TriangleAlert } from '@/components/icons';
import { AppText } from '@/components/ui/app-text';
import { BackButton } from '@/components/ui/back-button';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { Screen } from '@/components/ui/screen';
import { CameraProblem } from '@/components/camera-problem';
import { useTheme } from '@/lib/theme';

type Props = {
  /** The photo is a file in this phone's cache; the caller deletes it after use. */
  onPhoto: (uri: string) => void;
};

// The camera list is empty for a moment while it loads: only then say there is no back camera.
const DEVICE_WAIT_MS = 1500;
// Never "started" by now: the camera is not delivering pictures.
const START_WAIT_MS = 10_000;

export default function PhotoCameraView({ onPhoto }: Props) {
  const { t } = useTranslation();
  const { colors, space, radius } = useTheme();
  const insets = useSafeAreaInsets();
  const { hasPermission, requestPermission, canRequestPermission } = useCameraPermission();
  const device = useCameraDevice('back');
  const photoOutput = usePhotoOutput({
    targetResolution: CommonResolutions.HD_4_3,
    // Never 'speed' (D65): CameraX zero-shutter-lag gives a black picture on the Redmi 13C 5G.
    qualityPrioritization: 'balanced',
  });

  const [waited, setWaited] = useState(false);
  const [started, setStarted] = useState(false);
  const [taking, setTaking] = useState(false);
  const [failed, setFailed] = useState(false);
  // What went wrong with the camera, or null; `attempt` remounts the camera for a retry.
  const [problem, setProblem] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const busy = useRef(false);

  useEffect(() => {
    if (canRequestPermission) void requestPermission();
  }, [canRequestPermission, requestPermission]);

  useEffect(() => {
    const timer = setTimeout(() => setWaited(true), DEVICE_WAIT_MS);
    return () => clearTimeout(timer);
  }, []);

  const reportProblem = useCallback((error: Error | string) => {
    const text = typeof error === 'string' ? error : error.message;
    console.warn('[photo-camera]', text);
    setProblem(text.split('\n').slice(0, 3).join(' ').slice(0, 240));
  }, []);

  useEffect(() => {
    if (started || problem !== null || !hasPermission || !device) return;
    const timer = setTimeout(() => reportProblem(t('face.camera.notStarting')), START_WAIT_MS);
    return () => clearTimeout(timer);
  }, [attempt, device, hasPermission, problem, reportProblem, started, t]);

  async function shoot() {
    if (busy.current) return;
    busy.current = true;
    setTaking(true);
    setFailed(false);
    try {
      const file = await photoOutput.capturePhotoToFile({ enableShutterSound: true }, {});
      const path = file.filePath;
      onPhoto(path.startsWith('file://') ? path : `file://${path}`);
    } catch (error) {
      console.warn('[photo-camera] capture failed', error);
      setFailed(true);
    } finally {
      busy.current = false;
      setTaking(false);
    }
  }

  if (problem !== null) {
    return (
      <CameraProblem
        detail={problem}
        onRetry={() => {
          setStarted(false);
          setProblem(null);
          setAttempt((n) => n + 1);
        }}
      />
    );
  }

  if (!hasPermission) {
    return (
      <Screen>
        <BackButton />
        <AppText variant="h3" accessibilityRole="header">
          {t('face.camera.permissionTitle')}
        </AppText>
        <AppText color="muted">{t('photo.permissionBody')}</AppText>
        {canRequestPermission ? (
          <Button label={t('face.camera.allow')} onPress={() => void requestPermission()} />
        ) : (
          <Button
            label={t('face.camera.openSettings')}
            onPress={() => void Linking.openSettings()}
          />
        )}
      </Screen>
    );
  }
  if (!device) {
    return (
      <Screen>
        <BackButton />
        {waited ? (
          <Banner status="danger" icon={TriangleAlert} message={t('photo.noBackCamera')} />
        ) : null}
      </Screen>
    );
  }

  return (
    <View style={[styles.fill, { backgroundColor: colors.background }]}>
      <Camera
        key={attempt}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive
        outputs={[photoOutput]}
        onStarted={() => setStarted(true)}
        onError={reportProblem}
      />
      {/* Over the camera picture the arrow needs a background of its own. */}
      <View
        style={{
          position: 'absolute',
          top: insets.top + space[2],
          left: space[4],
          paddingLeft: space[2],
          borderRadius: radius.pill,
          backgroundColor: colors.surface,
        }}
      >
        <BackButton />
      </View>
      <View
        style={{
          position: 'absolute',
          left: space[5],
          right: space[5],
          bottom: insets.bottom + space[5],
          padding: space[4],
          gap: space[3],
          borderRadius: radius.lg,
          backgroundColor: colors.surface,
          borderWidth: 1,
          borderColor: colors.border,
        }}
      >
        <AppText
          variant="small"
          color={failed ? 'dangerFg' : 'muted'}
          accessibilityLiveRegion="polite"
        >
          {failed ? t('photo.captureFailed') : t('photo.hint')}
        </AppText>
        <Button
          icon={CameraIcon}
          label={t('photo.take')}
          loading={taking}
          disabled={!started}
          onPress={() => void shoot()}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
