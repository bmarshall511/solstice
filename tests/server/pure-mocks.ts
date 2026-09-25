// Global mocks for the `server` project (pure code only). A vi.mock in a setup file applies to every test file in the
// project, so nobody can forget it. Any function that claims to be pure and touches the database goes red with
// "db in pure test"; pdf.js is never loaded; ScreenLogic and Nest report "not configured" and never write.
import { vi } from 'vitest';

vi.mock(import('../../server/src/db.js'), () => {
  const pure = (what: string) => () => { throw new Error(`db in pure test (${what})`); };
  return {
    q: vi.fn(pure('q')), one: vi.fn(pure('one')), migrate: vi.fn(pure('migrate')),
    kv: { get: vi.fn(pure('kv.get')), set: vi.fn(pure('kv.set')) },
  };
});

vi.mock(import('../../server/src/pdf.js'), () => ({ pdfToLayoutText: vi.fn() }));

vi.mock(import('../../server/src/appliances/screenlogic.js'), () => ({
  configured: () => false,
  readPool: vi.fn(async () => { throw new Error('readPool in pure test'); }),
  writePoolPlan: vi.fn(async () => { throw new Error('writePoolPlan in pure test'); }),
  withUnit: vi.fn(async () => { throw new Error('withUnit in pure test'); }),
}));

vi.mock(import('../../server/src/appliances/nest.js'), async importOriginal => {
  const real = await importOriginal();
  const blocked = (what: string) => vi.fn(async () => { throw new Error(`${what} in pure test`); });
  return {
    ...real,
    nestConfigured: () => false, nestLinked: vi.fn(async () => false),
    readNest: blocked('readNest'), nestExchangeCode: blocked('nestExchangeCode'),
    setCool: blocked('setCool'), setHeat: blocked('setHeat'), setMode: blocked('setMode'), setEco: blocked('setEco'),
  };
});
