import { photoForm } from './face-upload';

describe('photoForm', () => {
  it('sends each photo as a file part of the "photos" field, in order', () => {
    // Jest's FormData is not React Native's, so record what is appended instead of reading it back.
    const append = jest.spyOn(FormData.prototype, 'append').mockImplementation(() => undefined);
    photoForm(['file:///a.jpg', 'file:///b.jpg', 'file:///c.jpg']);
    expect(append.mock.calls).toEqual([
      ['photos', { uri: 'file:///a.jpg', name: 'photo-1.jpg', type: 'image/jpeg' }],
      ['photos', { uri: 'file:///b.jpg', name: 'photo-2.jpg', type: 'image/jpeg' }],
      ['photos', { uri: 'file:///c.jpg', name: 'photo-3.jpg', type: 'image/jpeg' }],
    ]);
    append.mockRestore();
  });
});
