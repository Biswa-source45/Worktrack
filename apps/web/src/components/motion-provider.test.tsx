import { useContext } from 'react';
import { render, screen } from '@testing-library/react';
import { MotionConfigContext } from 'motion/react';
import { describe, expect, it } from 'vitest';
import { MotionProvider } from './motion-provider';

function Probe() {
  return <p>{useContext(MotionConfigContext).reducedMotion}</p>;
}

describe('MotionProvider', () => {
  // "user" is what makes every motion component follow the OS "reduce motion" setting.
  it("makes motion follow the visitor's reduced-motion setting", () => {
    render(
      <MotionProvider>
        <Probe />
      </MotionProvider>,
    );
    expect(screen.getByText('user')).toBeInTheDocument();
  });
});
