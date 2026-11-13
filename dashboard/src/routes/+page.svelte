<script lang="ts">
  import { onMount } from 'svelte';
  import ThemeToggle from '#lib/ThemeToggle.svelte';
  import SummaryPanel from '#lib/SummaryPanel.svelte';
  import {
    APIError,
    filterRepositories,
    groupWorktrees,
    snapshotAttention,
    readJSON,
    generateSummary,
    workspaceURL,
    type WorkspaceID,
    type AISummaryState,
    statusOf,
    type Analysis,
    type Snapshot
  } from '#lib/client.ts';

  let snapshot = $state<Snapshot | null>(null);
  let analysis = $state<Analysis | null>(null);
  let health = $state<{ status: string; version: string } | null>(null);
  let loading = $state(false);
  let snapshotError = $state('');
  let analysisError = $state('');
  let missingHistory = $state(false);
  let search = $state('');
  let filter = $state('all');
  let expanded = $state<string | null>(null);
  let refreshed = $state<Date | null>(null);
  let controller: AbortController | undefined;
  let summaryController: AbortController | undefined;
  let aiState = $state<AISummaryState | null>(null);
  let aiError = $state('');
  let generating = $state(false);
  let authenticatedHosting = $state(false);
  let activeSection = $state('overview');
  let workspace = $state<WorkspaceID>('local');
  let workspaces = $state<{ id: WorkspaceID; label: string }[]>([
    { id: 'local', label: 'Local workspace' }
  ]);
  let contextLoaded = false;
  const workspaceLabel = $derived(
    workspaces.find((item) => item.id === workspace)?.label ?? 'Local workspace'
  );
  const sectionNames: Record<string, string> = {
    overview: 'Overview',
    repositories: 'Repositories',
    history: 'Saved history'
  };
  let accessRole = $state('viewer');
  let canReview = $state(false);
  let onboarded = $state(true);
  let csrf = $state('');
  const canManage = $derived(!authenticatedHosting || accessRole === 'admin');
  async function checkSession() {
    try {
      const response = await fetch('/auth/context', { cache: 'no-store' });
      if (response.ok) {
        const context = await response.json();
        authenticatedHosting = true;
        accessRole = context.role;
        canReview = context.canReview;
        onboarded = context.onboarded;
        csrf = context.csrf;
        if (context.workspaces?.length) workspaces = context.workspaces;
        if (!contextLoaded) {
          const selected = new URL(location.href).searchParams.get('workspace');
          if (workspaces.some((item) => item.id === selected)) workspace = selected as WorkspaceID;
          contextLoaded = true;
        }
      } else if (authenticatedHosting && [401, 403].includes(response.status))
        location.assign('/login');
      else if (authenticatedHosting && response.status >= 500) {
        snapshot = null;
        analysis = null;
        aiState = null;
        snapshotError =
          'Your session could not be verified. Refresh after the identity service recovers.';
      }
    } catch {
      if (authenticatedHosting) {
        snapshot = null;
        analysis = null;
        aiState = null;
      }
    }
  }

  const repositories = $derived(snapshot?.repositories ?? []);
  const changed = $derived(
    repositories.filter((repo) => !repo.error && repo.changed_files > 0).length
  );
  const unavailable = $derived(repositories.filter((repo) => repo.error).length);
  const clean = $derived(repositories.length - changed - unavailable);
  const visible = $derived(filterRepositories(repositories, search, filter));
  const groups = $derived(groupWorktrees(visible));
  const attention = $derived(
    snapshotAttention(
      snapshot,
      refreshed?.getTime() ?? Date.now(),
      workspace === 'vps' ? 30 * 60_000 : 24 * 60 * 60_000
    )
  );
  const summaries = $derived(
    new Map(analysis?.repositories.map((repo) => [repo.name, repo]) ?? [])
  );
  const signals = $derived(
    (analysis?.repositories ?? [])
      .filter((repo) => repo.observed_count_changes > 0)
      .toSorted((a, b) => b.observed_count_changes - a.observed_count_changes)
  );
  const maxSignal = $derived(Math.max(1, ...signals.map((repo) => repo.observed_count_changes)));
  const ring = $derived(
    repositories.length
      ? `conic-gradient(var(--mint) 0 ${(clean / repositories.length) * 100}%, var(--amber) 0 ${((clean + changed) / repositories.length) * 100}%, var(--rose) 0)`
      : 'var(--border)'
  );

  function date(value: string | null | undefined): string {
    return value
      ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
      : 'Not available';
  }

  function message(reason: unknown): string {
    return reason instanceof APIError
      ? reason.message
      : 'Cannot reach the local API. Start observatory-api, then refresh.';
  }

  async function refresh(force = false) {
    if (!force && (loading || generating)) return;
    loading = true;
    const currentController = new AbortController();
    controller = currentController;
    const requestedWorkspace = workspace;
    const timer = setTimeout(() => currentController.abort(), 20_000);
    try {
      const [h, s, a, ai] = await Promise.allSettled([
        readJSON<{ status: string; version: string }>('/healthz', controller.signal),
        readJSON<Snapshot>(workspaceURL('/api/snapshot', workspace), controller.signal),
        readJSON<Analysis>(workspaceURL('/api/analysis', workspace), controller.signal),
        readJSON<AISummaryState>(workspaceURL('/api/summary', workspace), controller.signal)
      ]);
      if (controller !== currentController || workspace !== requestedWorkspace) return;
      health = h.status === 'fulfilled' ? h.value : null;
      snapshotError = s.status === 'rejected' ? message(s.reason) : '';
      analysisError = a.status === 'rejected' ? message(a.reason) : '';
      missingHistory =
        s.status === 'rejected' && s.reason instanceof APIError && s.reason.status === 404;
      if (s.status === 'fulfilled') snapshot = s.value;
      if (a.status === 'fulfilled') analysis = a.value;
      if (ai.status === 'fulfilled') {
        aiState = ai.value;
        aiError = '';
      } else {
        aiError =
          ai.reason instanceof APIError && ai.reason.status === 404
            ? 'Restart the updated API server to enable AI summaries.'
            : message(ai.reason);
      }
      refreshed = new Date();
    } finally {
      clearTimeout(timer);
      if (controller === currentController) loading = false;
    }
  }

  async function generate() {
    if (!canManage || generating || loading) return;
    generating = true;
    aiError = '';
    const requestedWorkspace = workspace;
    summaryController = new AbortController();
    const timer = setTimeout(() => summaryController?.abort(), 70_000);
    try {
      const result = await generateSummary(
        summaryController.signal,
        fetch,
        csrf,
        requestedWorkspace
      );
      if (workspace === requestedWorkspace) aiState = result;
    } catch (error) {
      if (workspace !== requestedWorkspace) return;
      aiError =
        error instanceof APIError
          ? error.message
          : 'Summary generation did not complete. Check the API connection; the previous summary is preserved.';
    } finally {
      clearTimeout(timer);
      generating = false;
    }
  }

  async function selectWorkspace() {
    controller?.abort();
    summaryController?.abort();
    snapshot = null;
    analysis = null;
    aiState = null;
    aiError = '';
    snapshotError = '';
    analysisError = '';
    const url = new URL(location.href);
    url.searchParams.set('workspace', workspace);
    history.replaceState(null, '', url);
    await refresh(true);
  }

  async function refreshAction() {
    if (!canManage) return;
    if (authenticatedHosting) {
      const result = await fetch(workspaceURL('/api/refresh', workspace), {
        method: 'POST',
        headers: { 'X-CSRF-Token': csrf }
      });
      if (!result.ok) {
        snapshotError = 'Admin access is required or your session needs refreshing.';
        await checkSession();
        return;
      }
    }
    await refresh();
  }

  onMount(() => {
    void (async () => {
      await checkSession();
      await refresh();
    })();
    const fromHash = () => {
      const section = location.hash.slice(1);
      if (Object.hasOwn(sectionNames, section)) activeSection = section;
      const requested = new URL(location.href).searchParams.get('workspace') ?? 'local';
      if (
        contextLoaded &&
        requested !== workspace &&
        workspaces.some((item) => item.id === requested)
      ) {
        workspace = requested as WorkspaceID;
        void selectWorkspace();
      }
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    window.addEventListener('popstate', fromHash);
    let frame = 0;
    const trackScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        let current = 'overview';
        for (const id of ['repositories', 'history']) {
          const element = document.getElementById(id);
          if (element && element.getBoundingClientRect().top <= 180) current = id;
        }
        if (
          window.scrollY > 0 &&
          window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4
        )
          current = 'history';
        activeSection = current;
      });
    };
    window.addEventListener('scroll', trackScroll, { passive: true });
    const poll = setInterval(() => void checkSession(), 60_000);
    const foreground = () => {
      if (document.visibilityState === 'visible') void checkSession();
    };
    document.addEventListener('visibilitychange', foreground);
    return () => {
      clearInterval(poll);
      window.removeEventListener('hashchange', fromHash);
      window.removeEventListener('popstate', fromHash);
      window.removeEventListener('scroll', trackScroll);
      cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', foreground);
      controller?.abort();
      summaryController?.abort();
    };
  });
