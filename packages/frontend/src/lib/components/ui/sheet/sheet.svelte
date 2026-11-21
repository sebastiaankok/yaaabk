<script lang="ts">
  import { Dialog as DialogPrimitive } from 'bits-ui';
  import X from '@lucide/svelte/icons/x';
  import type { Snippet } from 'svelte';
  import { tick } from 'svelte';
  import { cn } from '#lib/utils.js';

  let {
    open,
    onOpenChange,
    title,
    description,
    children,
    class: className,
  }: {
    open: boolean;
    onOpenChange?: (open: boolean) => void;
    title: string;
    description?: string;
    children?: Snippet;
    class?: string;
  } = $props();

  /** The card that opened the Sheet, so focus can return to it on close. */
  let returnFocus: HTMLElement | null = null;
  let wasOpen = false;

  // Record the trigger as the Sheet opens and restore it once bits-ui has
  // unmounted the dialog. A deep link has no trigger, so focus is left alone.
  $effect(() => {
    if (open && !wasOpen) {
      const active = document.activeElement;
      returnFocus = active instanceof HTMLElement && active !== document.body ? active : null;
    } else if (!open && wasOpen) {
      const target = returnFocus;
      returnFocus = null;
      void tick().then(() => {
        if (target?.isConnected === true) target.focus();
      });
    }
    wasOpen = open;
  });

  function setOpen(value: boolean): void {
    onOpenChange?.(value);
  }
</script>

<DialogPrimitive.Root {open} onOpenChange={setOpen}>
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay
      class="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 fixed inset-0 z-50 bg-black/40"
    />
    <DialogPrimitive.Content
      class={cn(
        'bg-background border-border-subtle shadow-elevation-overlay data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right fixed inset-y-0 right-0 z-50 flex h-full w-full max-w-lg flex-col overflow-y-auto border-l p-6 outline-none',
        'max-md:max-w-none max-md:border-l-0',
        className,
      )}
      onInteractOutside={() => setOpen(false)}
    >
      <DialogPrimitive.Title class="pr-10 text-lg font-bold tracking-tight">
        {title}
      </DialogPrimitive.Title>
      {#if description !== undefined}
        <DialogPrimitive.Description class="sr-only">
          {description}
        </DialogPrimitive.Description>
      {/if}

      {@render children?.()}

      <DialogPrimitive.Close
        aria-label="Close details"
        class="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring/50 absolute top-4 right-4 flex size-9 items-center justify-center rounded-full transition-colors focus-visible:ring-3 focus-visible:outline-none"
      >
        <X class="size-4" />
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
</DialogPrimitive.Root>
