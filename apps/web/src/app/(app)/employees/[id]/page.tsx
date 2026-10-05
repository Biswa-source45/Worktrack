import { notFound } from 'next/navigation';
import { EmployeeDetailPage } from '@/components/employees/employee-detail-page';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d+$/.test(id)) notFound();
  return <EmployeeDetailPage employeeId={Number(id)} />;
}