</script>

<svelte:head>
  <title>ASafariM Observatory — Workspace overview</title>
  <meta
    name="description"
    content="Your saved workspace snapshots, repository status and observed history in one place."
  />
</svelte:head>

<a class="skip" href="#main">Skip to content</a>
<div class="shell">
  <aside class="sidebar">
    <a class="brand" href="#overview" aria-label="Observatory home"
      ><span class="brand-mark" aria-hidden="true">◎</span><span
        >ASafariM<span class="brand-sub">OBSERVATORY</span></span
      ></a
    >
    <div class="workspace-label">WORKSPACE</div>
    <nav aria-label="Dashboard navigation">
      <a
        href="#overview"
        class:active={activeSection === 'overview'}
        aria-current={activeSection === 'overview' ? 'location' : undefined}
        onclick={() => (activeSection = 'overview')}
        ><span aria-hidden="true">◫</span> Overview {#if activeSection === 'overview'}<span
            class="nav-dot"
          ></span>{/if}</a
      >
      <a
        href="#repositories"
        class:active={activeSection === 'repositories'}
        aria-current={activeSection === 'repositories' ? 'location' : undefined}
        onclick={() => (activeSection = 'repositories')}
        ><span aria-hidden="true">⌘</span> Repositories
        <small>{snapshot ? repositories.length : '—'}</small></a
      >
      <a
        href="#history"
        class:active={activeSection === 'history'}
        aria-current={activeSection === 'history' ? 'location' : undefined}
        onclick={() => (activeSection = 'history')}
        ><span aria-hidden="true">◷</span> Saved history</a
      >
      {#if authenticatedHosting}<a href="/account"
          ><span aria-hidden="true">◎</span> Account &amp; sign out</a
        >{/if}
    </nav>
    <div class="sidebar-note">
      <span class="tiny-dot"></span>
      {workspaceLabel}
      <p>
        {workspace === 'vps'
          ? 'Saved observations collected on the VPS.'
          : authenticatedHosting
            ? 'Saved observations uploaded from your laptop.'
            : 'Signals from your code. A little more perspective.'}
      </p>
    </div>
    <div class="sidebar-footer">
      Go <span>↔</span> Python <span>↔</span> Svelte<small>Dashboard v0.4.1</small>
    </div>
  </aside>

  <main id="main">
    <header class="topbar">
      <span
        >Workspace <span class="slash">/</span> <strong>{sectionNames[activeSection]}</strong></span
      ><span class:online={health?.status === 'ok'} class="connection"
        ><span class="tiny-dot"></span>{health
          ? `API v${health.version} connected`
          : loading
            ? 'Connecting to API'
            : 'API unavailable'}</span
      >
      <ThemeToggle />
    </header>
    <div class="content" id="overview">
      {#if workspaces.length > 1}
        <label class="workspace-select"
          >Workspace
          <select
            bind:value={workspace}
            onchange={selectWorkspace}
            disabled={loading || generating}
          >
            {#each workspaces as item}<option value={item.id}>{item.label}</option>{/each}
          </select>
        </label>
      {/if}
      {#if authenticatedHosting}
        <section class="panel access-notice" aria-label="Your workspace access">
          <strong>{accessRole === 'admin' ? 'Admin access' : 'Viewer access'}</strong>
          <p>
            {!onboarded
              ? 'Welcome! You can browse immediately. Choose viewer access or request admin tools.'
              : accessRole === 'viewer'
                ? 'Browse saved observations and summaries. Admin approval unlocks refresh and generation.'
                : 'You can refresh saved data and generate AI summaries.'}
          </p>
          <a href="/access"
            >{canReview
              ? 'Manage access and review requests'
              : !onboarded
                ? 'Choose your role'
                : 'Your role and requests'}</a
          >
        </section>
      {/if}
      <section class="page-heading">
        <div>
          <div class="eyebrow">YOUR DEVELOPMENT LANDSCAPE</div>
          <h1>Workspace overview<span>.</span></h1>
          <p>A clear view of your repositories, one saved snapshot at a time.</p>
        </div>
        <button
          class="refresh"
          onclick={refreshAction}
          disabled={!canManage || loading || generating}
          ><span aria-hidden="true" class:spinning={loading}>↻</span>{loading
            ? 'Refreshing…'
            : 'Reload saved data'}</button
        >
      </section>
      <div class="snapshot-strip">
        <span class="tiny-dot"></span><span
          >{workspace === 'vps'
            ? 'Latest VPS scan'
            : authenticatedHosting
              ? 'Latest uploaded scan'
              : 'Latest saved scan'} <strong>{date(snapshot?.scanned_at)}</strong></span
        ><code title={snapshot?.root}>{snapshot?.root ?? 'Waiting for workspace data'}</code>
      </div>
      <p class="freshness-hint">
        {workspace === 'vps'
          ? 'VPS observations are collected every five minutes. Reload saved data to read the latest scan.'
          : authenticatedHosting
            ? 'New repositories appear after a fresh laptop scan and upload.'
            : 'Reloading reads saved observations. Collect a new scan to include new repositories.'}
      </p>
      <div class="sr-only" role="status" aria-live="polite">
        {loading ? 'Loading workspace data' : `Showing ${visible.length} repositories`}
      </div>

      {#if snapshotError}
        <div class="notice" role="alert">
          <strong
            >{missingHistory
              ? 'Your workspace is waiting for its first snapshot.'
              : 'Workspace data could not be refreshed.'}</strong
          >
          <p>{snapshotError}</p>
          {#if snapshot}<small
              >Showing the previous successful response from {date(snapshot.scanned_at)}.</small
            >{/if}{#if missingHistory}<code>./bin/observatory -root /home/ali/repos -save</code
            >{/if}
        </div>
      {/if}

      <section class="panel access-notice" aria-labelledby="attention-heading">
        <h2 id="attention-heading">Needs attention</h2>
        <p>
          Based on the saved scan from {date(snapshot?.scanned_at)}. Reloading reads saved data; it
          does not scan this machine.
        </p>
        {#if attention.length}
          <ul>
            {#each attention as item}<li>{item}</li>{/each}
          </ul>
          <p>
            {workspace === 'vps'
              ? 'Check the VPS collection schedule and upload service.'
              : 'Run the local collector with -save and upload the resulting snapshot using observatory-upload.'}
          </p>
        {:else}<p>No issues detected in the latest saved scan.</p>{/if}
      </section>

      <section class="stats" aria-label="Latest saved snapshot totals">
        <div class="stat">
          <span>Repositories</span><strong>{snapshot ? repositories.length : '—'}</strong><small
            >Checkouts in your workspace</small
          ><span class="stat-icon" aria-hidden="true">⌘</span>
        </div>
        <div class="stat">
          <span>Uncommitted</span><strong class="amber">{snapshot ? changed : '—'}</strong><small
            >Repositories with changed files</small
          ><span class="stat-icon amber" aria-hidden="true">◐</span>
        </div>
        <div class="stat">
          <span>Unavailable</span><strong>{snapshot ? unavailable : '—'}</strong><small
            >Repositories with scan errors</small
          ><span class="stat-icon" aria-hidden="true">⊘</span>
        </div>
        <div class="stat">
          <span>Saved snapshots</span><strong>{analysis ? analysis.snapshot_count : '—'}</strong
          ><small>Observations across time</small><span class="stat-icon" aria-hidden="true">◷</span
          >
        </div>
      </section>

      <div class="insights-grid">
        <section class="panel signals">
          <div class="panel-heading">
            <div>
              <span class="eyebrow">OBSERVED HISTORY</span>
              <h2>Where things are moving</h2>
            </div>
            <span class="label">File-count changes</span>
          </div>
          {#if analysisError}<p class="inline-error" role="alert">
              {analysisError}{analysis ? ' Showing the previous analysis response.' : ''}
            </p>{/if}
          {#if signals.length}
            <div class="signal-bars">
              {#each signals.slice(0, 5) as repo}<div class="signal-row">
                  <span title={repo.name}>{repo.name}</span>
                  <div class="track">
                    <div
                      class="bar"
                      style:width={`${(repo.observed_count_changes / maxSignal) * 100}%`}
                    ></div>
                  </div>
                  <strong>{repo.observed_count_changes}</strong>
                </div>{/each}
            </div>
          {:else}<div class="quiet-state">
              <span aria-hidden="true">∿</span>
              <p>
                {analysis
                  ? 'No file-count changes observed yet.'
                  : loading
                    ? 'Reading your saved history…'
                    : 'History analysis is not available.'}
              </p>
              <small
                >{analysis
                  ? 'Save more snapshots as you work to see changes here.'
                  : 'Analysis will appear when the API can read your snapshots.'}</small
              >
            </div>{/if}
          <p class="panel-footnote">
            Changes between saved observations. Equal file counts can still contain different edits.
          </p>
        </section>
        <section class="panel distribution">
          <div class="panel-heading">
            <div>
              <span class="eyebrow">LATEST SAVED SNAPSHOT</span>
              <h2>Workspace balance</h2>
            </div>
          </div>
          <div class="balance">
            <div
              class="ring"
              style:background={ring}
              role="img"
              aria-label={`${clean} clean, ${changed} uncommitted, ${unavailable} unavailable repositories`}
            >
              <div>
                <strong>{snapshot ? repositories.length : '—'}</strong><small>repositories</small>
              </div>
            </div>
            <div class="legend">
              <span><i class="mint-bg"></i>Clean<strong>{snapshot ? clean : '—'}</strong></span
              ><span
                ><i class="amber-bg"></i>Uncommitted<strong>{snapshot ? changed : '—'}</strong
                ></span
              ><span
                ><i class="rose-bg"></i>Unavailable<strong>{snapshot ? unavailable : '—'}</strong
                ></span
              >
            </div>
          </div>
        </section>
      </div>

      <SummaryPanel
        summaryState={aiState}
        error={aiError}
        {generating}
        disabled={!canManage || loading || !snapshot}
        onGenerate={generate}
      />

      <section class="panel repository-panel" id="repositories">
        <div class="panel-heading">
          <div>
            <span class="eyebrow">YOUR CHECKOUTS</span>
            <h2>Repositories <span class="count">{snapshot ? repositories.length : '—'}</span></h2>
          </div>
          <label class="search"
            ><span aria-hidden="true">⌕</span><input
              type="search"
              bind:value={search}
              placeholder="Search name or branch…"
              aria-label="Search repositories by name or branch"
            /></label
          >
        </div>
        <div class="filters" aria-label="Filter repositories">
          {#each [['all', 'All repositories'], ['changed', 'Uncommitted'], ['clean', 'Clean'], ['unavailable', 'Unavailable']] as [value, label]}<button
              class:active={filter === value}
              aria-pressed={filter === value}
              onclick={() => (filter = value)}>{label}</button
            >{/each}<span>{visible.length} shown</span>
        </div>
        <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users need to focus the horizontal table scroll region.) -->
        <div class="table-wrap" role="region" aria-label="Repository status table" tabindex="0">
          <table>
            <thead
              ><tr
                ><th>REPOSITORY</th><th>BRANCH</th><th>CHANGED FILES</th><th>STATUS</th><th
                  >HISTORY</th
                ></tr
              ></thead
            ><tbody>
              {#each groups as group}
                {#if group.length > 1}<tr
                    ><th colspan="5" scope="rowgroup"
                      >Related worktrees: {group[0].name} and {group.length - 1} more</th
                    ></tr
                  >{/if}
                {#each group as repo}
                  <tr
                    ><td
                      ><button
                        class="repo-button"
                        aria-expanded={expanded === repo.name}
                        onclick={() => (expanded = expanded === repo.name ? null : repo.name)}
                        ><span class="repo-icon" aria-hidden="true">⌘</span><span>{repo.name}</span
                        ><span class="expand-icon" aria-hidden="true"
                          >{expanded === repo.name ? '−' : '+'}</span
                        ></button
                      ></td
                    ><td><span class="branch">{repo.branch || 'Unknown'}</span></td><td
                      ><span class:amber={!repo.error && repo.changed_files > 0} class="file-count"
                        >{repo.error ? '?' : repo.changed_files}</span
                      ></td
                    ><td
                      ><span
                        class="status-pill"
                        class:dirty={!repo.error && repo.changed_files > 0}
                        class:failed={Boolean(repo.error)}
                        ><span class="tiny-dot"></span>{statusOf(repo)}</span
                      ></td
                    ><td class="history-cell"
                      >{#if summaries.has(repo.name)}{summaries.get(repo.name)?.observations} observations{:else}—{/if}</td
                    ></tr
                  >
                  {#if expanded === repo.name}<tr class="detail-row"
                      ><td colspan="5"
                        ><div>
                          <code>{repo.path}</code>{#if repo.error}<p class="inline-error">
                              {repo.error}
                            </p>{/if}{#if summaries.get(repo.name)}{@const summary = summaries.get(
                              repo.name
                            )!}
                            <p>
                              Observed branch switches: <strong
                                >{summary.observed_branch_switches}</strong
                              ><span>·</span> Failed observations:
                              <strong>{summary.failed_observations}</strong><span>·</span> Peak
                              changed files: <strong>{summary.peak_changed_files ?? '?'}</strong>
                            </p>{/if}
                        </div></td
                      ></tr
                    >{/if}
                {/each}
              {/each}
            </tbody>
          </table>
          {#if !visible.length}<div class="empty-table">
              {loading
                ? 'Loading repositories…'
                : !snapshot
                  ? 'Save a snapshot and connect the API to see your repositories.'
                  : repositories.length
                    ? 'No repositories match these filters.'
                    : 'No repositories were found in the saved snapshot.'}
            </div>{/if}
        </div>
      </section>

      <section class="panel history-panel" id="history">
        <div class="panel-heading">
          <div>
            <span class="eyebrow">FOLLOW THE EVIDENCE</span>
            <h2>Saved history</h2>
          </div>
          <span class="label">{analysis?.snapshot_count ?? '—'} snapshots</span>
        </div>
        <p>Analysis covers {date(analysis?.period_start)} through {date(analysis?.period_end)}.</p>
        <details>
          <summary>View source snapshot files</summary>
          <ul>
            {#each analysis?.sources ?? [] as source}<li><code>{source}</code></li>{/each}
          </ul>
          {#if !analysis?.sources.length}<p>No source snapshots available.</p>{/if}
        </details>
      </section>
      <footer>
        <span>ASafariM Observatory <span class="footer-separator">/</span> Dashboard v0.4.1</span
        ><span
          >Saved data · {refreshed
            ? `View refreshed ${refreshed.toLocaleTimeString()}`
            : 'Waiting for API'}<span class="footer-separator">/</span> Refresh reads saved history; it
          does not run a new scan.</span
        >
      </footer>
    </div>
  </main>
</div>
