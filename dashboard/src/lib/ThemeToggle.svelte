<script lang="ts">
  import { onMount } from 'svelte';
  import markup from '../../static/asafarim-theme/toggle.html?raw';
  onMount(() => {
    (window as unknown as { asafarimTheme?: { sync: () => void } }).asafarimTheme?.sync();
  });
</script>

<span class="theme-control">{@html markup}</span>
