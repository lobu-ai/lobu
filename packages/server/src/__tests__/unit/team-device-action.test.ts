import { describe, expect, it } from "bun:test";
import { teamDeviceAction } from '../../worker-api/team-device-action';

describe('teamDeviceAction', () => {
  it.each([
    ['row 1: nothing installed', null, '1.0.0', 'install'],
    ['row 1: nothing installed (undefined)', undefined, '0.0.1', 'install'],
    ['row 2: device newer', '1.0.0', '1.2.0', 'advance'],
    ['row 2: numeric, not lexical', '0.9.0', '0.10.0', 'advance'],
    ['row 3: same version', '1.2.0', '1.2.0', 'active'],
    ['row 4: device older', '1.2.0', '1.0.0', 'behind'],
    ['row 4: numeric, not lexical', '0.10.0', '0.9.0', 'behind'],
  ] as const)('%s', (_row, installed, advertised, expected) => {
    expect(teamDeviceAction(installed, advertised)).toBe(expected);
  });
});
