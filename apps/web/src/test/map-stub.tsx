import type { LatLng } from '@/components/map/geofence-map';

type Props = {
  center: LatLng | null;
  radiusM: number;
  points?: LatLng[];
  onChange?: (lat: number, lng: number) => void;
};

/** Where the stub's "move pin" button puts the pin; more digits than the form keeps. */
export const MOVED = { lat: 12.9715987, lng: 77.5945627 };

// Stands in for the Leaflet map, which jsdom cannot draw. Use it with
// vi.mock('@/components/map/geofence-map', () => import('@/test/map-stub')).
export default function MapStub({ center, radiusM, points = [], onChange }: Props) {
  return (
    <div
      data-testid="map"
      data-center={center ? `${center.lat},${center.lng}` : ''}
      data-radius={radiusM}
      data-points={points.map((p) => `${p.lat},${p.lng}`).join(';')}
    >
      {onChange && (
        <button type="button" onClick={() => onChange(MOVED.lat, MOVED.lng)}>
          move pin
        </button>
      )}
    </div>
  );
}
