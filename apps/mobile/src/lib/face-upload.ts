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

export const sendPhotos = (uris: string[]) =>
  unwrap(
    api.POST('/api/v1/me/face-enrollment', {
      // The typed body only lists the field; the serializer sends the real parts.
      body: { photos: [] },
      bodySerializer: () => photoForm(uris),
    }),
  );
