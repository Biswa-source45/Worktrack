'use client';

import { useId } from 'react';
import {
  Building2,
  CalendarCheck,
  CalendarClock,
  ClipboardList,
  LayoutDashboard,
  MonitorSmartphone,
  Settings,
  Smartphone,
  Users,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useTranslation } from 'react-i18next';
import { ActiveIndicator } from '@/components/active-indicator';
import { hasPermission } from '@/components/require-permission';
import { cn } from '@/lib/utils';

type Item = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** A list means "any of these": Attendance and Tasks serve several roles. No permission: always shown. */
  permission?: string | readonly string[];
};

const GROUPS: { label: string; items: Item[] }[] = [
  {
    label: 'nav.group.overview',
    items: [{ href: '/', label: 'nav.dashboard', icon: LayoutDashboard }],
  },
  {
    label: 'nav.group.work',
    items: [
      {
        href: '/tasks',
        label: 'nav.tasks',
        icon: ClipboardList,
        permission: ['tasks.create', 'tasks.view_all', 'team.view'],
      },
      {
        href: '/attendance',
        label: 'nav.attendance',
        icon: CalendarCheck,
        permission: ['team.view', 'attendance.view_all', 'punchout.approve', 'face.review'],
      },
    ],
  },
  {
    label: 'nav.group.people',
    items: [
      { href: '/employees', label: 'nav.employees', icon: Users, permission: 'employees.manage' },
      { href: '/devices', label: 'nav.devices', icon: Smartphone, permission: 'devices.manage' },
      {
        href: '/sessions',
        label: 'nav.sessions',
        icon: MonitorSmartphone,
        permission: 'devices.manage',
      },
    ],
  },
  {
    label: 'nav.group.organisation',
    items: [
      { href: '/branches', label: 'nav.branches', icon: Building2, permission: 'branches.manage' },
      { href: '/shifts', label: 'nav.shifts', icon: CalendarClock, permission: 'branches.manage' },
      { href: '/settings', label: 'nav.settings', icon: Settings, permission: 'settings.view' },
    ],
  },
];

/**
 * The groups of links this user may open. Empty when nothing but the always-shown Dashboard would
 * be left: such a user gets the "no access" page instead of a menu to nowhere.
 */
export function visibleGroups(permissions: readonly string[]) {
  const groups = GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((i) => !i.permission || hasPermission(permissions, i.permission)),
  })).filter((group) => group.items.length > 0);
  const gated = groups.some((g) => g.items.some((i) => i.permission));
  return gated ? groups : [];
}

type Props = {
  groups: ReturnType<typeof visibleGroups>;
  pathname: string;
  /** The 64px icon rail: labels stay for screen readers and as tooltips. */
  collapsed?: boolean;
  onNavigate?: () => void;
};

export function SidebarNav({ groups, pathname, collapsed = false, onNavigate }: Props) {
  const { t } = useTranslation();
  const indicator = useId();
  return (
    <nav
      aria-label={t('nav.label')}
      className={cn('flex-1 space-y-4 overflow-y-auto py-2', collapsed ? 'px-2' : 'px-3')}
    >
      {groups.map((group) => (
        <div key={group.label} role="group" aria-label={t(group.label)} className="space-y-1">
          <p
            aria-hidden="true"
            className={cn(
              'px-3 text-caption font-semibold tracking-wide text-muted-foreground uppercase',
              collapsed && 'sr-only',
            )}
          >
            {t(group.label)}
          </p>
          {group.items.map((item) => {
            const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                title={collapsed ? t(item.label) : undefined}
                aria-current={active ? 'page' : undefined}
                onClick={onNavigate}
                className={cn(
                  'relative flex h-11 items-center gap-3 rounded-full px-3 text-small font-medium transition-transform active:scale-(--wt-press-scale)',
                  collapsed && 'mx-auto w-11 justify-center px-0',
                  active
                    ? 'font-semibold text-primary-foreground'
                    : 'text-muted-foreground hover:bg-raised hover:text-foreground',
                )}
              >
                {active && <ActiveIndicator id={indicator} className="bg-primary" />}
                <item.icon aria-hidden="true" className="relative size-5 shrink-0" />
                {/* `relative` would override sr-only's absolute position and keep the hidden label in
                    the flow, pushing the icon off the centre of the rail. */}
                <span className={collapsed ? 'sr-only' : 'relative truncate'}>{t(item.label)}</span>
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
