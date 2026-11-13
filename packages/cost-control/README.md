# @yaaabk/cost-control

The Cost Control Module: one budgeted OpenRouter sub-key per Issue, so an
autonomous agent cannot spend more than its cap. The module owns the whole
lifecycle — provision, watch, top up, delete — and no other module talks to
OpenRouter's Management API directly.

## Usage

```ts
import {
  createCostControlModule,
  createInMemoryBudgetStore,
  createOpenRouterApi,
  loadCostControlConfig,
} from '@yaaabk/cost-control';

const config = loadCostControlConfig();
const cost = createCostControlModule({
  api: createOpenRouterApi({ managementKey: config.managementKey ?? '' }),
  store: createInMemoryBudgetStore(),
  defaultBudgetCents: config.defaultBudgetCents,
});

const issued = await cost.open('a1b2c3d4-...');       // $0.50 default cap
if (!issued.ok) {
  // issued.error.kind is 'budget-out-of-range' | 'unauthorized' | 'network' | ...
}
await cost.topUp('a1b2c3d4-...', 200);                // raise the cap to $2.00
const status = await cost.status('a1b2c3d4-...');     // remaining budget + `exhausted`
await cost.release('a1b2c3d4-...');                   // issue closed: delete the key
```

Every command resolves to a `CostControlResult` — `{ ok: true, value }` or
`{ ok: false, error }` — so callers branch on `ok` instead of catching
exceptions. Nothing throws across the module boundary.

- `open` creates the key (`POST /api/v1/keys`) with a lifetime cap and a 30-day
  expiry, and returns the plaintext key exactly once. Give it to the agent; the
  module never persists it.
- `topUp` patches the cap (`PATCH /api/v1/keys/{hash}`), capped at
  `MAX_ISSUE_BUDGET_CENTS` ($5.00).
- `status` reads usage (`GET /api/v1/keys/{hash}`) and sets `exhausted` when
  nothing is left, the key is disabled, or it has expired. Pause the agent — do
  not kill it, so a top-up resumes the attempt.
- `release` deletes the key (`DELETE /api/v1/keys/{hash}`) and forgets the
  budget. Idempotent, and tolerant of a key that OpenRouter has already removed.

Budgets are whole cents everywhere and match the `budget_cents` column on an
Issue; the USD conversion happens only at the API boundary.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENROUTER_MANAGEMENT_KEY` | _unset_ | Management key used to provision sub-keys |
| `YAAABK_DEFAULT_ISSUE_BUDGET_CENTS` | `50` | Default per-issue cap in cents, clamped to $5.00 |

### Persistence

`open` records `{ keyHash, budgetCents, expiresAt }` through the `BudgetStore`
port. `createInMemoryBudgetStore` is enough for tests and a single process; the
Issues Module implements the port against its own table when Issues are
persisted, so each Issue carries its `openrouter_key_hash` and `budget_cents`.

### Testing

Inject `createFakeOpenRouterApi()` to drive the module without touching the
network; it supports simulated spend (`setUsage`), operator actions
(`setDisabled`) and queued failures (`fail`).

```sh
bun run test:unit          # fast, in-memory; no network required
bun run test:integration   # provisions a real key, then deletes it
```

The integration suite is skipped unless `YAAABK_OPENROUTER_INTEGRATION=1` (set
by `test:integration`) and `OPENROUTER_MANAGEMENT_KEY` is present. It spends no
credits: the key is never used for a completion.
