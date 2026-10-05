import type { LatLng } from '@/components/map/geofence-map';

type Props = {
  center: LatLng | null;
  radiusM: number;
  onChange?: (lat: number, lng: number) => void;
};

/** Where the stub's "move pin" button puts the pin; more digits than the form keeps. */
export const MOVED = { lat: 12.9715987, lng: 77.5945627 };

// Stands in for the Leaflet map, which jsdom cannot draw. Use it with
// vi.mock('@/components/map/geofence-map', () => import('@/test/map-stub')).
export default function MapStub({ center, radiusM, onChange }: Props) {
  return (
    <div
      data-testid="map"
      data-center={center ? `${center.lat},${center.lng}` : ''}
      data-radius={radiusM}
    >
      {onChange && (
        <button type="button" onClick={() => onChange(MOVED.lat, MOVED.lng)}>
          move pin
        </button>
      )}
    </div>
  );
}
