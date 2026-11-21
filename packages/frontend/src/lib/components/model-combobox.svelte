<script lang="ts">
  import type { SessionModel } from '#lib/api.js';
  import { filterModels } from '#lib/model-picker.js';
  import { cn } from '#lib/utils.js';

  interface Props {
    id: string;
    /** The selected model id, or whatever the Developer is typing. */
    value: string;
    options: readonly SessionModel[];
    placeholder?: string;
    disabled?: boolean;
    class?: string;
    'aria-describedby'?: string;
  }

  let {
    id,
    value = $bindable(''),
    options,
    placeholder,
    disabled = false,
    class: className,
    'aria-describedby': describedBy,
  }: Props = $props();

  let open = $state(false);
  const filtered = $derived(filterModels(options, value));

  // Track the highlighted row by model id, not index: filtering while open
  // rewrites the list and an index would point at a different model.
  let activeId = $state<string | null>(null);
  let input = $state<HTMLInputElement | null>(null);
  let root = $state<HTMLDivElement | null>(null);

  const listId = $derived(`${id}-options`);
  const activeIndex = $derived(filtered.findIndex((model) => model.id === activeId));
  const activeOptionId = $derived(
    open && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined,
  );

  function optionId(index: number): string {
    return `${id}-option-${index}`;
  }

  function show(): void {
    if (disabled) return;
    open = true;
    activeId = filtered.some((model) => model.id === value) ? value : (filtered[0]?.id ?? null);
  }

  function choose(model: SessionModel): void {
    value = model.id;
    open = false;
    activeId = model.id;
    input?.focus();
  }

  function handleInput(): void {
    open = true;
    activeId = filtered[0]?.id ?? null;
  }

  function move(direction: 1 | -1): void {
    if (!open) {
      show();
      return;
    }
    if (filtered.length === 0) return;
    const current = filtered.findIndex((model) => model.id === activeId);
    const next = current === -1 ? 0 : (current + direction + filtered.length) % filtered.length;
    activeId = filtered[next]?.id ?? null;
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Enter') {
      if (!open) return;
      const model = filtered.find((entry) => entry.id === activeId);
      if (model === undefined) {
        open = false;
        return;
      }
      event.preventDefault();
      choose(model);
    } else if (event.key === 'Escape') {
      if (!open) return;
      event.preventDefault();
      open = false;
      input?.focus();
    } else if (event.key === 'Tab') {
      open = false;
    }
  }

  // A click anywhere else dismisses the list without stealing focus.
  $effect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent): void {
      if (root !== null && event.target instanceof Node && !root.contains(event.target)) {
        open = false;
      }
    }
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  });
</script>

<div class="relative min-w-0" bind:this={root}>
  <input
    bind:this={input}
    {id}
    bind:value
    {disabled}
    {placeholder}
    role="combobox"
    aria-autocomplete="list"
    aria-expanded={open}
    aria-controls={open ? listId : undefined}
    aria-activedescendant={activeOptionId}
    aria-describedby={describedBy}
    autocomplete="off"
    spellcheck="false"
    onfocus={show}
    oninput={handleInput}
    onkeydown={handleKeydown}
    class={cn(
      'border-input focus-visible:border-ring focus-visible:ring-ring/50 disabled:bg-input/50 h-11 w-full min-w-0 rounded-lg border bg-transparent px-3 py-1 text-base transition-colors outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
      className,
    )}
  />
  {#if open && filtered.length > 0}
    <ul
      id={listId}
      role="listbox"
      aria-label="Models"
      class="bg-popover shadow-elevation-overlay absolute top-full left-0 z-30 mt-1 max-h-72 w-full overflow-x-hidden overflow-y-auto rounded-lg border border-border-subtle py-1"
    >
      {#each filtered as model, index (model.id)}
        <li
          id={optionId(index)}
          role="option"
          aria-selected={model.id === value}
          class="hover:bg-muted flex min-w-0 cursor-pointer flex-col gap-0.5 px-3 py-2 text-sm {model.id ===
          activeId
            ? 'bg-secondary'
            : ''}"
          onpointerdown={(event) => {
            event.preventDefault();
            choose(model);
          }}
          onpointermove={() => (activeId = model.id)}
        >
          <span class="truncate font-medium text-foreground">{model.name}</span>
          <span class="text-muted-foreground truncate font-mono text-xs">{model.id}</span>
        </li>
      {/each}
    </ul>
  {:else if open && options.length > 0}
    <p
      class="bg-popover text-muted-foreground absolute top-full left-0 z-30 mt-1 w-full rounded-lg border border-border-subtle px-3 py-2 text-sm"
      role="status"
    >
      No model matches “{value.trim()}”.
    </p>
  {/if}
</div>
