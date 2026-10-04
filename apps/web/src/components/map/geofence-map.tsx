'use client';

import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useTranslation } from 'react-i18next';

export type LatLng = { lat: number; lng: number };

type Props = {
  center: LatLng | null;
  radiusM: number;
  /** Present: the pin can be dragged and a click on the map moves it. Absent: a preview. */
  onChange?: (lat: number, lng: number) => void;
};

// NEXT_PUBLIC_* must be referenced literally so Next inlines it into the client bundle.
const TILE_URL =
  process.env.NEXT_PUBLIC_MAP_TILE_URL ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
// Shown before a pin exists: the whole of India, where the company works.
const START = { center: [22.5, 79] as L.LatLngTuple, zoom: 4 };
const PIN_ZOOM = 16;

// A token-coloured dot: the default marker images of Leaflet do not survive bundling, and role
// classes follow the theme on their own.
const PIN = L.divIcon({
  className: 'rounded-full border-2 border-primary-foreground bg-primary shadow-md',
  iconSize: [20, 20],
});

export default function GeofenceMap({ center, radiusM, onChange }: Props) {
  const { t } = useTranslation();
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const shapes = useRef<L.LayerGroup | null>(null);
  const change = useRef(onChange);
  useEffect(() => {
    change.current = onChange;
  });

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    // Reduced motion: the map jumps instead of gliding and fading.
    const animate = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const created = L.map(element, {
      zoomAnimation: animate,
      fadeAnimation: animate,
      markerZoomAnimation: animate,
    }).setView(START.center, START.zoom);
    L.tileLayer(TILE_URL, { attribution: '© OpenStreetMap contributors', maxZoom: 19 }).addTo(
      created,
    );
    created.on('click', (event) => change.current?.(event.latlng.lat, event.latlng.lng));
    shapes.current = L.layerGroup().addTo(created);
    map.current = created;
    // A dialog scales in, so the first measured size is wrong until the animation ends.
    const observer = new ResizeObserver(() => created.invalidateSize());
    observer.observe(element);
    return () => {
      observer.disconnect();
      created.remove();
      map.current = null;
      shapes.current = null;
    };
  }, []);

  const lat = center?.lat;
  const lng = center?.lng;
  const editable = onChange !== undefined;
  const pinLabel = t(editable ? 'map.pinDrag' : 'map.pin');
  useEffect(() => {
    const group = shapes.current;
    if (!group || !map.current) return;
    group.clearLayers();
    if (lat === undefined || lng === undefined) return;
    const marker = L.marker([lat, lng], {
      icon: PIN,
      draggable: editable,
      keyboard: editable,
      interactive: editable,
      title: pinLabel,
      alt: pinLabel,
    }).addTo(group);
    marker.on('dragend', () => {
      const position = marker.getLatLng();
      change.current?.(position.lat, position.lng);
    });
    if (radiusM > 0) {
      const circle = L.circle([lat, lng], {
        radius: radiusM,
        className: 'fill-primary stroke-primary',
        fillOpacity: 0.15,
        weight: 2,
        interactive: false,
      }).addTo(group);
      marker.on('drag', () => circle.setLatLng(marker.getLatLng()));
      map.current.fitBounds(circle.getBounds(), { padding: [16, 16] });
    } else {
      map.current.setView([lat, lng], PIN_ZOOM);
    }
  }, [lat, lng, radiusM, editable, pinLabel]);

  return (
    <div
      ref={container}
      role="region"
      aria-label={t(editable ? 'map.labelEdit' : 'map.label')}
      // isolate: the z-indexes Leaflet uses (up to 1000) stay below dialogs and menus. The
      // important classes replace the grey background and font of Leaflet's own stylesheet.
      className="isolate h-64 w-full overflow-hidden rounded-md border bg-raised! font-sans!"
    />
  );
}
