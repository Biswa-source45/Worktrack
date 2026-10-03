import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react-native';
import '@/lib/i18n';
import { HealthStatus } from './health-status';

const body = (status: 'ok' | 'error', database: 'ok' | 'error' = 'ok') => ({
  status,
  checks: { database, redis: 'ok', storage: 'ok' },
});

// gcTime Infinity: the default 5 min GC timer would keep the jest process alive after unmount.
const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });

async function renderStatus() {
  await render(
    <QueryClientProvider client={client}>
      <HealthStatus />
    </QueryClientProvider>,
  );
}

describe('HealthStatus', () => {
  beforeEach(() => jest.mocked(fetch).mockReset());
  afterEach(() => client.clear());

  it('shows loading, then connected', async () => {
    jest.mocked(fetch).mockResolvedValue(Response.json(body('ok')));
    await renderStatus();
    expect(screen.getByLabelText('Checking backend...')).toBeOnTheScreen();
    expect(await screen.findByText('Backend: connected')).toBeOnTheScreen();
    expect(screen.queryByText(/Not working/)).toBeNull();
  });

  it('shows unreachable and the failing component on a 503 body', async () => {
    jest.mocked(fetch).mockResolvedValue(Response.json(body('error', 'error'), { status: 503 }));
    await renderStatus();
    expect(await screen.findByText('Backend: unreachable')).toBeOnTheScreen();
    expect(screen.getByText('Not working: Database')).toBeOnTheScreen();
  });

  it('shows unreachable on a network error and recovers on retry', async () => {
    jest.mocked(fetch).mockRejectedValueOnce(new TypeError('Network request failed'));
    await renderStatus();
    expect(await screen.findByText('Backend: unreachable')).toBeOnTheScreen();
    expect(screen.queryByText(/Not working/)).toBeNull();

    jest.mocked(fetch).mockResolvedValue(Response.json(body('ok')));
    await fireEvent.press(screen.getByText('Retry'));
    expect(await screen.findByText('Backend: connected')).toBeOnTheScreen();
  });
});
