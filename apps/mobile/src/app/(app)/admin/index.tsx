import { Building, MonitorSmartphone, Smartphone, UsersRound } from '@/components/icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BranchesSection } from '@/components/admin/branches-section';
import { DevicesSection } from '@/components/admin/devices-section';
import { EmployeesSection } from '@/components/admin/employees-section';
import { SessionsSection } from '@/components/admin/sessions-section';
import { AppText } from '@/components/ui/app-text';
import { Screen } from '@/components/ui/screen';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { can, useAuth } from '@/lib/auth';

const SECTIONS = [
  { key: 'devices', permission: 'devices.manage', icon: Smartphone, Section: DevicesSection },
  { key: 'employees', permission: 'employees.manage', icon: UsersRound, Section: EmployeesSection },
  {
    key: 'sessions',
    permission: 'devices.manage',
    icon: MonitorSmartphone,
    Section: SessionsSection,
  },
  { key: 'branches', permission: 'branches.manage', icon: Building, Section: BranchesSection },
] as const;
type SectionKey = (typeof SECTIONS)[number]['key'];

export default function AdminScreen() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const [chosen, setChosen] = useState<SectionKey | null>(null);
  // Only what the server said this user may manage is offered; the server checks again anyway.
  const offered = SECTIONS.filter((section) => can(me, section.permission));
  const current = offered.find((section) => section.key === chosen) ?? offered[0];
  if (!current) return null;

  const top = (
    <>
      <AppText variant="h1" accessibilityRole="header">
        {offered.length > 1 ? t('admin.title') : t(`admin.sections.${current.key}`)}
      </AppText>
      {offered.length > 1 ? (
        <SegmentedControl
          value={current.key}
          onChange={setChosen}
          options={offered.map(({ key, icon }) => ({
            value: key,
            label: t(`admin.sections.${key}`),
            icon,
          }))}
        />
      ) : null}
    </>
  );

  return (
    // The list inside scrolls and pads itself, so its rows and their shadows reach the edges.
    <Screen edges={['top', 'left', 'right']} contentStyle={{ padding: 0, gap: 0 }}>
      <current.Section top={top} />
    </Screen>
  );
}
