// The only file that imports the native camera and face scanner (VisionCamera 5, ML Kit). It is
// loaded on demand by the capture screen, never in Expo Go. Not exercised by Jest (there is no
// camera there): the decisions it makes live in lib/face-guidance.ts, which is.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { createFaceScannerOutput } from 'vision-camera-face-detection';
import type { Face } from 'vision-camera-face-detection';
import { TriangleAlert } from '@/components/icons';
import { AppText } from '@/components/ui/app-text';
import { BackButton } from '@/components/ui/back-button';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { Screen } from '@/components/ui/screen';
import { CameraProblem } from '@/components/camera-problem';
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
// How long "could not take the photo" stays instead of the hint.
const FAILURE_MS = 2500;
// The camera list is empty for a moment while it loads: only then say there is no front camera.
const DEVICE_WAIT_MS = 1500;
// Neither "started" nor a single scanner result by now: the camera is not delivering pictures.
const START_WAIT_MS = 10_000;

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
    // Not 'speed': that is CameraX zero-shutter-lag, which adds an extra camera stream, and on
    // the Redmi 13C 5G (MediaTek) the picture then stays black. Checked on the phone: 'balanced'
    // and 'quality' work.
    qualityPrioritization: 'balanced',
  });

  const [hint, setHint] = useState<Hint>('noFace');
  const [failed, setFailed] = useState(false);
  const [waited, setWaited] = useState(false);
  // What went wrong with the camera, or null; `attempt` remounts the camera for a retry.
  const [problem, setProblem] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [started, setStarted] = useState(false);
  const goodSince = useRef<number | null>(null);
  const lastResult = useRef(0);
  const busy = useRef(false);
  const failureTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (canRequestPermission) void requestPermission();
  }, [canRequestPermission, requestPermission]);

  useEffect(() => {
    const timer = setTimeout(() => setWaited(true), DEVICE_WAIT_MS);
    return () => clearTimeout(timer);
  }, []);

  const reportProblem = useCallback((error: Error | string) => {
    const text = typeof error === 'string' ? error : error.message;
    // Metro's terminal gets the whole text; the screen gets the first lines.
    console.warn('[face-camera]', text);
    setProblem(text.split('\n').slice(0, 3).join(' ').slice(0, 240));
  }, []);

  // No picture and no scanner result for a while: say so instead of leaving a black screen.
  useEffect(() => {
    if (started || problem !== null || !hasPermission) return;
    const timer = setTimeout(() => {
      if (lastResult.current === 0) reportProblem(t('face.camera.notStarting'));
    }, START_WAIT_MS);
    return () => clearTimeout(timer);
  }, [attempt, hasPermission, problem, reportProblem, started, t]);

  // A stalled camera must not keep an old "good" moment alive.
  useEffect(() => {
    const timer = setInterval(() => {
      if (Date.now() - lastResult.current > STALE_MS) goodSince.current = null;
    }, STALE_MS);
    return () => {
      clearInterval(timer);
      if (failureTimer.current) clearTimeout(failureTimer.current);
    };
  }, []);

  // Shown for a moment, then the hints come back: the camera keeps looking meanwhile.
  const flashFailure = useCallback(() => {
    setFailed(true);
    if (failureTimer.current) clearTimeout(failureTimer.current);
    failureTimer.current = setTimeout(() => setFailed(false), FAILURE_MS);
  }, []);

  const take = useCallback(
    async (turn: Turn) => {
      busy.current = true;
      try {
        const file = await photoOutput.capturePhotoToFile({ enableShutterSound: false }, {});
        const path = file.filePath;
        onPhoto(path.startsWith('file://') ? path : `file://${path}`, turn);
      } catch {
        // Nothing was captured; the employee sees it, and the camera keeps looking.
        flashFailure();
      } finally {
        goodSince.current = null;
        setTimeout(() => (busy.current = false), COOLDOWN_MS);
      }
    },
    [flashFailure, onPhoto, photoOutput],
  );

  // The scanner is made once. The library's own hook builds a new one on every render, and every
  // new output makes the camera session reconfigure (the preview flickers and the hold restarts),
  // which a hint that changes several times a second would trigger all the time. It calls a stable
  // function that runs the latest handler, so it sees the current step and head turn.
  const handleFaces = (faces: Face[]) => {
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
  };
  const latestHandler = useRef(handleFaces);
  useEffect(() => {
    latestHandler.current = handleFaces;
  });
  const onFaces = useCallback((faces: Face[]) => latestHandler.current(faces), []);
  const scanner = useMemo(
    () =>
      // The callbacks read refs only when the scanner calls them (a frame later), never while
      // rendering; the rule cannot tell. Not a render-time ref access.
      // eslint-disable-next-line react-hooks/refs
      createFaceScannerOutput({
        performanceMode: 'fast',
        runClassifications: true,
        cameraFacing: 'front',
        autoMode: true,
        windowWidth: view.width,
        windowHeight: view.height,
        onFaceScanned: onFaces,
        onError: flashFailure,
      }),
    [view.width, view.height, onFaces, flashFailure],
  );

  if (problem !== null) {
    return (
      <CameraProblem
        detail={problem}
        onRetry={() => {
          lastResult.current = 0;
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
        <AppText color="muted">{t('face.camera.permissionBody')}</AppText>
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
          <Banner status="danger" icon={TriangleAlert} message={t('face.camera.noFrontCamera')} />
        ) : null}
      </Screen>
    );
  }

  const ovalWidth = view.width * 0.62;
  return (
    <View style={[styles.fill, { backgroundColor: colors.background }]}>
      <Camera
        key={attempt}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive
        outputs={[photoOutput, scanner]}
        onStarted={() => setStarted(true)}
        onError={reportProblem}
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
