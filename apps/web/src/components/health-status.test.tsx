import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';
import { HealthStatus } from './health-status';

const body = (status: 'ok' | 'error', database: 'ok' | 'error' = 'ok') => ({
  status,
  checks: { database, redis: 'ok', storage: 'ok' },
});

function renderStatus() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <HealthStatus />
    </QueryClientProvider>,
  );
}

describe('HealthStatus', () => {
  it('shows loading, then ok with every component', async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json(body('ok')));
    renderStatus();
    expect(screen.getByRole('status')).toHaveTextContent('Checking backend...');
    expect(await screen.findByText('All systems operational')).toBeInTheDocument();
    for (const name of ['database', 'redis', 'storage']) {
      expect(screen.getByTestId(`check-${name}`)).toHaveTextContent('OK');
    }
  });

  it('shows which component failed on a 503', async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json(body('error', 'error'), { status: 503 }));
    renderStatus();
    expect(await screen.findByText('Backend degraded')).toBeInTheDocument();
    expect(screen.getByTestId('check-database')).toHaveTextContent('Database: Failing');
    expect(screen.getByTestId('check-redis')).toHaveTextContent('Redis: OK');
  });

  it('shows unreachable on a network error', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'));
    renderStatus();
    expect(await screen.findByText('Backend unreachable')).toBeInTheDocument();
    expect(screen.queryByTestId('check-database')).not.toBeInTheDocument();
  });

  it('shows unreachable on an unexpected status', async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ detail: 'boom' }, { status: 500 }));
    renderStatus();
    expect(await screen.findByText('Backend unreachable')).toBeInTheDocument();
  });
});
