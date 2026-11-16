<script lang="ts">
  import '@xterm/xterm/css/xterm.css';
  import { onMount } from 'svelte';
  import {
    createTerminalClient,
    type TerminalClient,
    type TerminalConnectionStatus,
  } from '#lib/terminal-client.js';

  interface Props {
    url: string;
    onStatus?: (status: TerminalConnectionStatus, reason?: string) => void;
  }

  let { url, onStatus }: Props = $props();
  let container = $state<HTMLDivElement | null>(null);
  let client: TerminalClient | null = null;

  onMount(() => {
    let disposed = false;
    let terminal: import('@xterm/xterm').Terminal | null = null;
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
    };
  });
</script>

<div class="h-96 overflow-hidden rounded-md bg-neutral-950 p-2" bind:this={container}></div>
