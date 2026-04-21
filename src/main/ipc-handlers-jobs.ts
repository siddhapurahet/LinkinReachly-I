import type { JobsProgressState } from '@core/jobs-progress'
import {
  normalizeJobSearchInput,
  rankJobsForQueries,
  rankJobsWithResumeFit,
  sortJobsByResumeFit
} from '@core/job-search'
import { parseLinkedInJobsUrl } from '@core/linkedin-url'
import type { UserProfile } from '@core/profile-db'
import { rankJobsByFit, type JobPosting } from '@core/job-scorer'
import { parseResumeMarkdown } from '@core/resume-parser'
import { appLog } from './app-log'
import type { BridgeResultMsg } from './bridge'
import {
  buildCandidateContextForJobsMatch,
  linkedInJobsSearchUrl,
  type JobSearchUrlOptions,
  llmBatchJobMatchPercents,
  screenJobs
} from './llm'
import type { LogStatus, OutreachLogEntry } from './logger'
import { loadUserProfile, hasUserProfile } from './profile-store'
import type { AppSettings } from './settings'

/** Deeper infinite-scroll capture on LinkedIn job SERP (extension caps passes). */
const JOB_LISTING_SCROLL_PASSES = 10
/** After smart search enrichment the active tab may be a job detail page — load-more re-opens SERP and scrolls harder. */
const JOB_LISTING_LOAD_MORE_SCROLL_PASSES = 14

/**
 * Smart-search deadline. With FAST_ENRICH_TOP=25 (full SERP page) and the
 * NAVIGATE retry path, we give 6 min so a slow LinkedIn run still completes
 * instead of timing out partway through enrichment.
 */
const SMART_SEARCH_TOTAL_TIMEOUT_MS = 6 * 60 * 1000
/** Cap the jobs sent to the LLM overlay so it can't dominate the total budget. Remaining jobs keep heuristic scores. */
const LLM_OVERLAY_JOB_CAP = 25

type HandlerContext = {
  sendCommand: (
    action: string,
    payload?: Record<string, unknown>,
    timeoutMs?: number
  ) => Promise<BridgeResultMsg>
  loadSettings: () => AppSettings
  appendHistoryEvent: (
    entry: Omit<OutreachLogEntry, 'timestamp' | 'status'> & { status?: LogStatus }
  ) => void
  getJobsProgressState: () => JobsProgressState | null
  setJobsProgress: (next: JobsProgressState | null) => void
  scheduleJobsProgressClear: (expectedStartedAt?: number, delayMs?: number) => void
  getActiveSearchAbortController: () => AbortController | null
  setActiveSearchAbortController: (c: AbortController | null) => void
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isSmartSearchAbortError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error || '').toLowerCase()
  if (message.includes('jobs_smart_search_cancelled')) return true
  if (message.includes('jobs_smart_search_timeout')) return true
  return error instanceof Error && error.name === 'AbortError'
}

async function withAbortAndTimeout<T>(
  work: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
  timeoutCode: string
): Promise<T> {
  if (signal.aborted) {
    const err = new Error('jobs_smart_search_cancelled')
    err.name = 'AbortError'
    throw err
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      const err = new Error('jobs_smart_search_cancelled')
      err.name = 'AbortError'
      reject(err)
    }
    const onTimeout = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error(timeoutCode))
    }
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort)
      clearTimeout(timer)
    }
    signal.addEventListener('abort', onAbort)
    const timer = setTimeout(onTimeout, Math.max(1, timeoutMs))
    void work.then(
      (value) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      },
      (error) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
    )
  })
}

/** Structured profile on disk, else parsed résumé text from settings when present. */
function resolveProfileForJobRanking(ctx: HandlerContext): UserProfile | null {
  if (hasUserProfile()) {
    return loadUserProfile()
  }
  const resumeText = ctx.loadSettings().resumeText?.trim()
  if (!resumeText) return null
  try {
    const parsed = parseResumeMarkdown(resumeText)
    if (
      parsed.entries.length > 0 ||
      parsed.education.length > 0 ||
      (parsed.summary && parsed.summary.trim().length > 40)
    ) {
      return parsed
    }
  } catch (e) {
    appLog.warn('[index] resume parse failed', e instanceof Error ? e.message : String(e))
  }
  return null
}

/** When AI is enabled and we have candidate text, replace/augment listing match % via one LLM batch call. */
async function overlayLlmJobMatchScores<
  T extends {
    jobUrl?: string
    title?: string
    company?: string
    location?: string
    description?: string
    resumeMatchPercent?: number
    resumeMatchReason?: string
  }
>(ctx: HandlerContext, jobs: T[], cap?: number): Promise<T[]> {
  if (jobs.length === 0) return jobs
  const settings = ctx.loadSettings()
  const profile = resolveProfileForJobRanking(ctx)
  const matchCtx = buildCandidateContextForJobsMatch(settings, profile)
  const capped = typeof cap === 'number' && cap > 0 ? jobs.slice(0, cap) : jobs
  const forLlm = capped
    .filter((j): j is T & { jobUrl: string } => Boolean(j.jobUrl && j.title))
    .map((j) => ({
      jobUrl: j.jobUrl as string,
      title: String(j.title || ''),
      company: String(j.company || ''),
      location: String(j.location || ''),
      description:
        'description' in j && typeof j.description === 'string' && j.description.length > 50
          ? j.description
          : undefined
    }))
  const llmMap = await llmBatchJobMatchPercents(settings, forLlm, matchCtx, undefined)
  if (!llmMap || llmMap.size === 0) return jobs
  const merged = jobs.map((j) => {
    const u = j.jobUrl
    if (!u) return j
    const hit = llmMap.get(u)
    if (!hit) return j
    return {
      ...j,
      resumeMatchPercent: hit.matchPercent,
      resumeMatchReason: hit.reason
    }
  })
  return [...merged].sort((a, b) => (b.resumeMatchPercent ?? -1) - (a.resumeMatchPercent ?? -1))
}

