import { useState } from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { apiError, jsonBody, mockApi, renderWithClient, type Call } from '@/test/render';
import { PinPicker, toCenter } from './pin-picker';

vi.mock('@/components/map/geofence-map', () => import('@/test/map-stub'));

const HITS = [
  { label: 'MG Road, Bengaluru', lat: 12.9756, lng: 77.6066 },
  { label: 'MG Road, Pune', lat: 18.5167, lng: 73.8792 },
];

function setup(routes: Record<string, unknown>) {
  const submitted = vi.fn();
  function Harness() {
    const [pin, setPin] = useState({ lat: '', lng: '', name: '' });
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submitted();
        }}
      >
        <PinPicker
          lat={pin.lat}
          lng={pin.lng}
          radiusM={100}
          onChange={(lat, lng, name) => setPin({ lat, lng, name: name ?? '' })}
        />
        <output data-testid="name">{pin.name}</output>
      </form>
    );
  }
  const calls = mockApi(routes);
  renderWithClient(<Harness />);
  return { calls, submitted, user: userEvent.setup() };
}

const lat = () => screen.getByLabelText('Latitude');
const lng = () => screen.getByLabelText('Longitude');
const searches = (calls: Call[]) => calls.filter((c) => c.path.endsWith('/admin/geo/search'));

describe('PinPicker', () => {
  it('moves the pin from the map and keeps six decimals', async () => {
    const { user } = setup({});
    expect(await screen.findByTestId('map')).toHaveAttribute('data-center', '');
    await user.click(screen.getByRole('button', { name: 'move pin' }));
    expect(lat()).toHaveValue(12.971599);
    expect(lng()).toHaveValue(77.594563);
    expect(screen.getByTestId('map')).toHaveAttribute('data-center', '12.971599,77.594563');
    expect(screen.getByTestId('map')).toHaveAttribute('data-radius', '100');
  });

  it('lets the coordinates be typed, without the mouse', async () => {
    const { user } = setup({});
    await user.type(lat(), '20.2961');
    await user.type(lng(), '85.8245');
    expect(await screen.findByTestId('map')).toHaveAttribute('data-center', '20.2961,85.8245');
  });

  it('searches on Enter (not per keystroke, not submitting the form) and picks a result', async () => {
    const { calls, submitted, user } = setup({ 'GET /admin/geo/search': HITS });
    const box = screen.getByLabelText('Search for an address');
    await user.type(box, 'MG Road');
    expect(searches(calls)).toHaveLength(0);
    await user.keyboard('{Enter}');

    const results = await screen.findByRole('list', { name: 'Search results' });
    expect(searches(calls)).toHaveLength(1);
    expect(searches(calls)[0].search.get('q')).toBe('MG Road');
    expect(submitted).not.toHaveBeenCalled();

    await user.click(within(results).getByRole('button', { name: 'MG Road, Pune' }));
    expect(lat()).toHaveValue(18.5167);
    expect(lng()).toHaveValue(73.8792);
    expect(screen.queryByRole('list', { name: 'Search results' })).not.toBeInTheDocument();
  });

  it('searches from the button and says when nothing was found', async () => {
    const { user } = setup({ 'GET /admin/geo/search': [] });
    await user.type(screen.getByLabelText('Search for an address'), 'nowhere');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('No places found. Try a different address.')).toBeVisible();
  });

  it.each([
    [429, 'SEARCH_BUSY', 'Search is busy. Try again in a moment.'],
    [502, 'SEARCH_UNAVAILABLE', 'Address search is not available right now.'],
  ])('shows the reason when search answers %i', async (status, code, message) => {
    const { user } = setup({ 'GET /admin/geo/search': () => apiError(status, code) });
    await user.type(screen.getByLabelText('Search for an address'), 'MG Road{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
  });

  it('reads a pasted Google Maps link and passes the place name on', async () => {
    const { calls, user } = setup({
      'POST /admin/geo/resolve-link': { lat: 20.2961, lng: 85.8245, name: 'Head Office' },
    });
    const box = screen.getByLabelText('Paste a Google Maps link');
    await user.type(box, 'https://maps.app.goo.gl/abc');
    await user.click(screen.getByRole('button', { name: 'Use link' }));
    await waitFor(() => expect(lat()).toHaveValue(20.2961));
    expect(lng()).toHaveValue(85.8245);
    expect(screen.getByTestId('name')).toHaveTextContent('Head Office');
    expect(box).toHaveValue('');
    expect(jsonBody(calls.find((c) => c.method === 'POST') as Call)).toEqual({
      url: 'https://maps.app.goo.gl/abc',
    });
  });

  it('says so when the link cannot be read and leaves the pin alone', async () => {
    const { user } = setup({
      'POST /admin/geo/resolve-link': () => apiError(422, 'LINK_NOT_RESOLVED'),
    });
    await user.type(
      screen.getByLabelText('Paste a Google Maps link'),
      'https://example.com{Enter}',
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No location could be read from that link.',
    );
    expect(lat()).toHaveValue(null);
  });
});

describe('toCenter', () => {
  it.each([
    ['20.5', '85.1', { lat: 20.5, lng: 85.1 }],
    ['', '85.1', null],
    ['20.5', '', null],
    ['91', '85.1', null],
    ['20.5', '181', null],
    ['abc', '85.1', null],
  ])('%s, %s', (a, b, expected) => {
    expect(toCenter(a, b)).toEqual(expected);
  });
});
