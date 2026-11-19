<script lang="ts">
  import { renderMarkdown } from '#lib/markdown.js';

  interface Props {
    /** Markdown from a Plan, Issue or agent review. */
    markdown: string;
    /** Extra layout classes for the prose container. */
    class?: string;
  }

  let { markdown, class: className = '' }: Props = $props();

  const html = $derived(renderMarkdown(markdown));
</script>

<div class="prose prose-neutral max-w-none text-sm {className}">
  <!-- eslint-disable-next-line svelte/no-at-html-tags -->
  {@html html}
</div>
