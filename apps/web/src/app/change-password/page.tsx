import { AuthLayout } from '@/components/auth/auth-layout';
import { ChangePasswordForm } from '@/components/auth/change-password-form';

export default function ChangePasswordPage() {
  return (
    <AuthLayout>
      <ChangePasswordForm />
    </AuthLayout>
  );
}
