'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Page, PageHeader } from '@/components/page';
import { hasPermission, RequirePermission } from '@/components/require-permission';
import { Tabs } from '@/components/tabs';
import { useMe } from '@/lib/me';
import { ExceptionsTab } from './exceptions-tab';
import { RegisterTab } from './register-tab';
import { RequestsTab, useRequests } from './requests-tab';
import { ReviewsTab, useReviews } from './reviews-tab';

type TabId = 'register' | 'requests' | 'reviews' | 'exceptions';

// Each tab needs one of these permissions; the server enforces them, this keeps the strip honest.
const TAB_PERMISSIONS: Record<TabId, string[]> = {
  register: ['team.view', 'attendance.view_all'],
  requests: ['punchout.approve'],
  reviews: ['face.review'],
  exceptions: ['attendance.view_all'],
};
const ORDER: TabId[] = ['register', 'requests', 'reviews', 'exceptions'];

function AttendanceView() {
  const { t } = useTranslation();
  const { data: me } = useMe();
  const held = me?.permissions ?? [];
  const tabs = ORDER.filter((id) => hasPermission(held, TAB_PERMISSIONS[id]));
  const [chosen, setChosen] = useState<TabId>('register');
  const tab = tabs.includes(chosen) ? chosen : tabs[0];
  // The same queries the tabs run, so the counts cost no extra requests.
  const requests = useRequests('waiting', tabs.includes('requests'));
  const reviews = useReviews('pending', '', tabs.includes('reviews'));
  const count = (pages: { items: unknown[] }[] | undefined) =>
    pages?.reduce((sum, page) => sum + page.items.length, 0);

  return (
    <Page>
      <PageHeader title={t('attendance.title')} />
      <Tabs
        label={t('attendance.title')}
        value={tab}
        onChange={setChosen}
        tabs={tabs.map((id) => ({
          id,
          label: t(`attendance.tab.${id}`),
          count:
            id === 'requests'
              ? count(requests.data?.pages)
              : id === 'reviews'
                ? count(reviews.data?.pages)
                : undefined,
        }))}
      />
      {tab === 'register' && <RegisterTab />}
      {tab === 'requests' && <RequestsTab />}
      {tab === 'reviews' && <ReviewsTab />}
      {tab === 'exceptions' && <ExceptionsTab />}
    </Page>
  );
}

export function AttendancePage() {
  return (
    <RequirePermission permission={Object.values(TAB_PERMISSIONS).flat()}>
      <AttendanceView />
    </RequirePermission>
  );
}
