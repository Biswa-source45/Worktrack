import { Eye, EyeOff } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable } from 'react-native';
import { useTheme } from '@/lib/theme';
import { Field } from './field';
import type { FieldProps } from './field';

type Props = Omit<
  FieldProps,
  'secureTextEntry' | 'trailing' | 'textContentType' | 'autoComplete'
> & {
  /** `new` tells password managers to offer a fresh password instead of the saved one. */
  kind?: 'current' | 'new';
};

export function PasswordField({ kind = 'current', ...field }: Props) {
  const { t } = useTranslation();
  const { colors, minTouchTarget } = useTheme();
  const [visible, setVisible] = useState(false);
  const Icon = visible ? EyeOff : Eye;

  return (
    <Field
      {...field}
      secureTextEntry={!visible}
      textContentType={kind === 'new' ? 'newPassword' : 'password'}
      autoComplete={kind === 'new' ? 'new-password' : 'password'}
      trailing={
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={visible ? t('password.hide') : t('password.show')}
          onPress={() => setVisible((shown) => !shown)}
          style={{
            width: minTouchTarget,
            height: minTouchTarget,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon size={20} strokeWidth={1.75} color={colors.muted} />
        </Pressable>
      }
    />
  );
}
