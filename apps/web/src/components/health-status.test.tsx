import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';
import { HealthIndicator } from './health-status';

const body = (status: 'ok' | 'error', database: 'ok' | 'error' = 'ok') => ({
  status,
  checks: { database, redis: 'ok', storage: 'ok' },
});

function renderIndicator() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <HealthIndicator />
    </QueryClientProvider>,
  );
}

describe('HealthIndicator', () => {
  it('shows checking, then connected with an icon', async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json(body('ok')));
    renderIndicator();
    const indicator = screen.getByTestId('health-indicator');
    expect(indicator).toHaveTextContent('Backend: checking...');
    expect(await screen.findByText('Backend: connected')).toBeInTheDocument();
    expect(indicator).toHaveAttribute('data-state', 'connected');
    expect(indicator.querySelector('svg')).not.toBeNull();
  });

  it('shows degraded on a 503 with the same body shape', async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json(body('error', 'error'), { status: 503 }));
    renderIndicator();
    expect(await screen.findByText('Backend: degraded')).toBeInTheDocument();
    expect(screen.getByTestId('health-indicator')).toHaveAttribute('data-state', 'degraded');
  });

  it('shows unreachable on a network error', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'));
    renderIndicator();
    expect(await screen.findByText('Backend: unreachable')).toBeInTheDocument();
    expect(screen.getByTestId('health-indicator')).toHaveAttribute('data-state', 'unreachable');
  });

  it('shows unreachable on an unexpected status', async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ detail: 'boom' }, { status: 500 }));
    renderIndicator();
    expect(await screen.findByText('Backend: unreachable')).toBeInTheDocument();
  });
});
