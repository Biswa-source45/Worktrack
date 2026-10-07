import { Linking } from 'react-native';
import { callNumber, directionsUrl, geoUrl, openNavigation } from './task-links';

const open = jest.spyOn(Linking, 'openURL');

beforeEach(() => open.mockReset());

describe('task links', () => {
  it('opens Google Maps directions to the site coordinates', async () => {
    open.mockResolvedValue(true);
    await openNavigation(20.2961, 85.8245, 'Site');
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(directionsUrl(20.2961, 85.8245));
    expect(directionsUrl(20.2961, 85.8245)).toBe(
      'https://www.google.com/maps/dir/?api=1&destination=20.2961,85.8245&travelmode=driving',
    );
  });

  it('falls back to a geo: link when the directions link cannot be opened', async () => {
    open.mockRejectedValueOnce(new Error('no app')).mockResolvedValueOnce(true);
    await openNavigation(20.2961, 85.8245, 'Plot 4 & Co');
    expect(open).toHaveBeenLastCalledWith(geoUrl(20.2961, 85.8245, 'Plot 4 & Co'));
    expect(geoUrl(20.2961, 85.8245, 'Plot 4 & Co')).toBe(
      'geo:20.2961,85.8245?q=20.2961,85.8245(Plot%204%20%26%20Co)',
    );
  });

  it('throws when nothing can open a map, so the screen can say so', async () => {
    open.mockRejectedValue(new Error('no app'));
    await expect(openNavigation(1, 2, 'Site')).rejects.toThrow('no app');
  });

  it('opens the dialler with the contact number', async () => {
    open.mockResolvedValue(true);
    await callNumber('+919876543210');
    expect(open).toHaveBeenCalledWith('tel:+919876543210');
  });
});
