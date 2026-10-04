import { useInfiniteQuery } from '@tanstack/react-query';
import type { components } from 'api-types';
import { ChevronRight, CircleCheck, CircleMinus, MapPinPlus } from '@/components/icons';
import { useRouter } from 'expo-router';
import type { Href } from 'expo-router';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import { AppText } from '@/components/ui/app-text';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { api } from '@/lib/api';
import { unwrap } from '@/lib/api-error';
import { useTheme } from '@/lib/theme';
import { Meta } from './meta';
import { PagedList } from './paged-list';

export type Branch = components['schemas']['BranchOut'];

export function BranchStatus({ branch }: { branch: Branch }) {
  const { t } = useTranslation();
  return branch.is_active ? (
    <Badge status="success" icon={CircleCheck} label={t('branches.active')} />
  ) : (
    <Badge status="neutral" icon={CircleMinus} label={t('branches.inactive')} />
  );
}

function BranchRow({ branch, onOpen }: { branch: Branch; onOpen: () => void }) {
  const { t } = useTranslation();
  const { colors, space } = useTheme();
  const address = branch.address ?? t('branches.noAddress');
  const radius = t('branches.metres', { count: branch.radius_m });
  // One spoken sentence for the whole row: the parts inside a button are not read one by one.
  const spoken = [
    branch.name,
    address,
    `${t('branches.radius')} ${radius}`,
    t(branch.is_active ? 'branches.active' : 'branches.inactive'),
  ].join(', ');

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={spoken}
      onPress={onOpen}
      style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
    >
      <Card style={{ flexDirection: 'row', alignItems: 'center' }}>
        <View style={{ flex: 1, gap: space[1] }}>
          <AppText weight={600}>{branch.name}</AppText>
          <AppText variant="small" color="muted">
            {address}
          </AppText>
          <Meta label={t('branches.radius')} value={radius} />
          <BranchStatus branch={branch} />
        </View>
        <ChevronRight size={20} strokeWidth={1.75} color={colors.muted} />
      </Card>
    </Pressable>
  );
}

export function BranchesSection({ top }: { top: ReactNode }) {
  const { t } = useTranslation();
  const router = useRouter();

  const list = useInfiniteQuery({
    queryKey: ['admin', 'branches'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/api/v1/admin/branches', { params: { query: { limit: 20, cursor: pageParam } } }),
      ),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    // No silent retries: a 403 shows at once, and Retry and pull to refresh are on screen.
    retry: false,
  });

  return (
    <PagedList
      query={list}
      empty={t('branches.empty')}
      renderItem={(branch) => (
        <BranchRow
          branch={branch}
          // The same cast as for the employee routes: see employees-section.tsx.
          onOpen={() => router.push(`/admin/branches/${branch.id}` as Href)}
        />
      )}
      header={
        <>
          {top}
          <Button
            variant="secondary"
            icon={MapPinPlus}
            label={t('branches.newHere')}
            onPress={() => router.push('/admin/branches/new' as Href)}
          />
        </>
      }
    />
  );
}
