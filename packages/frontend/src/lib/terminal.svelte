<script lang="ts">
  import '@xterm/xterm/css/xterm.css';
  import { onMount } from 'svelte';
  import Maximize2 from '@lucide/svelte/icons/maximize-2';
  import Minimize2 from '@lucide/svelte/icons/minimize-2';
  import {
    createTerminalClient,
    terminalStatusLabel,
    terminalStatusTone,
    type TerminalClient,
    type TerminalConnectionStatus,
    type TerminalStatusTone,
  } from '#lib/terminal-client.js';

  interface Props {
    url: string;
    /** The latest connection status, mirrored by the fullscreen overlay. */
    status?: TerminalConnectionStatus;
    onStatus?: (status: TerminalConnectionStatus, reason?: string) => void;
  }

  const DOT_CLASS: Record<TerminalStatusTone, string> = {
    emerald: 'bg-emerald-400',
    amber: 'bg-amber-400',
    neutral: 'bg-neutral-500',
  };

  let { url, status = 'connecting', onStatus }: Props = $props();
  let container = $state<HTMLDivElement | null>(null);
  let fullscreen = $state(false);
  let client: TerminalClient | null = null;
  let terminal: import('@xterm/xterm').Terminal | null = null;

  const statusLabel = $derived(terminalStatusLabel(status));
  const statusDotClass = $derived(DOT_CLASS[terminalStatusTone(status)]);

  /** Focus the terminal after the overlay renders so the next keystroke reaches it. */
  $effect(() => {
    if (fullscreen) terminal?.focus();
  });

  /** A session that has ended has no terminal to fill the viewport, so collapse it. */
  $effect(() => {
    if (status === 'closed') fullscreen = false;
  });

  onMount(() => {
    let disposed = false;
    let observer: ResizeObserver | null = null;
    let frame: number | null = null;

    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      if (disposed || container === null) return;

      terminal = new Terminal({
        cursorBlink: true,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 13,
        scrollback: 5_000,
        theme: {
          background: '#0a0a0a',
          foreground: '#e5e5e5',
          cursor: '#e5e5e5',
        },
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(container);

      const currentTerminal = terminal;
      client = createTerminalClient({
        url,
        sink: {
          write: (data) => currentTerminal.write(data),
          onInput(handler) {
            const subscription = currentTerminal.onData(handler);
            return () => subscription.dispose();
          },
          onResize(handler) {
            const subscription = currentTerminal.onResize(({ cols, rows }) =>
              handler({ columns: cols, rows }),
            );
            return () => subscription.dispose();
          },
        },
        ...(onStatus === undefined ? {} : { onStatus }),
      });
      client.connect();
      fit.fit();
      client.resize({ columns: currentTerminal.cols, rows: currentTerminal.rows });

      observer = new ResizeObserver(() => {
        if (frame !== null) cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          frame = null;
          fit.fit();
        });
      });
      observer.observe(container);
    })();

    return () => {
      disposed = true;
      if (frame !== null) cancelAnimationFrame(frame);
      observer?.disconnect();
      client?.dispose();
      client = null;
      terminal?.dispose();
      terminal = null;
    };
  });
</script>

<div
  class={fullscreen ? 'fixed inset-0 z-50 flex flex-col bg-neutral-950 p-2' : 'relative'}
  role={fullscreen ? 'region' : undefined}
  aria-label={fullscreen ? 'Fullscreen terminal' : undefined}
>
  {#if fullscreen}
    <div class="mb-2 flex items-center justify-end gap-2 text-neutral-200">
      <span class="h-2 w-2 rounded-full {statusDotClass}" role="status" aria-label={statusLabel}
      ></span>
      <button
        type="button"
        onclick={() => (fullscreen = false)}
        aria-label="Minimize terminal"
        class="rounded-md border border-neutral-700 bg-neutral-900/80 p-1.5 text-neutral-200 hover:bg-neutral-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-400"
      >
        <Minimize2 size={16} aria-hidden="true" />
      </button>
    </div>
  {:else}
    <button
      type="button"
      onclick={() => (fullscreen = true)}
      aria-label="Expand terminal"
      class="absolute right-2 top-2 z-10 rounded-md border border-neutral-700 bg-neutral-900/80 p-1.5 text-neutral-200 hover:bg-neutral-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-400"
    >
      <Maximize2 size={16} aria-hidden="true" />
    </button>
  {/if}
  <div
    class={fullscreen
      ? 'min-h-0 flex-1 overflow-hidden rounded-md bg-neutral-950 p-2'
      : 'h-96 overflow-hidden rounded-md bg-neutral-950 p-2'}
    bind:this={container}
  ></div>
</div>
