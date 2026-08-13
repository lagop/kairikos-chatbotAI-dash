import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';

export default async function AdminIndexPage() {
  const session = await getSession();
  if (session.isOperator) {
    redirect('/admin/portal/clients');
  }
  redirect('/admin/login?next=/admin');
}
