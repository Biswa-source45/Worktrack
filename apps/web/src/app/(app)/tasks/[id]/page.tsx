import { notFound } from 'next/navigation';
import { TaskDetailPage } from '@/components/tasks/task-detail-page';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d+$/.test(id)) notFound();
  return <TaskDetailPage id={Number(id)} />;
}
