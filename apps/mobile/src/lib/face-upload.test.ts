import { File, Paths } from 'expo-file-system';
import { convertFormDataAsync } from 'expo/src/winter/fetch/convertFormData';
import { deletePhotos, photoForm } from './face-upload';

describe('photoForm', () => {
  it('appends parts the fetch Expo installs can turn into bytes, the three photos in order', async () => {
    // A React Native `{ uri, name, type }` part made that conversion throw "Unsupported
    // FormDataPart" on the phone, so "Send photos" failed before a request left the app. Jest's
    // FormData is Node's, which checks parts more strictly than the phone's, so record what is
    // appended and hand exactly that to Expo's own conversion.
    const parts: [string, unknown][] = [];
    const append = jest
      .spyOn(FormData.prototype, 'append')
      .mockImplementation((name: string, value: unknown) => {
        parts.push([name, value]);
      });
    const uris = ['a', 'b', 'c'].map((name, index) => {
      const file = new File(Paths.cache, `form-${name}.jpg`);
      file.create({ overwrite: true });
      file.write(new Uint8Array([0xff, 0xd8, index + 1, 0xff, 0xd9]));
      return file.uri;
    });

    photoForm(uris);
    append.mockRestore();
    const { body, boundary } = await convertFormDataAsync({
      entries: () => parts[Symbol.iterator](),
    } as unknown as FormData);

    const text = Buffer.from(body).toString('latin1');
    expect(parts.map(([name]) => name)).toEqual(['photos', 'photos', 'photos']);
    expect(text.match(/name="photos"/g)).toHaveLength(3);
    // Without a filename the server reads a part as a text field, not as an uploaded file.
    expect(text.match(/name="photos"; filename="form-[abc]\.jpg"/g)).toHaveLength(3);
    expect(text.indexOf('\xff\xd8\x01')).toBeLessThan(text.indexOf('\xff\xd8\x02'));
    expect(text.indexOf('\xff\xd8\x02')).toBeLessThan(text.indexOf('\xff\xd8\x03'));
    expect(text.endsWith(`--${boundary}--\r\n`)).toBe(true);
  });

  it('deletes the files, and does not fail for one that is already gone', () => {
    const made = new File(Paths.cache, 'to-delete.jpg');
    made.create({ overwrite: true });
    made.write(new Uint8Array([0xff, 0xd8]));
    expect(made.exists).toBe(true);

    deletePhotos([made.uri, new File(Paths.cache, 'never-existed.jpg').uri]);

    expect(made.exists).toBe(false);
  });

  it('logs a file that cannot be deleted instead of hiding it', () => {
    const file = new File(Paths.cache, 'stuck.jpg');
    file.create({ overwrite: true });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const remove = jest.spyOn(File.prototype, 'delete').mockImplementation(() => {
      throw new Error('permission denied');
    });
    deletePhotos([file.uri]);
    expect(warn).toHaveBeenCalledWith(
      '[face-photos] a photo could not be deleted',
      expect.any(Error),
    );
    remove.mockRestore();
    warn.mockRestore();
  });
});
