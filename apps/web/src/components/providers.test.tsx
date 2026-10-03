import { useQuery, useQueryClient } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api-client';
import { Providers } from './providers';

const router = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

beforeEach(() => router.replace.mockReset());

function Probe({ status }: { status: number }) {
  const client = useQueryClient();
  const { isError } = useQuery({
    queryKey: ['probe'],
    queryFn: () => Promise.reject(new ApiError(status, 'X', null)),
  });
  return (
    <p>
      {isError ? 'failed' : 'loading'} cached={client.getQueryCache().getAll().length}
    </p>
  );
}

describe('Providers', () => {
  it('sends the user to /login and clears the cache when a request ends in 401', async () => {
    render(
      <Providers>
        <Probe status={401} />
      </Providers>,
    );
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/login'));
  });

  it('leaves other API errors to the screen and does not retry them', async () => {
    render(
      <Providers>
        <Probe status={403} />
      </Providers>,
    );
    expect(await screen.findByText(/failed/)).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
  });
});
