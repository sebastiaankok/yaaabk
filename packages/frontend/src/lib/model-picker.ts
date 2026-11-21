import type { SessionModel } from './api.js';

/**
 * Narrows the model catalogue to what the Developer typed.
 *
 * Both the display name and the full OpenCode id are searchable, so
 * "claude", "anthropic" and "sonnet" all find the same model. Catalogue order
 * is kept: the backend already sorts by what it considers most useful.
 */
export function filterModels(models: readonly SessionModel[], query: string): SessionModel[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...models];
  return models.filter(
    (model) => model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle),
  );
}
