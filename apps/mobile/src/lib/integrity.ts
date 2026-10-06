import * as Device from 'expo-device';

/** What this phone says about itself. Only reported: the server decides what happens (FR-ATT-03). */
export type Integrity = { emulator: boolean; rooted: boolean };

export async function getIntegrity(): Promise<Integrity> {
  let rooted = false;
  try {
    rooted = await Device.isRootedExperimentalAsync();
  } catch (error) {
    // The check is experimental; when it fails the phone counts as not rooted, and the failure is
    // logged. It must never stop an employee from punching.
    console.warn('[integrity] the root check failed', error);
  }
  return { emulator: !Device.isDevice, rooted };
}
