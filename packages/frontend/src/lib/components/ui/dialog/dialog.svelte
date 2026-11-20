<script lang="ts">
  import { Dialog as DialogPrimitive } from 'bits-ui';

  let { open = $bindable(false), onOpenChange, ...restProps }: DialogPrimitive.RootProps = $props();
</script>

<DialogPrimitive.Root
  {open}
  onOpenChange={(value) => {
    open = value;
    onOpenChange?.(value);
  }}
  {...restProps}
/>
