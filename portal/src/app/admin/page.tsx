import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';

export default async function AdminIndexPage() {
  const session = await getSession();
  if (session.isOperator) {
    redirect('/admin/portal');
  }
  return (
    <div className="flex min-h-screen items-center justify-center">
      <p className="text-kairikos-muted">No tienes acceso a esta sección.</p>
    </div>
  );
}
