'use client';

import { useState, type ComponentProps } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Input } from './input';

// Only `type` changes; id, name and autocomplete stay as given so password managers keep working.
export function PasswordInput({ className, ...props }: Omit<ComponentProps<typeof Input>, 'type'>) {
  const { t } = useTranslation();
  const [shown, setShown] = useState(false);
  const Icon = shown ? EyeOff : Eye;
  return (
    <div className="relative">
      <Input {...props} type={shown ? 'text' : 'password'} className={cn('pr-10', className)} />
      <button
        type="button"
        aria-pressed={shown}
        aria-label={t(shown ? 'password.hide' : 'password.show')}
        onClick={() => setShown((value) => !value)}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
      >
        <Icon aria-hidden="true" className="size-4" />
      </button>
    </div>
  );
}