/** Safe for renderer — never exposes raw API key. */
function jobSearchUrlOpts(ctx: HandlerContext, easyApplyOnlyOverride?: boolean): JobSearchUrlOptions {
  const s = ctx.loadSettings()
  return {
    easyApplyOnly: easyApplyOnlyOverride ?? (s.jobsSearchEasyApplyOnly !== false),
    recencySeconds: s.jobsSearchRecencySeconds || 0,
    sortBy: s.jobsSearchSortBy || undefined,
    distanceMiles: s.jobsSearchDistanceMiles || 0,
    experienceLevels: s.jobsSearchExperienceLevels || [],
    jobTypes: s.jobsSearchJobTypes || [],
    remoteTypes: s.jobsSearchRemoteTypes || [],
    salaryFloor: s.jobsSearchSalaryFloor || 0,
    fewApplicants: s.jobsSearchFewApplicants || false,
    verifiedOnly: s.jobsSearchVerifiedOnly || false
  }
}

/**
 * Registers all jobs-related `loaInvoke` channel handlers.
 * Returns a map from channel name to async handler.
 */
export function registerJobsHandlers(ctx: HandlerContext): Map<string, (payload: unknown) => Promise<unknown>> {
  const handlers = new Map<string, (payload: unknown) => Promise<unknown>>()

  handlers.set('jobs:search', async (payload) => {
    const jobPayload = payload as { keywords?: string; location?: string } | undefined
    const normalizedSearch = normalizeJobSearchInput(
      String(jobPayload?.keywords || ''),
      jobPayload?.location
    )
    const keywords = normalizedSearch.keywords
    if (!keywords) return { ok: false as const, detail: 'Enter job keywords first.' }
    const jobSearchUrl = linkedInJobsSearchUrl(
      keywords,
      normalizedSearch.location,
      jobSearchUrlOpts(ctx)
    )
    const activeSearchAbortController = ctx.getActiveSearchAbortController()
    if (activeSearchAbortController && !activeSearchAbortController.signal.aborted) {
      activeSearchAbortController.abort()
    }
    const searchAbort = new AbortController()
    ctx.setActiveSearchAbortController(searchAbort)
    const ensureSearchStillActive = () => {
      if (searchAbort.signal.aborted) {
        const err = new Error('jobs_smart_search_cancelled')
        err.name = 'AbortError'
        throw err
      }
    }
    // Legacy jobs:search compatibility path should support cancel without imposing a short timeout.
    const withSearchAbort = <T>(promise: Promise<T>) =>
      withAbortAndTimeout(promise, searchAbort.signal, 0x7fffffff, 'jobs_search_timeout')
    try {
      const ping = await withSearchAbort(ctx.sendCommand('PING', {}, 15_000))
      if (!ping.ok) {
        const detail =
          ping.detail === 'open_a_linkedin_tab' ? 'Open a linkedin.com tab in Chrome.' : ping.detail
        ctx.appendHistoryEvent({
          profileUrl: jobSearchUrl,
          status: 'error',
          detail,
          eventType: 'jobs_search',
          summary: 'LinkedIn job search could not start.',
          searchQuery: keywords,
          searchUrl: jobSearchUrl,
          location: normalizedSearch.location,
          resultCount: 0,
          jobs: []
        })
        return { ok: false as const, jobSearchUrl, detail }
      }
      const nav = await withSearchAbort(ctx.sendCommand('NAVIGATE', { url: jobSearchUrl }, 45_000))
      if (!nav.ok) {
        ctx.appendHistoryEvent({
          profileUrl: jobSearchUrl,
          status: 'error',
          detail: nav.detail || 'Could not open LinkedIn Jobs.',
          eventType: 'jobs_search',
          summary: 'Couldn\u2019t open LinkedIn job search.',
          searchQuery: keywords,
          searchUrl: jobSearchUrl,
          location: normalizedSearch.location,
          resultCount: 0,
          jobs: []
        })
        return { ok: false as const, jobSearchUrl, detail: nav.detail || 'Could not open LinkedIn Jobs.' }
      }
      let results = await withSearchAbort(
        ctx.sendCommand(
          'EXTRACT_JOB_LISTINGS',
          { scrollPasses: JOB_LISTING_SCROLL_PASSES },
          45_000
        )
      )
      // If the browser landed on /jobs/view/ instead of the search page, re-navigate
      if (!results.ok && String(results.detail || '').includes('wrong_page:jobs_view')) {
        appLog.info('[jobs:search] landed on /jobs/view/ instead of search results, re-navigating')
        await withSearchAbort(ctx.sendCommand('NAVIGATE', { url: jobSearchUrl }, 45_000))
        await withSearchAbort(new Promise((r) => setTimeout(r, 3000)))
        results = await withSearchAbort(
          ctx.sendCommand('EXTRACT_JOB_LISTINGS', { scrollPasses: JOB_LISTING_SCROLL_PASSES }, 45_000)
        )
      }
      if (!results.ok && /selectors_miss:no_cards/i.test(String(results.detail || ''))) {
        appLog.info('[jobs:search] no cards on first attempt, retrying after 4s wait')
        await withSearchAbort(new Promise((r) => setTimeout(r, 4000)))
        results = await withSearchAbort(
          ctx.sendCommand('EXTRACT_JOB_LISTINGS', { scrollPasses: JOB_LISTING_SCROLL_PASSES }, 45_000)
        )
      }
      if (!results.ok) {
        ctx.appendHistoryEvent({
          profileUrl: jobSearchUrl,
          status: 'error',
          detail: results.detail || 'Could not read job listings.',
          eventType: 'jobs_search',
          summary: 'LinkedIn job search loaded, but results could not be read.',
          searchQuery: keywords,
          searchUrl: jobSearchUrl,
          location: normalizedSearch.location,
          resultCount: 0,
          jobs: []
        })
        return { ok: false as const, jobSearchUrl, detail: results.detail || 'Could not read job listings.' }
      }
      const items = Array.isArray((results.data as { items?: unknown[] })?.items)
        ? ((results.data as { items: unknown[] }).items as Array<{
            title: string
            company: string
            location: string
            jobUrl: string
            postedDate?: string
            easyApply?: boolean
            applyUrl?: string
          }>)
        : []
      let rankedItems: (typeof items[number] & { resumeMatchPercent?: number; resumeMatchReason?: string })[]
      try {
        rankedItems = rankJobsWithResumeFit(
          items,
          keywords,
          normalizedSearch.location,
          resolveProfileForJobRanking(ctx)
        )
      } catch (rankErr) {
        appLog.warn('[jobs:search] Ranking failed, using raw order', rankErr)
        rankedItems = items as typeof rankedItems
      }
      try {
        rankedItems = await withSearchAbort(overlayLlmJobMatchScores(ctx, rankedItems, LLM_OVERLAY_JOB_CAP))
      } catch (llmErr) {
        if (isSmartSearchAbortError(llmErr)) throw llmErr
        appLog.warn('[jobs:search] LLM scoring failed', llmErr)
      }
      ensureSearchStillActive()
      ctx.appendHistoryEvent({
        profileUrl: jobSearchUrl,
        detail: rankedItems.length > 0 ? 'jobs_search_completed' : 'jobs_search_empty',
        eventType: 'jobs_search',
        summary:
          rankedItems.length > 0
            ? `Saved ${rankedItems.length} jobs from LinkedIn.`
            : 'Ran LinkedIn job search but found no saved matches.',
        searchQuery: keywords,
        searchUrl: jobSearchUrl,
        location: normalizedSearch.location,
        resultCount: rankedItems.length,
        jobs: rankedItems.map((job) => ({
          title: job.title,
          company: job.company,
          location: job.location,
          jobUrl: job.jobUrl,
          postedDate: job.postedDate,
          easyApply: job.easyApply,
          resumeMatchPercent: job.resumeMatchPercent,
          resumeMatchReason: job.resumeMatchReason
        }))
      })
      return { ok: true as const, jobSearchUrl, count: rankedItems.length, jobs: rankedItems }
    } catch (e) {
      const canceled = isSmartSearchAbortError(e)
      const detail = canceled ? 'Search canceled.' : e instanceof Error ? e.message : String(e)
      ctx.appendHistoryEvent({
        profileUrl: jobSearchUrl,
        status: 'error',
        detail,
        eventType: 'jobs_search',
        summary: 'Job search ran into an unexpected issue.',
        searchQuery: keywords,
        searchUrl: jobSearchUrl,
        location: normalizedSearch.location,
        resultCount: 0,
        jobs: []
      })
      return canceled
        ? { ok: false as const, canceled: true as const, jobSearchUrl, detail }
        : { ok: false as const, jobSearchUrl, detail }
    } finally {
      if (ctx.getActiveSearchAbortController() === searchAbort) {
        ctx.setActiveSearchAbortController(null)
      }
    }
  })

  handlers.set('jobs:loadMoreJobListings', async (payload) => {
    const p = payload as {
      existingJobUrls?: string[]
      keywords?: string
      location?: string
    } | undefined
    const existingUrls = new Set((p?.existingJobUrls || []).filter(Boolean))
    const normalizedSearch = normalizeJobSearchInput(
      String(p?.keywords || ctx.loadSettings().jobsSearchKeywords || ''),
      p?.location ?? ctx.loadSettings().jobsSearchLocation
    )
    if (!normalizedSearch.keywords.trim()) {
      return {
        ok: false as const,
        detail:
          'Run a job search first, keep LinkedIn on that results page, then tap Load more listings.'
      }
    }
    try {
      const ping = await ctx.sendCommand('PING', {}, 15_000)
      if (!ping.ok) {
        const detail =
          ping.detail === 'open_a_linkedin_tab' ? 'Open a linkedin.com tab in Chrome.' : ping.detail
        return { ok: false as const, detail }
      }

      type JobItem = {
        title: string
        company: string
        location: string
        jobUrl: string
        postedDate?: string
        easyApply?: boolean
        applyUrl?: string
      }
      const parseItems = (data: unknown): JobItem[] =>
        Array.isArray((data as { items?: unknown[] })?.items)
          ? ((data as { items: unknown[] }).items as JobItem[])
          : []

      const pageStart = existingUrls.size
      const baseUrl = linkedInJobsSearchUrl(
        normalizedSearch.keywords,
        normalizedSearch.location,
        jobSearchUrlOpts(ctx)
      )
      const paginatedUrl = pageStart > 0 ? `${baseUrl}&start=${pageStart}` : baseUrl

      const nav = await ctx.sendCommand('NAVIGATE', { url: paginatedUrl }, 45_000)
      if (!nav.ok) {
        return {
          ok: false as const,
          detail: nav.detail || 'Could not open LinkedIn job search to load more listings.'
        }
      }
      await new Promise((r) => setTimeout(r, 2000))
      let results = await ctx.sendCommand(
        'EXTRACT_JOB_LISTINGS',
        { scrollPasses: JOB_LISTING_LOAD_MORE_SCROLL_PASSES },
        60_000
      )
      // If the browser landed on /jobs/view/ instead of the search page, re-navigate
      if (!results.ok && String(results.detail || '').includes('wrong_page:jobs_view')) {
        appLog.info('[jobs:loadMore] landed on /jobs/view/ instead of search results, re-navigating')
        await ctx.sendCommand('NAVIGATE', { url: paginatedUrl }, 45_000)
        await new Promise((r) => setTimeout(r, 3000))
        results = await ctx.sendCommand(
          'EXTRACT_JOB_LISTINGS',
          { scrollPasses: JOB_LISTING_LOAD_MORE_SCROLL_PASSES },
          60_000
        )
      }
      if (!results.ok) {
        return { ok: false as const, detail: results.detail || 'Could not read more job listings.' }
      }
      const items = parseItems(results.data).filter((j) => j.jobUrl && !existingUrls.has(j.jobUrl))

      let rankedNew: Array<(typeof items)[number] & { resumeMatchPercent?: number; resumeMatchReason?: string }>
      try {
        rankedNew = rankJobsWithResumeFit(
          items,
          normalizedSearch.keywords,
          normalizedSearch.location,
          resolveProfileForJobRanking(ctx)
        )
      } catch (rankErr) {
        appLog.warn('[jobs:loadMore] Ranking failed, using raw order', rankErr)
        rankedNew = items as typeof rankedNew
      }
      try {
        rankedNew = await overlayLlmJobMatchScores(ctx, rankedNew, LLM_OVERLAY_JOB_CAP)
      } catch (llmErr) {
        appLog.warn('[jobs:loadMore] LLM scoring failed', llmErr)
      }
      ctx.appendHistoryEvent({
        profileUrl: baseUrl,
        detail: 'jobs_load_more_completed',
        eventType: 'jobs_search',
        summary: `Loaded ${rankedNew.length} additional listings.`,
        searchQuery: normalizedSearch.keywords,
        location: normalizedSearch.location,
        resultCount: rankedNew.length,
        jobs: rankedNew.map((job) => ({
          title: job.title,
          company: job.company,
          location: job.location,
          jobUrl: job.jobUrl,
          postedDate: job.postedDate,
          easyApply: job.easyApply,
          resumeMatchPercent:
            'resumeMatchPercent' in job ? (job as { resumeMatchPercent?: number }).resumeMatchPercent : undefined,
          resumeMatchReason:
            'resumeMatchReason' in job ? (job as { resumeMatchReason?: string }).resumeMatchReason : undefined
        }))
      })
      return { ok: true as const, jobs: rankedNew, addedCount: rankedNew.length }
    } catch (e) {
      return {
        ok: false as const,
        detail: e instanceof Error ? e.message : String(e)
      }
    }
  })

  handlers.set('jobs:screen', async (payload) => {
    const screenPayload = payload as {
      criteria?: string
      jobs?: Array<{
        title: string
        company: string
        location: string
        jobUrl: string
        description?: string
        applyUrl?: string
        easyApply?: boolean
        postedDate?: string
      }>
      apiKey?: string | null
    } | undefined
    const criteria = String(screenPayload?.criteria || '').trim()
    const jobs = Array.isArray(screenPayload?.jobs) ? screenPayload!.jobs : []
    if (!criteria) return { ok: false as const, detail: 'Describe what you are looking for.' }
    if (jobs.length === 0) return { ok: false as const, detail: 'No jobs to screen.' }
    const settings = ctx.loadSettings()
    const screenResult = await screenJobs(
      settings,
      criteria,
      jobs,
      screenPayload?.apiKey,
      settings.resumeText
    )
    ctx.appendHistoryEvent({
      profileUrl: jobs[0]?.jobUrl || linkedInJobsSearchUrl('jobs'),
      detail: 'jobs_screen_completed',
      eventType: 'jobs_screen',
      summary: `Saved AI screening results for ${screenResult.results.length} jobs.`,
      criteria,
      resultCount: screenResult.results.length,
      jobs: screenResult.results.map((job) => ({
        title: job.title,
        company: job.company,
        location: job.location,
        jobUrl: job.jobUrl,
        description: job.description,
        score: job.score,
        titleFit: job.titleFit,
        seniorityMatch: job.seniorityMatch,
        locationFit: job.locationFit,
        companyFit: job.companyFit,
        reason: job.reason,
        nextStep: job.nextStep
      }))
    })
    return screenResult
  })

  handlers.set('jobs:progressState', async () => ctx.getJobsProgressState())

  handlers.set('jobs:cancelSearch', async () => {
    const active = ctx.getActiveSearchAbortController()
    const canCancel = !!active && !active.signal.aborted
    if (canCancel) {
      active.abort()
      const jobsProgressState = ctx.getJobsProgressState()
      if (jobsProgressState) {
        ctx.setJobsProgress({
          ...jobsProgressState,
          updatedAt: Date.now(),
          message: 'Canceling search...'
        })
      }
    }
    return {
      ok: true as const,
      canceled: canCancel,
      detail: canCancel ? 'Cancel requested.' : 'No active smart search to cancel.'
    }
  })

  handlers.set('jobs:smartSearch', async (payload) => {
    const smartPayload = payload as {
      background: string
      location?: string
      apiKey?: string | null
      enrichDetails?: boolean
      cachedDescriptions?: Record<string, string>
      sourceUrl?: string
    } | undefined
    const rawBackground = String(smartPayload?.background || '').trim()
    const sourceUrlRaw = String(smartPayload?.sourceUrl || '').trim()
    const parsedSourceUrl = sourceUrlRaw ? parseLinkedInJobsUrl(sourceUrlRaw) : null
    if (parsedSourceUrl && !parsedSourceUrl.ok) {
      return { ok: false as const, detail: parsedSourceUrl.reason }
    }
    if (!rawBackground && !sourceUrlRaw) {
      return { ok: false as const, detail: 'Describe your background or paste a LinkedIn jobs URL.' }
    }
    const normalizedSearch = normalizeJobSearchInput(
      rawBackground || 'LinkedIn jobs',
      sourceUrlRaw ? undefined : smartPayload?.location
    )
    const startedAt = Date.now()
    appLog.info('[smart-search] start', {
      background: rawBackground.slice(0, 80),
      location: normalizedSearch.location,
      totalBudgetMs: SMART_SEARCH_TOTAL_TIMEOUT_MS
    })
    const priorAbort = ctx.getActiveSearchAbortController()
    if (priorAbort && !priorAbort.signal.aborted) {
      priorAbort.abort()
    }
    const searchAbort = new AbortController()
    ctx.setActiveSearchAbortController(searchAbort)
    const deadlineAt = startedAt + SMART_SEARCH_TOTAL_TIMEOUT_MS
    const remainingMs = () => Math.max(1_000, deadlineAt - Date.now())
    const ensureSearchStillActive = () => {
      if (searchAbort.signal.aborted) {
        const err = new Error('jobs_smart_search_cancelled')
        err.name = 'AbortError'
        throw err
      }
      if (Date.now() >= deadlineAt) {
        throw new Error('jobs_smart_search_timeout')
      }
    }
    const withSmartSearchAbort = <T>(promise: Promise<T>) =>
      withAbortAndTimeout(promise, searchAbort.signal, remainingMs(), 'jobs_smart_search_timeout')
    const smartWait = (ms: number) => withSmartSearchAbort(wait(ms))
    const updateProgress = (partial: Omit<JobsProgressState, 'active' | 'startedAt' | 'updatedAt'>) => {
      ctx.setJobsProgress({
        active: true,
        startedAt,
        updatedAt: Date.now(),
        ...partial
      })
    }

    updateProgress({
      phase: 'searching',
      message: 'Searching LinkedIn...'
    })

    try {
      ensureSearchStillActive()
      const settings = ctx.loadSettings()
      const profileSource: 'settings' | 'linkedin_profile' | 'none' =
        (settings.userBackground || '').trim() || (settings.resumeText || '').trim() ? 'settings' : 'none'

      const tPing = Date.now()
      appLog.info('[smart-search] phase=ping start')
      const ping = await withSmartSearchAbort(ctx.sendCommand('PING', {}, 10_000))
      appLog.info('[smart-search] phase=ping done', { ms: Date.now() - tPing, ok: ping.ok, detail: ping.detail || undefined })
      if (!ping.ok) {
        const detail =
          ping.detail === 'open_a_linkedin_tab' ? 'Open a linkedin.com tab in Chrome.' : ping.detail
        ctx.appendHistoryEvent({
          profileUrl: linkedInJobsSearchUrl(
            normalizedSearch.keywords || rawBackground,
            normalizedSearch.location
          ),
          status: 'error',
          detail,
          eventType: 'jobs_search',
          summary: 'Job search could not start.',
          searchQuery: rawBackground,
          location: normalizedSearch.location,
          resultCount: 0,
          jobs: [],
          profileSource
        })
        return { ok: false as const, detail }
      }

      const usesCustomSourceUrl = !!(parsedSourceUrl && parsedSourceUrl.ok)
      const sourceKind = parsedSourceUrl && parsedSourceUrl.ok ? parsedSourceUrl.kind : null
      const fallbackSearchQuery = usesCustomSourceUrl
        ? sourceKind === 'view'
          ? `LinkedIn job ${parsedSourceUrl.jobId || ''}`.trim()
          : 'LinkedIn jobs URL'
        : rawBackground
      const searchQuery = normalizedSearch.keywords || fallbackSearchQuery
      const searchUrl = usesCustomSourceUrl
        ? parsedSourceUrl.normalizedUrl
        : linkedInJobsSearchUrl(
            searchQuery,
            normalizedSearch.location,
            jobSearchUrlOpts(ctx)
          )
      const searchLocation = usesCustomSourceUrl ? undefined : normalizedSearch.location
      const queryResults = [{ query: searchQuery, count: 0 }]
      const plan = {
        queries: [searchQuery],
        criteria: rawBackground || searchQuery,
        summary: usesCustomSourceUrl
          ? sourceKind === 'view'
            ? 'Direct LinkedIn job page.'
            : 'LinkedIn jobs search URL.'
          : 'Direct keyword search.'
      }

      updateProgress({
        phase: 'searching',
        message: usesCustomSourceUrl
          ? 'Opening your LinkedIn jobs URL...'
          : `Searching LinkedIn for "${searchQuery}"...`,
        queriesPlanned: [searchQuery],
        queriesCompleted: 0,
        currentQuery: searchQuery,
        currentQueryIndex: 1,
        totalQueries: 1,
        totalJobsFound: 0
      })

      const tNav = Date.now()
      appLog.info('[smart-search] phase=navigate start', { url: searchUrl })
      let nav: BridgeResultMsg
      try {
        nav = await withSmartSearchAbort(ctx.sendCommand('NAVIGATE', { url: searchUrl }, 60_000))
      } catch (navErr) {
        // Retry once on bridge timeout — LinkedIn occasionally takes >60s on a cold load.
        // Skip retry for cancellation/total-timeout (those should propagate).
        const navMsg = navErr instanceof Error ? navErr.message : String(navErr)
        if (isSmartSearchAbortError(navErr) || !navMsg.includes('Command timeout')) throw navErr
        appLog.warn('[smart-search] phase=navigate timeout, retrying once', { ms: Date.now() - tNav, detail: navMsg })
        await smartWait(1500)
        nav = await withSmartSearchAbort(ctx.sendCommand('NAVIGATE', { url: searchUrl }, 60_000))
      }
      appLog.info('[smart-search] phase=navigate done', { ms: Date.now() - tNav, ok: nav.ok, detail: nav.detail || undefined })
      if (!nav.ok) {
        ctx.appendHistoryEvent({
          profileUrl: searchUrl,
          status: 'error',
          detail: nav.detail,
          eventType: 'jobs_search',
          summary: 'Could not load LinkedIn search results.',
          searchQuery: rawBackground,
          location: normalizedSearch.location,
          resultCount: 0,
          jobs: [],
          profileSource
        })
        return { ok: false as const, detail: nav.detail || 'Couldn\u2019t load search results.' }
      }
      await smartWait(500)

      /**
       * Enrichment (clicking each job card to load the description) is the biggest
       * variable cost in the smart search. LinkedIn often navigates the tab to
       * /jobs/view/<id> on click, costing 3–6s per card to recover. We enrich the
       * top 10 cards (still gives the LLM enough signal to score) and rely on
       * title/company/location for the rest. All cards on the SERP are still
       * returned to the renderer.
       */
      const FAST_SCROLL_PASSES = 10
      const FAST_ENRICH_TOP = 10

      type ExtractedJobItem = {
        title: string
        company: string
        location: string
        jobUrl: string
        postedDate?: string
        description?: string
        easyApply?: boolean
        applyUrl?: string
      }
      const parseItems = (data: unknown): ExtractedJobItem[] =>
        Array.isArray((data as { items?: unknown[] })?.items)
          ? ((data as { items: unknown[] }).items as ExtractedJobItem[])
          : []

      updateProgress({
        phase: 'enriching',
        message:
          usesCustomSourceUrl && sourceKind === 'view'
            ? 'Reading the job page and nearby listings...'
            : 'Reading job listings and descriptions...',
        queriesPlanned: [searchQuery],
        queriesCompleted: 1,
        totalQueries: 1,
        totalJobsFound: 0,
        enrichingCompleted: 0,
        enrichingTotal: FAST_ENRICH_TOP
      })
      let rawItems: ExtractedJobItem[] = []
      if (usesCustomSourceUrl && sourceKind === 'view') {
        const directResults = await withSmartSearchAbort(
          ctx.sendCommand(
            'EXTRACT_JOB_LISTINGS',
            { scrollPasses: FAST_SCROLL_PASSES, enrichTop: FAST_ENRICH_TOP, allowViewPage: true },
            180_000
          )
        )
        if (directResults.ok) {
          rawItems = parseItems(directResults.data)
        }

        if (rawItems.length === 0) {
          const detailResult = await withSmartSearchAbort(ctx.sendCommand('EXTRACT_JOB_DETAILS', {}, 45_000))
          if (!detailResult.ok) {
            ctx.appendHistoryEvent({
              profileUrl: searchUrl,
              detail: 'smart_jobs_search_failed',
              eventType: 'jobs_search',
              summary: `Couldn\u2019t read the LinkedIn job page: ${detailResult.detail || 'unknown issue'}`,
              searchQuery: rawBackground || searchQuery,
              searchUrl,
              location: searchLocation,
              resultCount: 0,
              jobs: [],
              queryResults,
              profileSource
            })
            return {
              ok: false as const,
              plan,
              queryResults,
              jobs: [],
              scored: [],
              enrichedCount: 0,
              detail: detailResult.detail || 'Could not read this LinkedIn job page.',
              profileSource
            }
          }
          const details = (detailResult.data || {}) as {
            title?: string
            company?: string
            location?: string
            description?: string
            criteria?: string[]
            easyApply?: boolean
            applyUrl?: string
          }
          const primaryJobUrl = parsedSourceUrl?.canonicalViewUrl || parsedSourceUrl?.normalizedUrl || searchUrl
          const criteriaText = Array.isArray(details.criteria)
            ? details.criteria.map((v) => String(v || '').trim()).filter(Boolean).join(' • ')
            : ''
          const descriptionBase = String(details.description || '').trim()
          const combinedDescription =
            [descriptionBase, criteriaText].filter(Boolean).join('\n\n').slice(0, 3000) || undefined
          const title = String(details.title || '').trim().replace(/\s+with verification$/i, '').trim()
          const company = String(details.company || '').trim()
          if (!title && !company) {
            ctx.appendHistoryEvent({
              profileUrl: searchUrl,
              detail: 'smart_jobs_search_failed',
              eventType: 'jobs_search',
              summary: 'The direct LinkedIn job page did not include readable job details.',
              searchQuery: rawBackground || searchQuery,
              searchUrl,
              location: searchLocation,
              resultCount: 0,
              jobs: [],
              queryResults,
              profileSource
            })
            return {
              ok: false as const,
              plan,
              queryResults,
              jobs: [],
              scored: [],
              enrichedCount: 0,
              detail: 'Could not read title/company from that LinkedIn job link.',
              profileSource
            }
          }
          rawItems = [
            {
              title: title || 'LinkedIn job',
              company: company || 'Unknown company',
              location: String(details.location || '').trim(),
              jobUrl: primaryJobUrl,
              description: combinedDescription,
              easyApply: !!details.easyApply,
              applyUrl: String(details.applyUrl || '').trim() || primaryJobUrl
            }
          ]
        }
      } else {
        const tExtract = Date.now()
        appLog.info('[smart-search] phase=extract start', { scrollPasses: FAST_SCROLL_PASSES, enrichTop: FAST_ENRICH_TOP })
        let results = await withSmartSearchAbort(
          ctx.sendCommand(
            'EXTRACT_JOB_LISTINGS',
            { scrollPasses: FAST_SCROLL_PASSES, enrichTop: FAST_ENRICH_TOP },
            180_000
          )
        )
        appLog.info('[smart-search] phase=extract done', { ms: Date.now() - tExtract, ok: results.ok, detail: results.detail || undefined })
        // If the browser landed on /jobs/view/ instead of the search page, re-navigate.
        if (!results.ok && String(results.detail || '').includes('wrong_page:jobs_view')) {
          const tRetry = Date.now()
          appLog.info('[smart-search] phase=retry start (landed on /jobs/view/, re-navigating)')
          await withSmartSearchAbort(ctx.sendCommand('NAVIGATE', { url: searchUrl }, 60_000))
          await smartWait(3000)
          results = await withSmartSearchAbort(
            ctx.sendCommand(
              'EXTRACT_JOB_LISTINGS',
              { scrollPasses: FAST_SCROLL_PASSES, enrichTop: FAST_ENRICH_TOP },
              90_000
            )
          )
          appLog.info('[smart-search] phase=retry done', { ms: Date.now() - tRetry, ok: results.ok, detail: results.detail || undefined })
        }
        if (!results.ok) {
          ctx.appendHistoryEvent({
            profileUrl: searchUrl,
            detail: 'smart_jobs_search_failed',
            eventType: 'jobs_search',
            summary: `Couldn\u2019t extract search results: ${results.detail || 'unknown issue'}`,
            searchQuery: rawBackground || searchQuery,
            searchUrl,
            location: searchLocation,
            resultCount: 0,
            jobs: [],
            queryResults,
            profileSource
          })
          return {
            ok: false as const,
            plan,
            queryResults,
            jobs: [],
            scored: [],
            enrichedCount: 0,
            detail: results.detail || 'Could not extract job listings.',
            profileSource
          }
        }
        if (!Array.isArray((results.data as { items?: unknown[] })?.items)) {
          ctx.appendHistoryEvent({
            profileUrl: searchUrl,
            detail: 'smart_jobs_search_empty',
            eventType: 'jobs_search',
            summary: 'Search ran but found no job listings.',
            searchQuery: rawBackground || searchQuery,
            searchUrl,
            location: searchLocation,
            resultCount: 0,
            jobs: [],
            queryResults,
            profileSource
          })
          return {
            ok: true as const,
            plan,
            queryResults,
            jobs: [],
            scored: [],
            enrichedCount: 0,
            detail: 'No listings found on this search page.',
            profileSource
          }
        }
        rawItems = parseItems(results.data)
      }

      const seenUrls = new Set<string>()
      const allJobs: typeof rawItems = []
      let enrichedCount = 0
      for (const item of rawItems) {
        if (!item.jobUrl || seenUrls.has(item.jobUrl)) continue
        seenUrls.add(item.jobUrl)
        // Be conservative: unknown Easy Apply state should not be treated as true.
        // This prevents false positives from entering the apply queue.
        if (item.easyApply == null) item.easyApply = false
        if (item.title) item.title = item.title.replace(/\s+with verification$/i, '').trim()
        if (item.description && item.description.length > 50) enrichedCount++
        allJobs.push(item)
      }
      queryResults[0].count = allJobs.length

      let rankedJobs: typeof allJobs
      try {
        rankedJobs = sortJobsByResumeFit(
          rankJobsForQueries(allJobs, [searchQuery], normalizedSearch.location),
          resolveProfileForJobRanking(ctx)
        )
      } catch (rankErr) {
        appLog.warn('[smart-search] Ranking failed, using raw order', rankErr)
        rankedJobs = allJobs
      }

      updateProgress({
        phase: 'screening',
        message: `Scoring ${rankedJobs.length} jobs against your profile...`,
        queriesPlanned: [searchQuery],
        queriesCompleted: 1,
        totalQueries: 1,
        totalJobsFound: rankedJobs.length,
        enrichingCompleted: enrichedCount,
        enrichingTotal: enrichedCount,
        screeningCount: rankedJobs.length
      })

      try {
        const tLlm = Date.now()
        appLog.info('[smart-search] phase=llm start', { jobs: rankedJobs.length, cap: LLM_OVERLAY_JOB_CAP })
        rankedJobs = await withSmartSearchAbort(overlayLlmJobMatchScores(ctx, rankedJobs, LLM_OVERLAY_JOB_CAP))
        appLog.info('[smart-search] phase=llm done', { ms: Date.now() - tLlm })
      } catch (llmErr) {
        if (isSmartSearchAbortError(llmErr)) throw llmErr
        appLog.warn('[smart-search] LLM scoring failed, using heuristic scores', llmErr)
      }
      ensureSearchStillActive()

      if (rankedJobs.length === 0) {
        ctx.appendHistoryEvent({
          profileUrl: searchUrl,
          detail: 'smart_jobs_search_empty',
          eventType: 'jobs_search',
          summary: 'Search ran but found no job matches.',
          searchQuery: rawBackground,
          searchUrl,
          location: normalizedSearch.location,
          resultCount: 0,
          jobs: [],
          queryResults,
          profileSource
        })
        return {
          ok: true as const,
          plan,
          queryResults,
          jobs: [],
          scored: [],
          enrichedCount: 0,
          detail: 'No jobs found.',
          profileSource
        }
      }

      const scoredJobs = rankedJobs.map((job) => ({
        ...job,
        score: (job as Record<string, unknown>).resumeMatchPercent != null
          ? Math.round(Number((job as Record<string, unknown>).resumeMatchPercent) / 10)
          : 0,
        reason:
          (job as Record<string, unknown>).resumeMatchReason
            ? String((job as Record<string, unknown>).resumeMatchReason)
            : job.description && job.description.length > 50
              ? 'Matched by keywords. Not yet scored by AI.'
              : 'Matched by title. Not yet scored by AI.',
        nextStep: job.easyApply ? 'Easy Apply available' : 'Review and apply',
        titleFit: undefined as number | undefined,
        seniorityMatch: undefined as number | undefined,
        locationFit: undefined as number | undefined,
        companyFit: undefined as number | undefined
      }))

      ctx.appendHistoryEvent({
        profileUrl: searchUrl,
        detail: 'smart_jobs_search_completed',
        eventType: 'jobs_search',
        summary: `Found ${scoredJobs.length} jobs with ${enrichedCount} descriptions.`,
        searchQuery: rawBackground,
        searchUrl,
        location: normalizedSearch.location,
        criteria: rawBackground,
        resultCount: scoredJobs.length,
        jobs: scoredJobs.map((job) => ({
          title: job.title,
          company: job.company,
          location: job.location,
          jobUrl: job.jobUrl,
          postedDate: job.postedDate,
          description: job.description,
          score: job.score,
          titleFit: job.titleFit,
          seniorityMatch: job.seniorityMatch,
          locationFit: job.locationFit,
          companyFit: job.companyFit,
          reason: job.reason,
          nextStep: job.nextStep
        })),
        queryResults,
        profileSource
      })

      return {
        ok: true as const,
        plan,
        queryResults,
        jobs: scoredJobs,
        scored: scoredJobs,
        enrichedCount,
        detail: `Found ${scoredJobs.length} jobs in ${Math.round((Date.now() - startedAt) / 1000)}s.`,
        profileSource
      }
    } catch (e) {
      const rawDetail = e instanceof Error ? e.message : String(e)
      const canceled = isSmartSearchAbortError(e)
      const timedOut = /jobs_smart_search_timeout/i.test(rawDetail)
      appLog.warn('[smart-search] failed', { totalMs: Date.now() - startedAt, timedOut, canceled, detail: rawDetail })
      const detail = canceled
        ? timedOut
          ? `Smart search timed out after ${Math.round(SMART_SEARCH_TOTAL_TIMEOUT_MS / 60_000)} minutes.`
          : 'Smart search canceled.'
        : rawDetail
      const jobsProgressState = ctx.getJobsProgressState()
      if (jobsProgressState?.startedAt === startedAt) {
        ctx.setJobsProgress({
          ...jobsProgressState,
          updatedAt: Date.now(),
          message: canceled
            ? timedOut
              ? 'Smart search timed out. Try fewer constraints or disable enrichment.'
              : 'Smart search canceled.'
            : 'Smart search didn\u2019t complete.'
        })
      }
      ctx.appendHistoryEvent({
        profileUrl: linkedInJobsSearchUrl(
          normalizedSearch.keywords || rawBackground,
          normalizedSearch.location
        ),
        status: 'error',
        detail,
        eventType: 'jobs_search',
        summary: 'Smart search ran into an unexpected issue.',
        searchQuery: rawBackground,
        location: normalizedSearch.location,
        resultCount: 0,
        jobs: []
      })
      ctx.scheduleJobsProgressClear(startedAt, canceled ? 750 : 1800)
      return canceled ? { ok: false as const, canceled: true as const, detail } : { ok: false as const, detail }
    } finally {
      if (ctx.getActiveSearchAbortController() === searchAbort) {
        ctx.setActiveSearchAbortController(null)
      }
      if (!searchAbort.signal.aborted) {
        ctx.scheduleJobsProgressClear(startedAt)
      }
    }
  })

  handlers.set('jobs:smartScreen', async (payload) => {
    const smartScreenPayload = payload as {
      jobs: Array<{
        title: string
        company: string
        location: string
        jobUrl: string
        description?: string
        requirements?: string[]
      }>
      apiKey?: string | null
    } | undefined
    const jobs = Array.isArray(smartScreenPayload?.jobs) ? smartScreenPayload!.jobs : []
    if (jobs.length === 0) return { ok: false as const, detail: 'No jobs to screen.' }
    const settings = ctx.loadSettings()
    if (!hasUserProfile()) {
      const criteria = settings.userBackground?.trim() || settings.resumeText?.trim() || ''
      const result = await screenJobs(settings, criteria, jobs, smartScreenPayload?.apiKey, settings.resumeText)
      ctx.appendHistoryEvent({
        profileUrl: '',
        detail: 'smart_screen_completed',
        eventType: 'jobs_search',
        summary: `Screened ${result.results.length} jobs via AI (no structured profile).`,
        resultCount: result.results.length
      })
      return result
    }
    const profile = loadUserProfile()
    const ranked = rankJobsByFit(profile, jobs as JobPosting[])
    const results = ranked.map((j) => ({
      title: j.title,
      company: j.company,
      location: j.location,
      jobUrl: j.jobUrl,
      description: j.description,
      score: Math.round(j.heuristicScore.overall / 10),
      heuristicScore: j.heuristicScore,
      reason: j.heuristicScore.strengths.join('; ') || 'No strong signals.',
      nextStep:
        j.heuristicScore.recommendation === 'strong_fit'
          ? 'Apply directly'
          : j.heuristicScore.recommendation === 'good_fit'
            ? 'Research the team first'
            : ''
    }))
    ctx.appendHistoryEvent({
      profileUrl: '',
      detail: 'smart_screen_completed',
      eventType: 'jobs_search',
      summary: `Screened ${results.length} jobs via heuristic profile match.`,
      resultCount: results.length
    })
    return {
      ok: true as const,
      results,
      detail: 'heuristic_profile_match'
    }
  })

  return handlers
}
