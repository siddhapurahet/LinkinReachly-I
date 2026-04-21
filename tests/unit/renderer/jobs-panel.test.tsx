/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { useState, type JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JobsProgressState } from '../../../src/core/jobs-progress'
import type { SmartSearchProgress } from '../../../src/renderer/src/components/jobs-smart-search-status'
import { JobsSmartSearchStatusCard } from '../../../src/renderer/src/components/jobs-smart-search-status'
import { JobsPanel } from '../../../src/renderer/src/components/JobsPanel'

function JobsPanelWithCampaignSmartCard(props: Parameters<typeof JobsPanel>[0]): JSX.Element {
  const [activity, setActivity] = useState<{
    smartSearching: boolean
    smartProgress: SmartSearchProgress | null
  } | null>(null)
  return (
    <>
      <JobsPanel {...props} onSmartSearchActivity={setActivity} />
      {activity && (activity.smartSearching || activity.smartProgress) && (
        <JobsSmartSearchStatusCard
          smartSearching={activity.smartSearching}
          smartProgress={activity.smartProgress}
        />
      )}
    </>
  )
}

describe('JobsPanel smart search progress', () => {
  afterEach(() => {
    cleanup()
    delete window.loa
    vi.restoreAllMocks()
  })

  it('renders with prefilled keywords without hook-order or TDZ errors and does not auto-start a search', async () => {
    // The auto-first-land effect was removed intentionally — it could re-fire on
    // HMR remounts and dev-mode component-tree churn, repeatedly triggering long
    // LinkedIn searches the user didn't ask for. Searches are now always explicit.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const jobsSmartSearch = vi.fn().mockResolvedValue({
      ok: true,
      plan: {
        queries: ['Staff product designer'],
        criteria: 'Staff product designer',
        summary: 'Search complete.'
      },
      queryResults: [{ query: 'Staff product designer', count: 0 }],
      jobs: [],
      scored: [],
      enrichedCount: 0
    })

    window.loa = {
      jobsSmartSearch,
      jobsProgressState: vi.fn().mockResolvedValue(null),
      settingsGet: vi.fn().mockResolvedValue({ userBackground: 'Staff product designer' }),
      settingsSave: vi.fn().mockResolvedValue({}),
      trackEvent: vi.fn().mockResolvedValue(undefined),
      onJobsProgress: vi.fn().mockImplementation(() => () => {})
    } as unknown as Window['loa']

    render(<JobsPanel aiConfigured chromeReady settingsReady />)

    // Give the renderer ample time — if auto-start were still wired up, the
    // 500ms setTimeout + React commit would fire jobsSmartSearch well inside
    // this window. Expect it NOT to fire.
    await new Promise((r) => setTimeout(r, 1_200))
    expect(jobsSmartSearch).not.toHaveBeenCalled()

    const loggedErrors = consoleError.mock.calls.flat().join(' ')
    expect(loggedErrors).not.toContain("Cannot access 'searchJobs' before initialization")
    expect(loggedErrors).not.toContain('Rendered fewer hooks than expected')
  })

  it('shows live smart-search status details while the backend is still working', async () => {
    let progressListener: ((progress: JobsProgressState | null) => void) | null = null
    let resolveSmartSearch: ((value: unknown) => void) | null = null

    const jobsSmartSearch = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSmartSearch = resolve
        })
    )

    window.loa = {
      jobsSmartSearch,
      jobsProgressState: vi.fn().mockResolvedValue(null),
      settingsSave: vi.fn().mockResolvedValue({}),
      onJobsProgress: vi.fn().mockImplementation((cb: (progress: JobsProgressState | null) => void) => {
        progressListener = cb
        return () => {
          progressListener = null
        }
      })
    } as unknown as Window['loa']

    render(
      <JobsPanelWithCampaignSmartCard
        aiConfigured
        chromeReady
        initialSearch={{ keywords: 'anthropic role in new york' }}
        onSearchConsumed={() => {}}
      />
    )

    await waitFor(() => {
      expect(jobsSmartSearch).toHaveBeenCalledTimes(1)
      expect(progressListener).not.toBeNull()
    })

    const now = Date.now()
    await act(async () => {
      progressListener?.({
        active: true,
        phase: 'searching',
        message: 'Searching LinkedIn for "Anthropic platform engineer"...',
        startedAt: now - 14_000,
        updatedAt: now - 14_000,
        queriesPlanned: ['Anthropic', 'Anthropic platform engineer', 'Anthropic software engineer'],
        queriesCompleted: 1,
        currentQuery: 'Anthropic platform engineer',
        currentQueryIndex: 2,
        totalQueries: 3,
        currentQueryResultCount: 7,
        totalJobsFound: 12
      })
    })

    const liveProgressHeading = screen
      .getAllByText(/Searching LinkedIn for "Anthropic platform engineer"/)
      .find((node) => node.closest('.smart-search-progress'))
    const liveProgress = liveProgressHeading?.closest('.smart-search-progress')
    expect(liveProgress).toBeTruthy()
    const drawer = within(liveProgress as HTMLElement)
    expect(drawer.getByText('Searching LinkedIn')).toBeTruthy()
    expect(drawer.getByText('1/3 searches')).toBeTruthy()
    expect(drawer.getByText('12 jobs found')).toBeTruthy()
    expect(drawer.getByText('14s elapsed')).toBeTruthy()
    expect(drawer.getByText(/Searching:/)).toBeTruthy()
    expect(screen.getAllByText(/Searching LinkedIn for "Anthropic platform engineer"/).length).toBeGreaterThan(0)
    expect(drawer.getByText(/Latest search added 7 new jobs\./)).toBeTruthy()
    expect(drawer.getByText(/Planned searches: Anthropic/)).toBeTruthy()
    expect(drawer.getByText(/Still working\. Last update 14s ago\./)).toBeTruthy()

    await act(async () => {
      resolveSmartSearch?.({
        ok: true,
        plan: {
          queries: ['Anthropic', 'Anthropic platform engineer', 'Anthropic software engineer'],
          criteria: 'Anthropic roles in New York',
          summary: 'Search complete.'
        },
        queryResults: [
          { query: 'Anthropic', count: 4 },
          { query: 'Anthropic platform engineer', count: 5 },
          { query: 'Anthropic software engineer', count: 3 }
        ],
        jobs: [],
        scored: [],
        enrichedCount: 0
      })
    })

    await waitFor(() => {
      expect(screen.getByText(/Completed 3\/3 searches\./)).toBeTruthy()
    })
  })
})
