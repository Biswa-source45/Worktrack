// The only file that imports the native camera and face scanner (VisionCamera 5, ML Kit). It is
// loaded on demand by the capture screen, never in Expo Go. Not exercised by Jest (there is no
// camera there): the decisions it makes live in lib/face-guidance.ts, which is.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Linking, StyleSheet, useWindowDimensions, View } from 'react-native';
import {
  Camera,
  CommonResolutions,
  useCameraDevice,
  useCameraPermission,
  usePhotoOutput,
} from 'react-native-vision-camera';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFaceScannerOutput } from 'vision-camera-face-detection';
import type { Face } from 'vision-camera-face-detection';
import { AppText } from '@/components/ui/app-text';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { TriangleAlert } from '@/components/icons';
import { assess, HOLD_MS } from '@/lib/face-guidance';
import type { Hint, SeenFace, Step, Turn } from '@/lib/face-guidance';
import { useTheme } from '@/lib/theme';

type Props = {
  step: Step;
  firstTurn: Turn;
  /** The photo is a file on this phone; `turn` is the head turn it was taken with. */
  onPhoto: (uri: string, turn: Turn) => void;
};

// After a photo the pose may still be right; wait before looking for the next one.
const COOLDOWN_MS = 1200;
// No scanner result for this long means the camera stalled: start the hold over.
const STALE_MS = 1000;

const toSeen = (face: Face): SeenFace => ({
  x: face.bounds.x,
  y: face.bounds.y,
  width: face.bounds.width,
  height: face.bounds.height,
  yaw: face.yawAngle,
  roll: face.rollAngle,
  leftEyeOpen: face.leftEyeOpenProbability,
  rightEyeOpen: face.rightEyeOpenProbability,
});

export default function FaceCamera({ step, firstTurn, onPhoto }: Props) {
  const { t } = useTranslation();
  const { colors, space, radius } = useTheme();
  const insets = useSafeAreaInsets();
  const view = useWindowDimensions();
  const { hasPermission, requestPermission, canRequestPermission } = useCameraPermission();
  const device = useCameraDevice('front');
  const photoOutput = usePhotoOutput({
    targetResolution: CommonResolutions.HD_4_3,
    qualityPrioritization: 'speed',
  });

  const [hint, setHint] = useState<Hint>('noFace');
  const [failed, setFailed] = useState(false);
  const goodSince = useRef<number | null>(null);
  const lastResult = useRef(0);
  const busy = useRef(false);

  useEffect(() => {
    if (canRequestPermission) void requestPermission();
  }, [canRequestPermission, requestPermission]);

  // A stalled camera must not keep an old "good" moment alive.
  useEffect(() => {
    const timer = setInterval(() => {
      if (Date.now() - lastResult.current > STALE_MS) goodSince.current = null;
    }, STALE_MS);
    return () => clearInterval(timer);
  }, []);

  const take = useCallback(
    async (turn: Turn) => {
      busy.current = true;
      try {
        const file = await photoOutput.capturePhotoToFile({ enableShutterSound: false }, {});
        const path = file.filePath;
        setFailed(false);
        onPhoto(path.startsWith('file://') ? path : `file://${path}`, turn);
      } catch {
        // The employee sees a retry hint and the camera keeps looking; nothing was captured.
        setFailed(true);
      } finally {
        goodSince.current = null;
        setTimeout(() => (busy.current = false), COOLDOWN_MS);
      }
    },
    [onPhoto, photoOutput],
  );

  const scanner = useFaceScannerOutput({
    performanceMode: 'fast',
    runClassifications: true,
    cameraFacing: 'front',
    autoMode: true,
    windowWidth: view.width,
    windowHeight: view.height,
    onFaceScanned: (faces: Face[]) => {
      const now = Date.now();
      lastResult.current = now;
      const result = assess(faces.map(toSeen), step, view, firstTurn);
      setHint((previous) => (previous === result.hint ? previous : result.hint));
      if (result.hint !== 'ok' || busy.current) {
        goodSince.current = null;
        return;
      }
      goodSince.current ??= now;
      if (now - goodSince.current >= HOLD_MS) void take(result.turn);
    },
    onError: () => setFailed(true),
  });

  if (!hasPermission) {
    return (
      <View
        style={[
          styles.fill,
          styles.center,
          { backgroundColor: colors.background, padding: space[5], gap: space[4] },
        ]}
      >
        <AppText variant="h3" accessibilityRole="header">
          {t('face.camera.permissionTitle')}
        </AppText>
        <AppText color="muted">{t('face.camera.permissionBody')}</AppText>
        {canRequestPermission ? (
          <Button label={t('face.camera.allow')} onPress={() => void requestPermission()} />
        ) : (
          <Button
            label={t('face.camera.openSettings')}
            onPress={() => void Linking.openSettings()}
          />
        )}
      </View>
    );
  }
  if (!device) {
    return (
      <View
        style={[
          styles.fill,
          styles.center,
          { backgroundColor: colors.background, padding: space[5] },
        ]}
      >
        <Banner status="danger" icon={TriangleAlert} message={t('face.camera.noFrontCamera')} />
      </View>
    );
  }

  const ovalWidth = view.width * 0.62;
  return (
    <View style={[styles.fill, { backgroundColor: colors.background }]}>
      <Camera
        style={StyleSheet.absoluteFill}
        device={device}
        isActive
        outputs={[photoOutput, scanner]}
      />
      <View pointerEvents="none" style={[styles.fill, styles.center]}>
        <View
          style={{
            width: ovalWidth,
            height: ovalWidth * 1.3,
            marginBottom: view.height * 0.16,
            borderRadius: ovalWidth,
            borderWidth: 3,
            borderColor: hint === 'ok' ? colors.successFg : colors.primary,
          }}
        />
      </View>
      <View
        style={{
          position: 'absolute',
          left: space[5],
          right: space[5],
          bottom: insets.bottom + space[5],
          padding: space[4],
          gap: space[2],
          borderRadius: radius.lg,
          backgroundColor: colors.surface,
          borderWidth: 1,
          borderColor: colors.border,
        }}
      >
        <AppText variant="small" color="muted">
          {t('face.capture.step', { current: step + 1, total: 3 })}
        </AppText>
        <AppText variant="large" weight={600} accessibilityLiveRegion="polite">
          {failed ? t('face.camera.captureFailed') : t(`face.hint.${hint}`)}
        </AppText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
});
