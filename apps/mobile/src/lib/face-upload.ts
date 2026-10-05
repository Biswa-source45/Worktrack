import { File } from 'expo-file-system';
import { api } from '@/lib/api';
import { unwrap } from '@/lib/api-error';

/** The three enrollment photos as a multipart body; each is a file on this phone. */
export function photoForm(uris: string[]): FormData {
  const form = new FormData();
  for (const uri of uris) {
    // Not React Native's `{ uri, name, type }` part: the fetch Expo installs refuses it ("Unsupported
    // FormDataPart") before anything is sent. A File is a Blob that fetch can read the bytes of.
    form.append('photos', new File(uri));
  }
  return form;
}

/**
 * Deletes selfies from this phone's cache. A leftover face photo is personal data nobody asked
 * to keep, so a file that cannot be deleted is logged, never ignored silently.
 */
export function deletePhotos(uris: string[]) {
  for (const uri of uris) {
    try {
      const file = new File(uri);
      if (file.exists) file.delete();
    } catch (error) {
      console.warn('[face-photos] a photo could not be deleted', error);
    }
  }
}

export const sendPhotos = (uris: string[]) =>
  unwrap(
    api.POST('/api/v1/me/face-enrollment', {
      // The typed body only lists the field; the serializer sends the real parts.
      body: { photos: [] },
      bodySerializer: () => photoForm(uris),
    }),
  );
