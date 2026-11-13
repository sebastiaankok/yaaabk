# @yaaabk/frontend

SvelteKit + Tailwind CSS + shadcn-svelte browser UI for YAAABK.

See the [repository README](../../README.md) for setup, scripts, and testing.

## Scaffold provenance

This package was generated with the Svelte CLI:

```sh
npx sv@1.3.0 create --template minimal --types ts \
  --add tailwindcss="plugins:none" vitest="usages:unit" \
  playwright="demo:no" sveltekit-adapter="adapter:bun" \
  --no-install packages/frontend
```

Then shadcn-svelte was initialised (preset `nova`, base colour `neutral`):

```sh
bunx shadcn-svelte@latest init --preset nova --base-color neutral \
  --css src/routes/layout.css --lib-alias '$lib' \
  --components-alias '$lib/components' --utils-alias '$lib/utils' \
  --hooks-alias '$lib/hooks' --ui-alias '$lib/components/ui'
```

Add components with `bunx shadcn-svelte@latest add <component>`.

Two adaptations to the Svelte CLI output:

- The SvelteKit build runs through Bun (`bun --bun vite build`) because
  `@sveltejs/adapter-bun` is the target adapter.
- `$lib` path aliases are declared explicitly in `tsconfig.json`; the shadcn-svelte
  CLI needs to resolve them and SvelteKit otherwise provides them virtually via
  `$app/tsconfig`.
