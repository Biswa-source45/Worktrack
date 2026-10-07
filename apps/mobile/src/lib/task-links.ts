import { Linking } from 'react-native';

export const directionsUrl = (lat: number, lng: number) =>
  `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;

// Any maps app can open a geo: link, which is what the phone falls back to without Google Maps.
export const geoUrl = (lat: number, lng: number, label: string) =>
  `geo:${lat},${lng}?q=${lat},${lng}(${encodeURIComponent(label)})`;

/** Opens turn-by-turn directions to the site; throws when no app on the phone can open either link. */
export async function openNavigation(lat: number, lng: number, label: string) {
  try {
    await Linking.openURL(directionsUrl(lat, lng));
  } catch {
    await Linking.openURL(geoUrl(lat, lng, label));
  }
}

/** Opens the dialler with the number filled in (the employee still presses call). */
export const callNumber = (phone: string) => Linking.openURL(`tel:${phone}`);
