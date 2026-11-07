<script lang="ts">
  import { tick } from 'svelte';
  import type { AISummaryState } from './client.ts';
  let {
    summaryState,
    error,
    generating,
    disabled,
    onGenerate
  }: {
    summaryState: AISummaryState | null;
    error: string;
    generating: boolean;
    disabled: boolean;
    onGenerate: () => void;
  } = $props();
  const summary = $derived(summaryState?.summary);
  let evidenceOpen = $state(false);
  async function reveal(event: MouseEvent, id: string) {
    event.preventDefault();
    evidenceOpen = true;
    await tick();
    const target = document.getElementById(`evidence-${id}`);
    target?.scrollIntoView({ block: 'center' });
    target?.focus({ preventScroll: true });
  }
  function date(value: string) {
    return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }
</script>

<section class="panel ai-panel" aria-labelledby="ai-heading">
  <div class="panel-heading">
    <div>
      <span class="eyebrow">A LITTLE MORE PERSPECTIVE</span>
      <h2 id="ai-heading">AI workspace summary</h2>
    </div>
    <button
      class="refresh"
      onclick={onGenerate}
      disabled={disabled || generating || !summaryState?.configured}
    >
      {generating ? 'Generating…' : summary ? 'Generate new summary' : 'Generate summary'}
    </button>
  </div>
  <p class="ai-disclosure">
    Generate on demand with OpenAI. Sends repository names, aggregate metrics and snapshot
    filenames; source content and local absolute paths are excluded. API usage charges may apply.
  </p>
  {#if error}<p class="inline-error" role="alert">{error}</p>{/if}
  {#if summaryState && !summaryState.configured}
    <p class="ai-setup">
      Set <code>OPENAI_API_KEY</code> in the API server environment, then restart it and refresh this
      view. Keep the key out of browser code and Git.
    </p>
  {/if}
  <div class="sr-only" role="status" aria-live="polite">
    {generating
      ? 'Generating OpenAI summary'
      : summary
        ? 'AI summary available'
        : 'No AI summary generated'}
  </div>
  {#if summary}
    <div class="ai-content">
      <h3>{summary.headline}</h3>
      <p class="ai-meta">
        {summary.model} · Generated {date(summary.generated_at)} · Based on {summary.snapshot_count} saved
        snapshots through {date(summary.period_end)}
      </p>
      <ul class="ai-findings">
        {#each summary.findings as finding}<li>
            <p>{finding.text}</p>
            <span class="evidence-links"
              >{#each finding.evidence_ids as id}<a
                  href={`#evidence-${id}`}
                  onclick={(event) => reveal(event, id)}
                  >{id} · {summary.evidence.find((item) => item.id === id)?.name ?? id}</a
                >{/each}</span
            >
          </li>{/each}
      </ul>
      <details bind:open={evidenceOpen}>
        <summary>Inspect the metrics behind this summary</summary>
        <div class="ai-evidence">
          {#each summary.evidence as item}<div id={`evidence-${item.id}`} tabindex="-1">
              <strong>{item.id} · {item.name}</strong>
              <p>
                {item.observations} observations · {item.failed_observations} failed · {item.observed_branch_switches}
                observed branch switches · {item.observed_count_changes} file-count changes · Latest changed
                files: {item.latest_changed_files ?? 'unknown'}
              </p>
            </div>{/each}
        </div>
        <p>Source snapshots:</p>
        <ul>
          {#each summary.sources as source}<li><code>{source}</code></li>{/each}
        </ul>
      </details>
      <p class="ai-meta">
        AI-generated interpretation of saved observations. Review the evidence; these metrics do not
        measure commits, productivity or code quality. The latest successful summary is saved with
        this workspace’s history and survives API restarts.
      </p>
    </div>
  {:else}<p class="ai-empty">
      {generating
        ? 'Reading the saved observations and preparing a summary…'
        : 'No summary generated yet. Refreshing the dashboard never calls a model.'}
    </p>{/if}
</section>

<style>
  .ai-panel {
    margin-bottom: 24px;
    padding-bottom: 22px;
    border-color: #415247;
  }
  .ai-disclosure,
  .ai-setup,
  .ai-empty {
    margin: 16px 23px 0;
    color: var(--muted);
    font-size: 11px;
    line-height: 1.8;
  }
  .ai-setup code {
    color: var(--amber);
  }
  .ai-content {
    margin: 22px 23px 0;
  }
  h3 {
    font-size: 18px;
    font-weight: 500;
    margin: 0 0 10px;
  }
  .ai-meta {
    font-size: 10px;
    color: var(--muted);
    margin: 10px 0 0;
  }
  .ai-findings {
    padding-left: 20px;
    margin: 20px 0;
  }
  .ai-findings li {
    padding-left: 4px;
    margin: 16px 0;
    font-size: 13px;
  }
  .evidence-links {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 9px;
  }
  .evidence-links a {
    border: 1px solid #3d5249;
    color: var(--mint);
    border-radius: 4px;
    padding: 3px 7px;
    font-size: 10px;
  }
  details {
    margin: 0;
  }
  .ai-evidence {
    display: grid;
    gap: 15px;
    margin-top: 15px;
  }
  .ai-evidence div {
    scroll-margin-top: 20px;
    border-left: 2px solid #3d5249;
    padding-left: 12px;
  }
  .ai-evidence strong {
    font-size: 11px;
    color: var(--mint);
  }
  .ai-evidence p {
    font-size: 10px;
    margin-top: 6px;
  }
  @media (max-width: 620px) {
    .panel-heading {
      align-items: flex-start;
      flex-wrap: wrap;
    }
    .ai-content {
      margin-inline: 17px;
    }
    .ai-disclosure,
    .ai-setup,
    .ai-empty {
      margin-inline: 17px;
    }
  }
</style>
