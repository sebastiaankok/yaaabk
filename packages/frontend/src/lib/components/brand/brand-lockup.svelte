<script lang="ts">
  import BrandMark from './brand-mark.svelte';

  let { compact = false }: { compact?: boolean } = $props();
</script>

<div data-testid="brand-lockup" class="flex items-center gap-3" class:justify-center={!compact}>
  <BrandMark class="size-10 shrink-0" />
  <div class="min-w-0">
    <p class="text-xl leading-tight font-medium tracking-tight">YAAABK</p>
    {#if !compact}
      <p class="text-xs leading-tight text-muted-foreground">Developer Platform</p>
    {/if}
  </div>
</div>
