import { HealthStatus } from '@/components/health-status';

export default function Home() {
  return (
    <main className="mx-auto max-w-xl p-8">
      <HealthStatus />
    </main>
  );
}
