/** The result of verifying an OpenRouter management key. */
export type OpenRouterVerifyResult =
  | { ok: true; value: { workspaceId?: string; keys: number } }
  | OpenRouterVerifyFailure;

/** Why a verify failed, typed so the UI can explain it inline. */
export interface OpenRouterVerifyFailure {
  ok: false;
  kind: 'unauthorized' | 'network' | 'rate-limited' | 'server';
  message: string;
}
