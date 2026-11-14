import { describe, expect, it } from 'vitest';
import { createInMemorySettingsStore } from './in-memory-settings-store';
import { createSecretCrypto } from './secret-crypto';
import { createSettingsModule, type SettingsModule, type SettingsUpdate, type SettingsView } from './settings';

const SECRET = 'a'.repeat(32);

function createModule() {
  return createSettingsModule({
    store: createInMemorySettingsStore(),
    crypto: createSecretCrypto({ secret: SECRET }),
  });
}

/** Applies an update the test expects to succeed. */
async function applyUpdate(settings: SettingsModule, update: SettingsUpdate): Promise<SettingsView> {
  const result = await settings.update(update);
  if (!result.ok) {
    throw new Error(`unexpected failure: ${result.error.kind} — ${result.error.message}`);
  }
  return result.value;
}

describe('SettingsModule', () => {
  it('masks a stored credential in get() and never returns plaintext', async () => {
    const settings = createModule();
    await applyUpdate(settings, { openrouterManagementKey: 'sk-or-v1-abcdefgh1c96' });

    const view = await settings.get();
    expect(view.openrouterManagementKey).toBe('sk-or-…1c96');
    expect(JSON.stringify(view)).not.toContain('sk-or-v1-abcdefgh1c96');
  });

  it('leaves fields untouched when they are absent from an update', async () => {
    const settings = createModule();
    await applyUpdate(settings, { githubPat: 'ghp_originalvalue1234', defaultIssueBudgetCents: 75 });

    await applyUpdate(settings, { openrouterManagementKey: 'sk-or-v1-abcdefgh1c96' });

    const view = await settings.get();
    expect(view.githubPat).toBe('ghp_or…1234');
    expect(view.defaultIssueBudgetCents).toBe(75);
  });

  it('removes a credential listed in clear and keeps the rest', async () => {
    const settings = createModule();
    await applyUpdate(settings, {
      githubPat: 'ghp_originalvalue1234',
      openrouterManagementKey: 'sk-or-v1-abcdefgh1c96',
    });

    const view = await applyUpdate(settings, { clear: ['githubPat'] });

    expect(view.githubPat).toBeUndefined();
    expect(view.openrouterManagementKey).toBe('sk-or-…1c96');
  });

  it('rejects a default issue budget outside 1–500 cents as invalid-input', async () => {
    const settings = createModule();

    const zero = await settings.update({ defaultIssueBudgetCents: 0 });
    const over = await settings.update({ defaultIssueBudgetCents: 501 });
    const fractional = await settings.update({ defaultIssueBudgetCents: 12.5 });

    for (const result of [zero, over, fractional]) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('invalid-input');
      }
    }
  });

  it('resolves stored credentials back to plaintext for internal use', async () => {
    const settings = createModule();
    await applyUpdate(settings, {
      githubPat: 'ghp_originalvalue1234',
      openrouterManagementKey: 'sk-or-v1-abcdefgh1c96',
      defaultIssueBudgetCents: 75,
    });

    const credentials = await settings.credentials();
    expect(credentials.githubPat).toBe('ghp_originalvalue1234');
    expect(credentials.openrouterManagementKey).toBe('sk-or-v1-abcdefgh1c96');
    expect(credentials.defaultIssueBudgetCents).toBe(75);
  });
});
