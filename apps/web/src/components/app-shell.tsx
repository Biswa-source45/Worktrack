'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LogOut, Menu, PanelLeftClose, PanelLeftOpen, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useTranslation } from 'react-i18next';
import { HealthIndicator } from '@/components/health-status';
import { NoAccess } from '@/components/require-permission';
import { SidebarNav, visibleGroups } from '@/components/sidebar';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { errorMessage } from '@/lib/api-client';
import { useMe } from '@/lib/me';
import { cn } from '@/lib/utils';

const COLLAPSED_KEY = 'wt-sidebar-collapsed';

// Only a per-viewer convenience: a blocked or full store just means the sidebar starts expanded.
function readCollapsed() {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean) {
  try {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // Not persisted; the choice still holds until the page reloads.
  }
}

export function AppShell({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const { data: me, error, isPending, refetch } = useMe();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  // The drawer is open for the page it was opened on: a tap on a link, the back button or a
  // redirect changes the path and so closes it.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const drawerOpen = openOn === pathname;
  const setDrawerOpen = (open: boolean) => setOpenOn(open ? pathname : null);

  // The backend refuses everything else until the temporary password is changed.
  const mustChange = me?.must_change_password === true;
  useEffect(() => {
    if (mustChange) router.replace('/change-password');
  }, [mustChange, router]);

  const logout = useMutation({
    mutationFn: () => fetch('/api/auth/logout', { method: 'POST' }),
    onSuccess: () => {
      queryClient.clear();
      router.replace('/login');
    },
  });

  if (error) {
    return (
      <main className="grid min-h-screen place-items-center p-4">
        <Card className="w-full max-w-md space-y-4">
          <p role="alert" className="text-danger">
            {errorMessage(t, error)}
          </p>
          <Button variant="outline" onClick={() => void refetch()}>
            {t('common.retry')}
          </Button>
        </Card>
      </main>
    );
  }
  if (isPending || mustChange) {
    return (
      <p role="status" className="grid min-h-screen place-items-center text-muted-foreground">
        {t('common.loading')}
      </p>
    );
  }

  const groups = visibleGroups(me.permissions);
  const footer = (rail: boolean) => (
    <div className={cn('space-y-3 border-t p-3', rail && 'flex flex-col items-center')}>
      <HealthIndicator iconOnly={rail} />
      <ThemeToggle compact vertical={rail} />
      <div title={me.name} className="flex items-center gap-2">
        <Avatar name={me.name} />
        <div className={cn('min-w-0', rail && 'sr-only')}>
          <p className="truncate text-small font-medium">{me.name}</p>
          <p className="truncate text-caption text-muted-foreground">{me.role.name}</p>
        </div>
      </div>
      <Button
        variant="outline"
        size={rail ? 'icon' : 'sm'}
        className={cn(!rail && 'w-full')}
        title={rail ? t('nav.logout') : undefined}
        onClick={() => logout.mutate()}
        disabled={logout.isPending}
      >
        <LogOut aria-hidden="true" />
        <span className={cn(rail && 'sr-only')}>{t('nav.logout')}</span>
      </Button>
    </div>
  );
  const brand = (
    <Link href="/" className="truncate rounded-sm text-large font-bold">
      {t('app.title')}
    </Link>
  );

  return (
    <div className="min-h-screen lg:flex">
      <aside
        className={cn(
          'sticky top-0 hidden h-screen shrink-0 flex-col border-r bg-surface lg:flex',
          collapsed ? 'w-16' : 'w-60',
        )}
      >
        <div
          className={cn(
            'flex h-14 items-center gap-2 px-3',
            collapsed ? 'justify-center' : 'justify-between pl-6',
          )}
        >
          {!collapsed && brand}
          <Button
            variant="ghost"
            size="icon"
            aria-label={t(collapsed ? 'nav.expand' : 'nav.collapse')}
            aria-expanded={!collapsed}
            onClick={() => {
              writeCollapsed(!collapsed);
              setCollapsed(!collapsed);
            }}
          >
            {collapsed ? (
              <PanelLeftOpen aria-hidden="true" />
            ) : (
              <PanelLeftClose aria-hidden="true" />
            )}
          </Button>
        </div>
        <SidebarNav groups={groups} pathname={pathname} collapsed={collapsed} />
        {footer(collapsed)}
      </aside>

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-40 flex h-12 items-center gap-2 border-b bg-surface px-3 lg:hidden">
          <Button
            variant="ghost"
            size="icon"
            className="size-11"
            aria-label={t('nav.openMenu')}
            onClick={() => setDrawerOpen(true)}
          >
            <Menu aria-hidden="true" />
          </Button>
          {brand}
        </header>
        <main className="mx-auto max-w-7xl p-4">
          {groups.length === 0 ? <NoAccess /> : children}
        </main>
      </div>

      {/* The sidebar as a drawer below 1024 px. Radix gives it the focus trap, Escape and the overlay. */}
      <DialogPrimitive.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay/50 duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out data-[state=open]:animate-in data-[state=open]:fade-in lg:hidden" />
          <DialogPrimitive.Content
            aria-describedby={undefined}
            className="fixed inset-y-0 left-0 z-50 flex w-60 max-w-[85vw] flex-col border-r bg-surface shadow-lg duration-200 ease-out outline-none data-[state=closed]:animate-out data-[state=closed]:slide-out-to-left data-[state=open]:animate-in data-[state=open]:slide-in-from-left lg:hidden"
          >
            <div className="flex h-14 items-center justify-between pr-3 pl-6">
              {brand}
              <DialogPrimitive.Title className="sr-only">{t('nav.menu')}</DialogPrimitive.Title>
              <DialogPrimitive.Close asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-11"
                  aria-label={t('nav.closeMenu')}
                >
                  <X aria-hidden="true" />
                </Button>
              </DialogPrimitive.Close>
            </div>
            <SidebarNav
              groups={groups}
              pathname={pathname}
              onNavigate={() => setDrawerOpen(false)}
            />
            {footer(false)}
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </div>
  );
}
