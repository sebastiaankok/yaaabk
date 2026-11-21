<script lang="ts">
  let { children } = $props();
</script>

<div class="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-6">
  {@render children()}
</div>
