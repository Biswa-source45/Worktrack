'use client';

import { useState } from 'react';
import {
  BadgeCheck,
  Briefcase,
  Building2,
  CalendarDays,
  CalendarOff,
  CircleCheck,
  CircleMinus,
  CircleX,
  Clock,
  Contrast,
  Hourglass,
  House,
  LogOut,
  MapPinOff,
  Plane,
  ScanFace,
  TriangleAlert,
  WifiOff,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { StatusBadge } from '@/components/status-badge';
import { Badge, type Tone } from '@/components/ui/badge';
import type { Schemas } from '@/lib/api-client';

// Every day status has its own icon, so statuses that share a tone (the four info ones, the
// three warnings) stay apart without colour.
const DAY_LOOK: Record<string, { tone: Tone; icon: LucideIcon }> = {
  working: { tone: 'info', icon: Briefcase },
  present: { tone: 'success', icon: CircleCheck },
  half_day: { tone: 'warning', icon: Contrast },
  short_hours: { tone: 'warning', icon: Hourglass },
  pending: { tone: 'warning', icon: Clock },
  absent: { tone: 'danger', icon: CircleX },
  missed_punch_out: { tone: 'danger', icon: LogOut },
  holiday: { tone: 'neutral', icon: CalendarDays },
  weekly_off: { tone: 'neutral', icon: CalendarOff },
  leave: { tone: 'info', icon: Plane },
  work_from_home: { tone: 'info', icon: House },
  on_duty: { tone: 'info', icon: BadgeCheck },
  no_record: { tone: 'neutral', icon: CircleMinus },
};

export function DayStatusBadge({ status }: { status: string }) {
  const { t } = useTranslation();
  const look = DAY_LOOK[status] ?? DAY_LOOK.no_record;
  return (
    <StatusBadge
      tone={look.tone}
      icon={look.icon}
      label={t(`attendance.dayStatus.${status}`, { defaultValue: status })}
      testId={`day-${status}`}
    />
  );
}

const FACE_LOOK: Record<string, { tone: Tone; icon: LucideIcon }> = {
  VERIFIED: { tone: 'success', icon: CircleCheck },
  PENDING_REVIEW: { tone: 'warning', icon: Clock },
  MISMATCH: { tone: 'danger', icon: CircleX },
  RETAKE: { tone: 'neutral', icon: ScanFace },
};

/** The server's verdict on the selfie. Only admins ever see this and the score next to it. */
export function FaceBadge({ decision }: { decision: string }) {
  const { t } = useTranslation();
  const look = FACE_LOOK[decision] ?? FACE_LOOK.RETAKE;
  return (
    <StatusBadge
      tone={look.tone}
      icon={look.icon}
      label={t(`attendance.face.${decision}`, { defaultValue: decision })}
    />
  );
}

const REVIEW_TONE: Record<string, Tone> = {
  verified: 'success',
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
};

export function ReviewBadge({ status }: { status: string }) {
  const { t } = useTranslation();
  return (
    <StatusBadge
      tone={REVIEW_TONE[status] ?? 'neutral'}
      label={t(`attendance.reviewStatus.${status}`, { defaultValue: status })}
    />
  );
}

const FLAG_LOOK: Record<string, LucideIcon> = {
  offline: WifiOff,
  mock: MapPinOff,
  face_review: ScanFace,
  jump: Zap,
};

/** Small icon chips for what needs a second look on a day. Each has a name for screen readers. */
export function FlagChips({ flags }: { flags: string[] }) {
  const { t } = useTranslation();
  if (flags.length === 0) return <span aria-hidden="true">-</span>;
  return (
    <span className="flex gap-1">
      {flags.map((flag) => {
        const Icon = FLAG_LOOK[flag] ?? TriangleAlert;
        const label = t(`attendance.flag.${flag}`, { defaultValue: flag });
        return (
          <Badge key={flag} tone="warning" role="img" aria-label={label} title={label}>
            <Icon aria-hidden="true" />
          </Badge>
        );
      })}
    </span>
  );
}

/** "7h 05m"; the unit letters are part of the text so a screen reader says them. */
export function Hours({ minutes }: { minutes: number }) {
  const { t } = useTranslation();
  return (
    <span className="tabular-nums">
      {t('attendance.hours', {
        h: Math.floor(minutes / 60),
        m: String(minutes % 60).padStart(2, '0'),
      })}
    </span>
  );
}

/** A selfie from its short-lived signed link, shown through the portal's proxy. */
export function Selfie({ url, alt }: { url: string; alt: string }) {
  const { t } = useTranslation();
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <p
        role="alert"
        className="flex aspect-square items-center justify-center rounded-md border bg-raised p-2 text-center text-caption text-muted-foreground"
      >
        {t('attendance.selfieFailed')}
      </p>
    );
  }
  return (
    // The signed link is relative; the proxy adds the backend's base.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/api/proxy${url}`}
      alt={alt}
      onError={() => setBroken(true)}
      className="aspect-square w-full rounded-md border bg-raised object-cover"
    />
  );
}

export function Person({ name, code }: { name: string; code: string }) {
  return (
    <span className="grid leading-tight">
      <span className="font-medium">{name}</span>
      <span className="text-caption text-muted-foreground">{code}</span>
    </span>
  );
}

/** Why a punch waits for review, or what the device reported, as readable words. */
export const words = (t: TFunction, group: 'reason' | 'integrity', keys: string[]) =>
  keys.map((key) => t(`attendance.${group}.${key}`, { defaultValue: key })).join(', ');

export function PlaceText({ place }: { place: Schemas['PunchDetail']['place'] }) {
  const { t } = useTranslation();
  const Icon = place.type === 'home' ? House : place.type === 'branch' ? Building2 : MapPinOff;
  return (
    <span className="inline-flex items-center gap-1.5">
      <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      {place.type === 'branch'
        ? t('attendance.place.branch', {
            name: place.branch ?? '-',
            m: Math.round(place.distance_m ?? 0),
          })
        : place.type === 'home'
          ? t('attendance.place.home')
          : t('attendance.place.outside', {
              name: place.branch ?? '-',
              m: Math.round(place.distance_m ?? 0),
            })}
    </span>
  );
}
