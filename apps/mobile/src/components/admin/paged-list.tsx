import type { InfiniteData, UseInfiniteQueryResult } from '@tanstack/react-query';
import { RefreshCw, TriangleAlert } from '@/components/icons';
import { useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, RefreshControl, View } from 'react-native';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { errorText } from '@/lib/api-error';
import { useTheme } from '@/lib/theme';

type Page<T> = { items: T[]; next_cursor: string | null };

type Props<T extends { id: number }> = {
  query: UseInfiniteQueryResult<InfiniteData<Page<T>>>;
  /** Title and filters; they scroll away with the rows so the list keeps the whole screen. */
  header: ReactNode;
  renderItem: (item: T) => ReactElement;
  empty: string;
};

const SKELETON_ROWS = [0, 1, 2];

export function PagedList<T extends { id: number }>({
  query,
  header,
  renderItem,
  empty,
}: Props<T>) {
  const { t } = useTranslation();
  const { colors, space } = useTheme();
  // Only a pull shows the spinner; a reload after an action must not make the list jump.
  const [pulled, setPulled] = useState(false);
  // Placeholder rows belong to the previous filter, so they are not shown as this one's.
  const loading = query.isPending || query.isPlaceholderData;
  const rows = loading ? [] : (query.data?.pages.flatMap((page) => page.items) ?? []);

  async function pull() {
    setPulled(true);
    try {
      await query.refetch();
    } finally {
      setPulled(false);
    }
  }

  return (
    <FlatList
      testID="admin-list"
      // Scrolling the results puts the search keyboard away.
      keyboardDismissMode="on-drag"
      data={rows}
      keyExtractor={(item) => String(item.id)}
      renderItem={({ item }) => renderItem(item)}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ flexGrow: 1, padding: space[5], gap: space[4] }}
      refreshControl={
        <RefreshControl
          refreshing={pulled}
          onRefresh={() => void pull()}
          tintColor={colors.primary}
          colors={[colors.primary]}
          progressBackgroundColor={colors.surface}
        />
      }
      ListHeaderComponent={
        <View style={{ gap: space[4] }}>
          {header}
          {query.isError ? (
            <Banner status="danger" icon={TriangleAlert} message={errorText(t, query.error)}>
              <Button
                variant="secondary"
                icon={RefreshCw}
                label={t('common.retry')}
                onPress={() => void query.refetch()}
                disabled={query.isFetching}
              />
            </Banner>
          ) : null}
        </View>
      }
      ListEmptyComponent={
        query.isError ? null : loading ? (
          <View style={{ gap: space[4] }}>
            {SKELETON_ROWS.map((row) => (
              <Card key={row}>
                <Skeleton
                  width="60%"
                  height={space[5]}
                  accessibilityLabel={row === 0 ? t('common.loading') : undefined}
                />
                <Skeleton />
                <Skeleton width="80%" />
              </Card>
            ))}
          </View>
        ) : (
          <EmptyState message={empty} />
        )
      }
      ListFooterComponent={
        query.hasNextPage && !loading ? (
          <Button
            variant="secondary"
            label={t('common.loadMore')}
            onPress={() => void query.fetchNextPage()}
            loading={query.isFetchingNextPage}
          />
        ) : null
      }
    />
  );
}
