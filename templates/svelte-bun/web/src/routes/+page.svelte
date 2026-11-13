<script lang="ts">
  import { onMount } from 'svelte';

  let greeting = $state('Waiting for the API…');

  onMount(async () => {
    const response = await fetch('/api/hello');
    const body = (await response.json()) as { message: string };
    greeting = body.message;
  });
</script>

<main class="flex min-h-dvh flex-col items-center justify-center gap-4 p-8 text-center">
  <h1 class="text-4xl font-bold tracking-tight sm:text-5xl">{{projectName}}</h1>
  <p class="max-w-prose text-lg text-neutral-500">{greeting}</p>
</main>
