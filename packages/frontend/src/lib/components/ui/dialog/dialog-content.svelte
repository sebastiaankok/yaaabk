<script lang="ts">
  import { Dialog as DialogPrimitive } from 'bits-ui';
  import X from '@lucide/svelte/icons/x';
  import { cn } from '#lib/utils.js';
  import type { Snippet } from 'svelte';

  let {
    ref = $bindable(null),
    class: className,
    children,
    ...restProps
  }: DialogPrimitive.ContentProps & { class?: string; children?: Snippet } = $props();
</script>

<DialogPrimitive.Portal>
  <DialogPrimitive.Overlay
    data-slot="dialog-overlay"
    class="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 fixed inset-0 z-50 bg-black/40"
  />
  <DialogPrimitive.Content
    bind:ref
    data-slot="dialog-content"
    class={cn(
      'bg-background border-border-subtle shadow-elevation-overlay data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95 fixed top-1/2 left-1/2 z-50 grid w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl border p-6 outline-none',
      'max-sm:inset-0 max-sm:top-0 max-sm:left-0 max-sm:w-full max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none max-sm:overflow-y-auto',
      className,
    )}
    {...restProps}
  >
    {@render children?.()}
    <DialogPrimitive.Close
      aria-label="Close"
      class="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring/50 absolute top-4 right-4 flex size-8 items-center justify-center rounded-full transition-colors focus-visible:ring-3 focus-visible:outline-none"
    >
      <X class="size-4" />
    </DialogPrimitive.Close>
  </DialogPrimitive.Content>
</DialogPrimitive.Portal>
