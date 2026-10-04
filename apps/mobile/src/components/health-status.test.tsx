import { QueryClient } from '@tanstack/react-query';
import { fireEvent, screen } from '@testing-library/react-native';
import { renderWithTheme } from '@/test/render';
import { HealthStatus } from './health-status';

const body = (status: 'ok' | 'error', database: 'ok' | 'error' = 'ok') => ({
  status,
  checks: { database, redis: 'ok', storage: 'ok' },
});

// Status icons are decorative for screen readers (the badge carries the label), so the default
// queries skip them.
const HIDDEN = { includeHiddenElements: true };

// gcTime Infinity: the default 5 min GC timer would keep the jest process alive after unmount.
const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });

const renderStatus = () => renderWithTheme(<HealthStatus />, client);

describe('HealthStatus', () => {
  beforeEach(() => jest.mocked(fetch).mockReset());
  afterEach(() => client.clear());

  it('shows loading, then connected', async () => {
    // Answered by hand: the themed render settles later than a bare one, so an instant reply
    // would already be on the screen and the loading state could not be observed.
    let answer: (response: Response) => void = () => {};
    jest.mocked(fetch).mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await renderStatus();
    expect(screen.getByLabelText('Checking backend...')).toBeOnTheScreen();
    expect(screen.getByTestId('health-icon-checking', HIDDEN)).toBeOnTheScreen();
    answer(Response.json(body('ok')));
    expect(await screen.findByText('Backend: connected')).toBeOnTheScreen();
    expect(screen.getByTestId('health-icon-connected', HIDDEN)).toBeOnTheScreen();
    expect(screen.queryByText(/Not working/)).toBeNull();
  });

  it('shows unreachable and the failing component on a 503 body', async () => {
    jest.mocked(fetch).mockResolvedValue(Response.json(body('error', 'error'), { status: 503 }));
    await renderStatus();
    expect(await screen.findByText('Backend: unreachable')).toBeOnTheScreen();
    expect(screen.getByText('Not working: Database')).toBeOnTheScreen();
    // The backend answered: degraded is a warning icon, not the unreachable error icon.
    expect(screen.getByTestId('health-icon-degraded', HIDDEN)).toBeOnTheScreen();
  });

  it('shows unreachable on a network error and recovers on retry', async () => {
    jest.mocked(fetch).mockRejectedValueOnce(new TypeError('Network request failed'));
    await renderStatus();
    expect(await screen.findByText('Backend: unreachable')).toBeOnTheScreen();
    expect(screen.queryByText(/Not working/)).toBeNull();
    expect(screen.getByTestId('health-icon-unreachable', HIDDEN)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeOnTheScreen();

    jest.mocked(fetch).mockResolvedValue(Response.json(body('ok')));
    await fireEvent.press(screen.getByText('Retry'));
    expect(await screen.findByText('Backend: connected')).toBeOnTheScreen();
  });
});
