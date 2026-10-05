import { api } from '@/lib/api';
import { unwrap } from '@/lib/api-error';

/** The three enrollment photos as a multipart body; each is a file on this phone. */
export function photoForm(uris: string[]): FormData {
  const form = new FormData();
  uris.forEach((uri, index) => {
    // React Native reads the file itself when it sends a part shaped like this; the DOM typing
    // of FormData only knows Blobs.
    const part = { uri, name: `photo-${index + 1}.jpg`, type: 'image/jpeg' };
    form.append('photos', part as unknown as Blob);
  });
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
