import { Component } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { MapPin } from '@/components/icons';
import { AppText } from '@/components/ui/app-text';
import { useTheme } from '@/lib/theme';

type LatLng = { latitude: number; longitude: number };
type Maps = {
  default: ComponentType<{
    style: object;
    initialRegion: LatLng & { latitudeDelta: number; longitudeDelta: number };
    scrollEnabled: boolean;
    zoomEnabled: boolean;
    pitchEnabled: boolean;
    rotateEnabled: boolean;
    toolbarEnabled: boolean;
    children: ReactNode;
  }>;
  Marker: ComponentType<{ coordinate: LatLng }>;
  Circle: ComponentType<{
    center: LatLng;
    radius: number;
    strokeColor: string;
    strokeWidth: number;
    fillColor: string;
  }>;
};

/**
 * react-native-maps is native code: a build made before it was added does not have it, and neither
 * does Jest. A missing module then means the address is shown on its own, never a crash.
 */
function loadMaps(): Maps | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('react-native-maps') as Maps;
  } catch {
    return null;
  }
}

/** A map that fails to start (no Maps key, no native view) falls back like a missing module. */
class MapBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.warn('[site-map] the map could not be shown', error);
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

type Props = {
  lat: number;
  lng: number;
  radiusM: number;
  address: string;
};

const METRES_PER_DEGREE = 111_000;

/** The task site as a pin and its radius circle; just the address when there is no map. */
export function SiteMap({ lat, lng, radiusM, address }: Props) {
  const { t } = useTranslation();
  const { colors, radius, space } = useTheme();
  const maps = loadMaps();

  const addressOnly = (
    <View style={{ flexDirection: 'row', gap: space[2], alignItems: 'center' }}>
      <MapPin size={20} strokeWidth={1.75} color={colors.muted} />
      <AppText color="muted" style={{ flex: 1 }}>
        {address}
      </AppText>
    </View>
  );
  if (!maps) return addressOnly;

  const { default: MapView, Marker, Circle } = maps;
  const center = { latitude: lat, longitude: lng };
  // About two and a half radii across, so the whole circle fits with some road around it.
  const delta = Math.max((radiusM * 2.5) / METRES_PER_DEGREE, 0.004);
  return (
    <MapBoundary fallback={addressOnly}>
      <View
        accessible
        accessibilityLabel={t('tasks.site.mapA11y', { address })}
        style={{ height: 180, borderRadius: radius.lg, overflow: 'hidden' }}
      >
        <MapView
          style={{ flex: 1 }}
          initialRegion={{ ...center, latitudeDelta: delta, longitudeDelta: delta }}
          scrollEnabled={false}
          zoomEnabled={false}
          pitchEnabled={false}
          rotateEnabled={false}
          toolbarEnabled={false}
        >
          <Marker coordinate={center} />
          <Circle
            center={center}
            radius={radiusM}
            strokeColor={colors.primary}
            strokeWidth={2}
            // Translucent: the road names stay readable inside the circle.
            fillColor={`${colors.primary}33`}
          />
        </MapView>
      </View>
    </MapBoundary>
  );
}
