'use client';

import { useState, type KeyboardEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link2, Search } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useTranslation } from 'react-i18next';
import { Field } from '@/components/field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { errorMessage, proxyApi, unwrap } from '@/lib/api-client';
import type { LatLng } from './geofence-map';

/** The map, loaded in the browser only: Leaflet needs `window`. */
export const GeofenceMap = dynamic(() => import('./geofence-map'), {
  ssr: false,
  loading: () => <Skeleton className="h-64 w-full rounded-md" />,
});

// About 0.1 m: more digits than a geofence can use.
const rounded = (value: number) => String(Number(value.toFixed(6)));

export function toCenter(lat: string, lng: string): LatLng | null {
  const center = { lat: Number(lat), lng: Number(lng) };
  const valid =
    lat.trim() !== '' &&
    lng.trim() !== '' &&
    Math.abs(center.lat) <= 90 &&
    Math.abs(center.lng) <= 180;
  return valid ? center : null;
}

type Props = {
  lat: string;
  lng: string;
  radiusM: number;
  /** i18n keys, as zod reports them. */
  errors?: { lat?: string; lng?: string };
  /** `name` comes with a pasted link that carries a place name. */
  onChange: (lat: string, lng: string, name?: string) => void;
};

// Enter in these boxes must run their own action, not submit the form around them.
const onEnter = (run: () => void) => (event: KeyboardEvent<HTMLInputElement>) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  run();
};

/** Every way to place a pin: address search, a pasted map link, the map, or typed coordinates. */
export function PinPicker({ lat, lng, radiusM, errors = {}, onChange }: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [link, setLink] = useState('');

  // Mutations, not queries: they run on demand and their results (places) are not kept.
  const search = useMutation({
    gcTime: 0,
    mutationFn: (q: string) =>
      unwrap(proxyApi().GET('/api/v1/admin/geo/search', { params: { query: { q } } })),
  });
  const resolve = useMutation({
    gcTime: 0,
    mutationFn: (url: string) =>
      unwrap(proxyApi().POST('/api/v1/admin/geo/resolve-link', { body: { url } })),
    onSuccess: (place) => {
      onChange(rounded(place.lat), rounded(place.lng), place.name ?? undefined);
      setLink('');
    },
  });

  const runSearch = () => {
    if (query.trim()) search.mutate(query.trim());
  };
  const runResolve = () => {
    if (link.trim()) resolve.mutate(link.trim());
  };

  return (
    <div className="grid gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor="pin-search">{t('map.search')}</Label>
        <div className="flex gap-2">
          <Input
            id="pin-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onEnter(runSearch)}
          />
          <Button type="button" variant="outline" onClick={runSearch} disabled={search.isPending}>
            <Search aria-hidden="true" />
            {t('map.searchAction')}
          </Button>
        </div>
        {search.error && (
          <p role="alert" className="text-caption text-danger">
            {errorMessage(t, search.error, 'map')}
          </p>
        )}
        {search.data?.length === 0 && (
          <p role="status" className="text-caption text-muted-foreground">
            {t('map.noResults')}
          </p>
        )}
        {search.data && search.data.length > 0 && (
          <ul aria-label={t('map.results')} className="grid gap-1 rounded-md border p-1">
            {search.data.map((hit) => (
              <li key={`${hit.lat},${hit.lng},${hit.label}`}>
                <button
                  type="button"
                  className="w-full rounded-sm px-2 py-1.5 text-left text-small hover:bg-raised"
                  onClick={() => {
                    onChange(rounded(hit.lat), rounded(hit.lng));
                    search.reset();
                  }}
                >
                  {hit.label}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="pin-link">{t('map.link')}</Label>
        <div className="flex gap-2">
          <Input
            id="pin-link"
            type="url"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            onKeyDown={onEnter(runResolve)}
          />
          <Button type="button" variant="outline" onClick={runResolve} disabled={resolve.isPending}>
            <Link2 aria-hidden="true" />
            {t('map.linkAction')}
          </Button>
        </div>
        {resolve.error && (
          <p role="alert" className="text-caption text-danger">
            {errorMessage(t, resolve.error, 'map')}
          </p>
        )}
      </div>

      <GeofenceMap
        center={toCenter(lat, lng)}
        radiusM={radiusM}
        onChange={(nextLat, nextLng) => onChange(rounded(nextLat), rounded(nextLng))}
      />
      <p className="text-caption text-muted-foreground">{t('map.hint')}</p>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="lat" label={t('map.latitude')} error={errors.lat}>
          <Input
            id="lat"
            type="number"
            step="any"
            invalid={!!errors.lat}
            value={lat}
            onChange={(e) => onChange(e.target.value, lng)}
          />
        </Field>
        <Field id="lng" label={t('map.longitude')} error={errors.lng}>
          <Input
            id="lng"
            type="number"
            step="any"
            invalid={!!errors.lng}
            value={lng}
            onChange={(e) => onChange(lat, e.target.value)}
          />
        </Field>
      </div>
    </div>
  );
}
