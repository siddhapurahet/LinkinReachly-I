import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { cacheTabResults, getCachedTabResults, clearAllTabCaches } from '../tab-results-cache'
import type { JobSearchHistoryEntry } from '@core/job-search-history'
import {
  appendJobSearchHistory,
  mergeJobSearchHistoryLists,
  normalizeJobsSearchHistory
} from '@core/job-search-history'
import type {
  ApplicationRecord,
  ApplyQueueItem
} from '@core/application-types'
import { getLoa } from '@/loa-client'
import { isFeatureGated } from '@/hooks/usePlanState'
import {
  readJobsSearchLocal,
  writeJobsSearchLocal
} from '@/jobs-search-local'
import type { JobsSearchFiltersPersisted, SettingsView } from '@/types/app'
import type { SmartSearchProgress } from './jobs-smart-search-status'
import { parseLinkedInJobsUrl } from '@core/linkedin-url'
import { ApplicationAssistantPanel } from '@/features/apply/ApplicationAssistantPanel'

import type { JobListing, ScoredJob, JobsState } from './jobs/jobs-helpers'
import {
  DEFAULT_JOBS_SEARCH_FILTERS,
  MIN_SCORE_OPTIONS,
  INITIAL_VISIBLE_JOBS,
  VISIBLE_JOBS_AFTER_LOAD_MORE,
  applicationRecordForListedJob,
  jobSearchFiltersSignature,
  normalizeRecencySeconds,
  normalizeDistanceMiles,
  isLikelyPreloadMethodSkew,
  recentSearchPillLabel,
  jobSearchFieldKey,
  feedbackTone,
  mergePersistedJobSearchFields,
  toSmartSearchProgress,
  humanizeSearchError
} from './jobs/jobs-helpers'
import { JobsSearchProgress } from './jobs/JobsSearchProgress'
import { JobSearchFilters } from './jobs/JobSearchFilters'
import { JobCard } from './jobs/JobCard'
import { useApplyQueue } from './jobs/useApplyQueue'
import { ApplyQueueTile } from './jobs/ApplyQueueTile'

type Props = {
  aiConfigured: boolean
  chromeReady: boolean
  extensionConnected?: boolean
  resumeFileName?: string
  /** When false, wait before hydrating keyword/location from disk. */
  settingsReady?: boolean
  persistedJobKeywords?: string
  persistedJobLocation?: string
  persistedJobSearchFilters?: JobsSearchFiltersPersisted
  persistedJobSearchHistory?: JobSearchHistoryEntry[] | undefined
  /** Apply full settings snapshot after save (keeps in-memory model in sync when leaving Jobs). */
  onPublicSettings?: (next: SettingsView) => void
  initialSearch?: { keywords: string; location?: string } | null
  onSearchConsumed?: () => void
  /** Campaign tab: live smart-search progress (aside removed from Jobs). */
  onSmartSearchActivity?: (snapshot: { smartSearching: boolean; smartProgress: SmartSearchProgress | null } | null) => void
  onOpenProfile?: () => void
  profileCompletionPct?: number
  profileExpanded?: boolean
  /** Controlled active tab from parent (syncs with AppRail sidebar). */
  activeTab?: 'results' | 'queue'
  onActiveTabChange?: (tab: 'results' | 'queue') => void
  /** Current user plan for feature gating. */
  plan?: 'free' | 'plus'
  historyAppliedUrls?: Set<string>
  onExtSetupNeeded?: () => void
  onNavigateToSettings?: (section: 'answers' | 'limits') => void
  answerBankCount?: number
  reviewBeforeSubmit?: boolean
  applyDailyCap?: number
  appliedToday?: number
  applyCap?: number
  showFirstSessionGuide?: boolean
  onDismissGuide?: () => void
}

export function JobsPanel({
  aiConfigured,
  chromeReady,
  extensionConnected = false,
  resumeFileName,
  settingsReady = true,
  persistedJobKeywords = '',
  persistedJobLocation = '',
  persistedJobSearchFilters = DEFAULT_JOBS_SEARCH_FILTERS,
  persistedJobSearchHistory,
  onPublicSettings,
  initialSearch,
  onSearchConsumed,
  onSmartSearchActivity,
  onOpenProfile,
  profileCompletionPct,
  profileExpanded,
  activeTab: controlledTab,
  onActiveTabChange,
  plan = 'free',
  historyAppliedUrls,
  onExtSetupNeeded,
  onNavigateToSettings,
  answerBankCount,
  reviewBeforeSubmit,
  applyDailyCap,
  appliedToday,
  applyCap,
  showFirstSessionGuide,
  onDismissGuide
}: Props) {
  const [keywords, setKeywords] = useState('')
  const [location, setLocation] = useState('')
  const [criteria, setCriteriaRaw] = useState('')
  const criteriaPersistRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const criteriaSaveErrorRef = useRef<((msg: string) => void) | null>(null)
  useEffect(() => () => { if (criteriaPersistRef.current) clearTimeout(criteriaPersistRef.current) }, [])
  const setCriteria = useCallback((v: string) => {
    setCriteriaRaw(v)
    if (criteriaPersistRef.current) clearTimeout(criteriaPersistRef.current)
    criteriaPersistRef.current = setTimeout(() => {
      void getLoa().settingsSave({ jobsScreeningCriteria: v.slice(0, 2000) }).catch(() => {
        criteriaSaveErrorRef.current?.('Couldn\u2019t save screening criteria. Try saving again.')
      })
      if (v.length > 2000) setCriteriaRaw(v.slice(0, 2000))
    }, 600)
  }, [])

  useEffect(() => {
    if (!settingsReady) return
    void (async () => {
      try {
        const s = await getLoa().settingsGet() as { jobsScreeningCriteria?: string }
        if (s.jobsScreeningCriteria) {
          setCriteriaRaw(s.jobsScreeningCriteria)
          return
        }
        const full = await getLoa().settingsGet() as { userBackground?: string; resumeText?: string }
        const bg = full.userBackground?.trim()
        const resume = full.resumeText?.trim()
        if (bg) {
          setCriteriaRaw(bg.slice(0, 500))
        } else if (resume) {
          setCriteriaRaw(resume.slice(0, 500))
        }
      } catch { /* best effort */ }
    })()
  }, [settingsReady])
  const [minScore, setMinScore] = useState(1)
  const [sortBy, setSortBy] = useState<'score' | 'company' | 'title' | 'resumeMatch'>('resumeMatch')
  const [loadMoreBusy, setLoadMoreBusy] = useState(false)
  const [loadMorePhase, setLoadMorePhase] = useState<'navigate' | 'extract' | 'score' | null>(null)
  const [loadMoreMessage, setLoadMoreMessage] = useState<string | null>(null)
  const [smartSearchCancelPending, setSmartSearchCancelPending] = useState(false)
  const isOnboardingSearchRef = useRef(false)
  const [visibleJobCount, setVisibleJobCount] = useState(INITIAL_VISIBLE_JOBS)
  const [expandedJob, setExpandedJob] = useState<string | null>(null)
  const [filterText, setFilterText] = useState('')
  const [searchCompact, setSearchCompact] = useState(false)
  const [profilePct, setProfilePct] = useState(profileCompletionPct ?? 0)
  useEffect(() => { if (profileCompletionPct != null) setProfilePct(profileCompletionPct) }, [profileCompletionPct])

  const normalizeFilterSlice = useCallback((f: JobsSearchFiltersPersisted): JobsSearchFiltersPersisted => {
    const sortBy = f.jobsSearchSortBy === 'R' || f.jobsSearchSortBy === 'DD' ? f.jobsSearchSortBy : 'DD'
    return {
      jobsSearchRecencySeconds: normalizeRecencySeconds(f.jobsSearchRecencySeconds),
      jobsSearchSortBy: sortBy,
      jobsSearchDistanceMiles: normalizeDistanceMiles(f.jobsSearchDistanceMiles),
      jobsSearchExperienceLevels: [...f.jobsSearchExperienceLevels].sort(),
      jobsSearchJobTypes: [...f.jobsSearchJobTypes].sort(),
      jobsSearchRemoteTypes: [...f.jobsSearchRemoteTypes].sort(),
      jobsSearchSalaryFloor: Math.max(0, Math.min(9, Math.floor(f.jobsSearchSalaryFloor))),
      jobsSearchFewApplicants: !!f.jobsSearchFewApplicants,
      jobsSearchVerifiedOnly: !!f.jobsSearchVerifiedOnly,
      jobsSearchEasyApplyOnly: f.jobsSearchEasyApplyOnly !== false
    }
  }, [])

  const [jobFilters, setJobFilters] = useState<JobsSearchFiltersPersisted>(() =>
    normalizeFilterSlice({ ...DEFAULT_JOBS_SEARCH_FILTERS, ...persistedJobSearchFilters })
  )

  const jobFiltersPropsSigRef = useRef<string | null>(null)
  const jobFiltersArraySaveRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useLayoutEffect(() => {
    if (!settingsReady) return
    const fromProps = normalizeFilterSlice(persistedJobSearchFilters)
    const sig = jobSearchFiltersSignature(fromProps)
    if (jobFiltersPropsSigRef.current === sig) return
    jobFiltersPropsSigRef.current = sig
    setJobFilters(fromProps)
  }, [settingsReady, persistedJobSearchFilters, normalizeFilterSlice])

  const persistJobSearchFilterPatch = useCallback(
    async (patch: Partial<JobsSearchFiltersPersisted>) => {
      try {
        const next = (await getLoa().settingsSave(patch)) as SettingsView
        onPublicSettings?.(next)
      } catch {
        /* silently handled — filter UI state still matches local draft */
      }
    },
    [onPublicSettings]
  )

  const queueJobFiltersArraySave = useCallback(
    (
      key: 'jobsSearchExperienceLevels' | 'jobsSearchJobTypes' | 'jobsSearchRemoteTypes',
      sorted: string[]
    ) => {
      if (jobFiltersArraySaveRef.current) clearTimeout(jobFiltersArraySaveRef.current)
      jobFiltersArraySaveRef.current = setTimeout(() => {
        void persistJobSearchFilterPatch({ [key]: sorted })
      }, 180)
    },
    [persistJobSearchFilterPatch]
  )

  useEffect(() => {
    return () => {
      if (jobFiltersArraySaveRef.current) clearTimeout(jobFiltersArraySaveRef.current)
    }
  }, [])

  /** Wrapper for <JobSearchFilters> onFilterChange: update local state + persist. */
  const handleFilterChange = useCallback(
    (patch: Partial<JobsSearchFiltersPersisted>) => {
      setJobFilters((f) => ({ ...f, ...patch }))
      void persistJobSearchFilterPatch(patch)
    },
    [persistJobSearchFilterPatch]
  )

  /** Wrapper for <JobSearchFilters> onArrayFilterChange: update local state + debounced persist. */
  const handleArrayFilterChange = useCallback(
    (
      key: 'jobsSearchExperienceLevels' | 'jobsSearchJobTypes' | 'jobsSearchRemoteTypes',
      sorted: string[]
    ) => {
      setJobFilters((f) => ({ ...f, [key]: sorted }))
      queueJobFiltersArraySave(key, sorted)
    },
    [queueJobFiltersArraySave]
  )

  const [state, setState] = useState<JobsState>({
    searching: false,
    screening: false,
    smartSearching: false,
    smartProgress: null,
    listings: [],
    scored: [],
    searchError: null,
    screenError: null,
    hasSearched: false,
    hasScreened: false
  })
  // Tracks the currently active smart-search run so canceled runs cannot overwrite newer UI state.
  const smartSearchRunTokenRef = useRef(0)

  const [queueAllBusy, setQueueAllBusy] = useState(false)
  const [reachOutBusyUrl, setReachOutBusyUrl] = useState<string | null>(null)

  const [undoToast, setUndoToast] = useState<{ count: number; secondsLeft: number } | null>(null)
  const undoTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const undoCancelledRef = useRef(false)
  useEffect(() => () => { if (undoTimerRef.current) clearInterval(undoTimerRef.current) }, [])

  const [activeTabLocal, setActiveTabLocal] = useState<'results' | 'queue'>('results')
  const activeTab = controlledTab ?? activeTabLocal
  const setActiveTab = useCallback((tab: 'results' | 'queue') => {
    setActiveTabLocal(tab)
    onActiveTabChange?.(tab)
  }, [onActiveTabChange])

  // Sync from parent (e.g. AppRail sidebar click)
  useEffect(() => {
    if (controlledTab && controlledTab !== activeTabLocal) setActiveTabLocal(controlledTab)
  }, [controlledTab]) // eslint-disable-line react-hooks/exhaustive-deps
  const [tailoredResumes, setTailoredResumes] = useState<Map<string, { headline: string; summary: string }>>(new Map())
  const [tailoringJobUrl, setTailoringJobUrl] = useState<string | null>(null)
  const [queueFeedback, setQueueFeedback] = useState<string | null>(null)
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showFeedback = useCallback((msg: string, durationMs = 5000) => {
    const safeDuration = Math.max(durationMs, 800)
    setQueueFeedback(msg)
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current)
    feedbackTimerRef.current = setTimeout(() => setQueueFeedback(null), safeDuration)
  }, [])
  useEffect(() => () => { if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current) }, [])
  criteriaSaveErrorRef.current = showFeedback

  const queue = useApplyQueue(showFeedback, historyAppliedUrls)
  const {
    applyQueue, queuedJobUrls, appliedJobUrls, outreachSentUrls, setOutreachSentUrls,
    applyQueueOpenItems, queueStats, queueAriaAlert,
    startingQueue, retryingItemUrls, clearingQueue, retryingBulk, queuePausing,
    chainRunning, setChainRunning, chainStatus, setChainStatus,
    chainProgress, setChainProgress, chainDismissed, setChainDismissed,
    chainSkipping, setChainSkipping,
    syncQueueUrls, startQueue, stopQueue, clearQueue, retryFailed,
    removeQueueItem, retryQueueItem, markQueueItemDone
  } = queue

  const [optimisticQueued, setOptimisticQueued] = useState<Set<string>>(new Set())
  const effectiveQueuedUrls = useMemo(() => {
    if (optimisticQueued.size === 0) return queuedJobUrls
    return new Set([...queuedJobUrls, ...optimisticQueued])
  }, [queuedJobUrls, optimisticQueued])
  const [searchHistory, setSearchHistory] = useState<JobSearchHistoryEntry[]>([])

  const keywordsInputRef = useRef<HTMLInputElement>(null)
  const initialSearchConsumed = useRef(false)
  const hydratedJobSearchFields = useRef(false)
  const jobSearchPersistOk = useRef(false)
  /** True after the user types in keyword/location inputs (not pills or programmatic fills). */
  const userEditedJobSearchRef = useRef(false)
  /** Last jobs search fields applied from settings props — avoids clobbering local state. */
  const diskSyncedRef = useRef<string | null>(null)
  /** Set to true when a recent-search pill is clicked; consumed by a useEffect to trigger search after state settles. */
  const pillSearchTriggerRef = useRef(false)
  /** True once we've attempted to pre-fill keywords from the user's profile/background. */
  const resumeKeywordsFilled = useRef(false)
  const suppressAutoStartRef = useRef(false)

  /**
   * Restore keyword/location from disk-backed props before paint so the debounced persist
   * effect never sees an initial empty pair and wipes settings.json (hard refresh bug).
   */
  useLayoutEffect(() => {
    if (!settingsReady) return
    if (initialSearch) {
      hydratedJobSearchFields.current = true
      jobSearchPersistOk.current = true
      diskSyncedRef.current = jobSearchFieldKey(persistedJobKeywords, persistedJobLocation)
      return
    }
    const { keywords: mergedKw, location: mergedLoc } = mergePersistedJobSearchFields(
      persistedJobKeywords,
      persistedJobLocation
    )
    const key = jobSearchFieldKey(mergedKw, mergedLoc)
    if (!hydratedJobSearchFields.current) {
      hydratedJobSearchFields.current = true
      jobSearchPersistOk.current = true
      diskSyncedRef.current = key
      setKeywords(mergedKw)
      setLocation(mergedLoc)
      return
    }
    if (userEditedJobSearchRef.current) return
    if (diskSyncedRef.current === key) return
    diskSyncedRef.current = key
    setKeywords(mergedKw)
    setLocation(mergedLoc)
  }, [settingsReady, initialSearch, persistedJobKeywords, persistedJobLocation])

  /** Local draft immediately; settings.json debounced (survives hard refresh via both). */
  useEffect(() => {
    if (!jobSearchPersistOk.current) return
    if (initialSearch && !initialSearchConsumed.current) return
    writeJobsSearchLocal({
      keywords: keywords.slice(0, 800),
      location: location.slice(0, 800)
    })
    const handle = window.setTimeout(() => {
      void getLoa()
        .settingsSave({
          jobsSearchKeywords: keywords.slice(0, 800),
          jobsSearchLocation: location.slice(0, 800)
        })
        .catch(() => { /* debounced persist failed; local + jobs-search-local draft retained */ })
    }, 450)
    return () => window.clearTimeout(handle)
  }, [keywords, location, initialSearch])

  useEffect(() => {
    const flush = () => {
      if (!jobSearchPersistOk.current) return
      writeJobsSearchLocal({
        keywords: keywords.slice(0, 800),
        location: location.slice(0, 800)
      })
    }
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [keywords, location])

  useEffect(() => {
    if (!settingsReady) return
    const local = readJobsSearchLocal()
    const disk = normalizeJobsSearchHistory(persistedJobSearchHistory)
    const merged = mergeJobSearchHistoryLists(disk, local.history)
    setSearchHistory(merged)
    writeJobsSearchLocal({ history: merged })
  }, [settingsReady, persistedJobSearchHistory])

  /* Pre-fill keywords from user background when no keywords are persisted.
     Fires once after hydration; if the user already has keywords (typed or from disk) this is a no-op. */
  useEffect(() => {
    if (!settingsReady || resumeKeywordsFilled.current) return
    if (keywords.trim()) return // Already has keywords from persistence or user input
    resumeKeywordsFilled.current = true
    void (async () => {
      try {
        const full = await getLoa().settingsGet() as { userBackground?: string; resumeText?: string }
        const bg = full.userBackground?.trim() || full.resumeText?.trim() || ''
        if (!bg) return
        // Extract first line as keyword seed — typically a professional headline or title
        const firstLine = bg.split(/[\n\r]/)[0]?.trim() || ''
        // Use first line if it looks like a title (short, not a full paragraph)
        const candidate = firstLine.length <= 80
          ? firstLine
          : (firstLine.split(/[,;.]/)[0]?.trim() || firstLine.slice(0, 60).trim())
        if (candidate) {
          setKeywords(candidate)
        }
      } catch { /* best effort */ }
    })()
  }, [settingsReady, keywords])

  const persistSuccessfulJobSearch = useCallback(
    (kw: string, loc: string) => {
      setSearchHistory((prev) => {
        const next = appendJobSearchHistory(prev, kw, loc)
        writeJobsSearchLocal({ history: next })
        void getLoa()
          .settingsSave({ jobsSearchHistory: next })
          .then((raw) => {
            onPublicSettings?.(raw as SettingsView)
          })
          .catch(() => { /* history persist failed; local cache still updated */ })
        return next
      })
    },
    [onPublicSettings]
  )

  const clearJobSearchHistory = useCallback(() => {
    setSearchHistory([])
    writeJobsSearchLocal({ history: [] })
    void getLoa()
      .settingsSave({ jobsSearchHistory: [] })
      .then((raw) => {
        onPublicSettings?.(raw as SettingsView)
      })
      .catch(() => { /* clear history persist failed; local cache already empty */ })
  }, [onPublicSettings])

  type JobsSmartSearchResult = {
    ok: boolean
    canceled?: boolean
    detail?: string
    jobs?: Array<JobListing & { description?: string }>
    scored?: ScoredJob[]
    plan?: { queries: string[]; criteria: string; summary: string }
    queryResults?: Array<{ query: string; count: number }>
    enrichedCount?: number
    profileSource?: 'settings' | 'linkedin_profile' | 'none'
  }
  type JobsCancelSearchResult = {
    ok?: boolean
    canceled?: boolean
    detail?: string
    error?: string
  }

  const runJobsSmartSearch = useCallback(
    async (payload: {
      background: string
      location?: string
      cachedDescriptions?: Record<string, string>
      sourceUrl?: string
    }): Promise<JobsSmartSearchResult> => {
      const loa = getLoa() as { jobsSmartSearch: (params: typeof payload) => Promise<unknown> }
      return (await loa.jobsSmartSearch(payload)) as JobsSmartSearchResult
    },
    []
  )

  const searchJobs = useCallback(async () => {
    const kw = keywords.trim()
    if (!kw || state.smartSearching || state.searching) return

    // Detect if the user pasted a LinkedIn jobs URL instead of keywords
    const parsedUrl = parseLinkedInJobsUrl(kw)
    const isUrlSearch = parsedUrl.ok

    const runToken = ++smartSearchRunTokenRef.current
    setSmartSearchCancelPending(false)
    const startedAt = Date.now()
    setState((s) => ({
      ...s,
      searching: true,
      smartSearching: true,
      smartProgress: {
        phase: 'planning' as const,
        message: isUrlSearch ? 'Opening your LinkedIn link\u2026' : 'Planning search queries\u2026',
        startedAt,
        updatedAt: startedAt,
        queriesCompleted: 0
      },
      searchError: null,
      scored: [],
      hasSearched: false,
      hasScreened: false
    }))
    try {
      const queryKey = `jobs:${kw}:${location.trim()}`
      const cachedListings = getCachedTabResults<JobListing[]>(queryKey) ?? []
      const cachedDescriptions: Record<string, string> = {}
      for (const j of cachedListings) {
        if (j.jobUrl && j.description && j.description.length > 50) {
          cachedDescriptions[j.jobUrl] = j.description
        }
      }
      const smartPayload: {
        background: string
        location?: string
        cachedDescriptions?: Record<string, string>
        sourceUrl?: string
      } = isUrlSearch
        ? {
            background: '',
            sourceUrl: parsedUrl.normalizedUrl,
            cachedDescriptions: Object.keys(cachedDescriptions).length > 0 ? cachedDescriptions : undefined
          }
        : {
            background: kw + (location.trim() ? ` in ${location.trim()}` : ''),
            location: location.trim() || undefined,
            cachedDescriptions: Object.keys(cachedDescriptions).length > 0 ? cachedDescriptions : undefined
          }
      const res = await runJobsSmartSearch(smartPayload)
      if (runToken !== smartSearchRunTokenRef.current) return
      if (res.canceled) {
        setState((s) => ({ ...s, searching: false, smartSearching: false, smartProgress: null, searchError: null }))
        return
      }
      if (!res.ok) {
        setState((s) => ({
          ...s,
          searching: false,
          smartSearching: false,
          smartProgress: null,
          searchError: res.detail || 'We couldn\u2019t complete the search.',
          hasSearched: true
        }))
        return
      }
      persistSuccessfulJobSearch(kw, location.trim())
      void getLoa().trackEvent('Job Searched', { query: kw, location: location.trim(), result_count: (res.jobs || []).length }).catch(() => {})
      setVisibleJobCount(INITIAL_VISIBLE_JOBS)
      const cachedByUrl = new Map(cachedListings.filter((j) => j.jobUrl).map((j) => [j.jobUrl, j]))
      const fresh = (res.jobs || []) as ScoredJob[]
      const merged = fresh.map((j) => {
        const prev = j.jobUrl ? cachedByUrl.get(j.jobUrl) as Partial<ScoredJob> | undefined : undefined
        if (!prev) return j
        return {
          ...j,
          description: j.description || prev.description,
          score: j.score ?? prev.score
        }
      })
      cacheTabResults(queryKey, merged)
      setState((s) => ({
        ...s,
        searching: false,
        smartSearching: false,
        smartProgress: null,
        listings: merged,
        hasSearched: true
      }))
      setLoadMoreMessage(null)
    } catch (e) {
      if (runToken !== smartSearchRunTokenRef.current) return
      setState((s) => ({
        ...s,
        searching: false,
        smartSearching: false,
        smartProgress: null,
        searchError: e instanceof Error ? e.message : String(e),
        hasSearched: true
      }))
    }
  }, [keywords, location, persistSuccessfulJobSearch, runJobsSmartSearch, state.smartSearching, state.searching])

  const addJobToQueue = useCallback(async (job: ScoredJob | JobListing) => {
    const jobUrl = job.jobUrl
    if (!jobUrl) return
    if (!('easyApply' in job) || !job.easyApply) {
      showFeedback('Only LinkedIn Easy Apply jobs can be saved.')
      return
    }
    setOptimisticQueued(prev => new Set([...prev, jobUrl]))
    const item: ApplyQueueItem = {
      id: crypto.randomUUID(),
      jobTitle: job.title,
      company: job.company,
      location: job.location || '',
      linkedinJobUrl: jobUrl,
      applyUrl: ('applyUrl' in job && job.applyUrl && /\/jobs\/view\/\d+/.test(job.applyUrl)) ? job.applyUrl : jobUrl,
      surface: 'linkedin_easy_apply',
      status: 'pending',
      addedAt: new Date().toISOString(),
      descriptionSnippet: job.description?.slice(0, 200),
      reasonSnippet: ('reason' in job) ? (job as ScoredJob).reason : undefined
    }
    try {
      const r = await getLoa().applicationQueueAdd({ items: [item] })
      if (r.ok) {
        syncQueueUrls(r.state)
        setOptimisticQueued(prev => { const next = new Set(prev); next.delete(jobUrl); return next })
        if ((r.skippedAlreadyApplied ?? 0) > 0) {
          showFeedback('This job was already processed recently.')
        } else if ((r.skippedDuplicate ?? 0) > 0) {
          showFeedback('Already saved.')
        }
      } else {
        setOptimisticQueued(prev => { const next = new Set(prev); next.delete(jobUrl); return next })
        showFeedback('Couldn\u2019t save this job. Try again.')
      }
    } catch (e) {
      setOptimisticQueued(prev => { const next = new Set(prev); next.delete(jobUrl); return next })
      showFeedback(e instanceof Error ? e.message : 'Couldn\u2019t save that job.')
    }
  }, [syncQueueUrls, showFeedback])

  const handleTailorResume = useCallback(async (job: ScoredJob | JobListing) => {
    if (!job.jobUrl) return
    setTailoringJobUrl(job.jobUrl)
    setQueueFeedback(`Tailoring resume for ${job.title} at ${job.company}...`)
    try {
      const applicant = await getLoa().applicantGet()
      const currentHeadline = applicant.ok ? applicant.profile.basics.fullName : ''
      const currentSummary = applicant.ok ? (applicant.profile.background.educationSummary || '') : ''
      const result = await getLoa().tailorResume({
        currentHeadline,
        currentSummary,
        jobDescription: job.description || `${job.title} at ${job.company}`,
        jobTitle: job.title,
        company: job.company
      })
      if (result.ok && result.tailored) {
        setTailoredResumes((prev) => new Map(prev).set(job.jobUrl!, { headline: result.headline, summary: result.summary }))
        showFeedback(`Resume tailored for ${job.title}.`)
      } else {
        showFeedback('Couldn\u2019t tailor the resume right now. Try again in a moment.')
      }
    } catch (e) {
      showFeedback(e instanceof Error ? e.message : 'Couldn\u2019t tailor the resume.')
    }
    setTailoringJobUrl(null)
  }, [])

  const handleReachOut = useCallback(async (job: ScoredJob | JobListing) => {
    if (!job.jobUrl) return
    setReachOutBusyUrl(job.jobUrl)
    setQueueFeedback(`Finding hiring contacts at ${job.company}...`)
    try {
      let hiringTeam: ApplicationRecord['hiringTeam']
      let searchHint: string | undefined
      let matchedRec: ApplicationRecord | undefined
      const hist = await getLoa().applicationHistory()
      if (hist.ok && Array.isArray(hist.records)) {
        matchedRec = applicationRecordForListedJob(hist.records, job)
        hiringTeam = matchedRec?.hiringTeam
        searchHint = matchedRec?.hiringTeamSearchHint
      }

      const r = await getLoa().outreachSearchHiringManager({
        company: job.company,
        jobTitle: job.title,
        ...(searchHint ? { searchHint } : {}),
        ...(hiringTeam?.length ? { hiringTeam } : {})
      })
      if (r.ok && r.targets.length > 0) {
        const queueItem = applyQueue?.items.find(
          (i) => i.linkedinJobUrl === job.jobUrl && i.status === 'done' && i.applicationRecordId
        )
        const applicationRecordId = queueItem?.applicationRecordId ?? matchedRec?.id
        const targets = r.targets.slice(0, 1).map((t) => ({
          ...t,
          jobTitle: job.title,
          jobUrl: job.jobUrl,
          applicationRecordId
        }))
        showFeedback(`Sending connection invite to ${targets[0].firstName} at ${job.company}...`, 8000)
        const runResult = await getLoa().outreachRun({ targets })
        if (runResult.ok) {
          setOutreachSentUrls((prev) => new Set([...prev, job.jobUrl!]))
          showFeedback(`Connection invite sent to ${targets[0].firstName}.`)
        } else {
          showFeedback('Couldn\u2019t send the connection invite. Try again.')
        }
      } else {
        showFeedback(`No contacts found at ${job.company}.`)
      }
    } catch (e) {
      showFeedback(e instanceof Error ? e.message : 'Couldn\u2019t send that outreach.')
    } finally {
      setReachOutBusyUrl(null)
    }
  }, [applyQueue])

  const addAllToQueue = useCallback(async (jobs: Array<ScoredJob | JobListing>) => {
    const skipAutoStart = suppressAutoStartRef.current
    suppressAutoStartRef.current = false
    if (!jobs.length) return
    let clientSkippedQueued = 0
    let clientSkippedNotEasyApply = 0
    const items: ApplyQueueItem[] = jobs
      .filter((j) => {
        if (!j.jobUrl) return false
        if (queuedJobUrls.has(j.jobUrl)) { clientSkippedQueued++; return false }
        if (!('easyApply' in j && j.easyApply)) { clientSkippedNotEasyApply++; return false }
        return true
      })
      .map((job) => ({
        id: crypto.randomUUID(),
        jobTitle: job.title,
        company: job.company,
        location: job.location || '',
        linkedinJobUrl: job.jobUrl,
        applyUrl: ('applyUrl' in job && job.applyUrl && /\/jobs\/view\/\d+/.test(job.applyUrl)) ? job.applyUrl : job.jobUrl,
        surface: 'linkedin_easy_apply' as const,
        status: 'pending' as const,
        addedAt: new Date().toISOString(),
        descriptionSnippet: job.description?.slice(0, 200),
        reasonSnippet: ('reason' in job) ? (job as ScoredJob).reason : undefined,
        postedDate: job.postedDate,
        matchScore: ('score' in job) ? (job as ScoredJob).score : undefined
      }))
    if (!items.length) {
      const parts: string[] = []
      if (clientSkippedQueued > 0) parts.push(`${clientSkippedQueued} already saved`)
      if (clientSkippedNotEasyApply > 0) parts.push(`${clientSkippedNotEasyApply} not Easy Apply`)
      showFeedback(parts.length ? `No new jobs to add: ${parts.join(', ')}.` : 'All visible jobs are already saved.')
      return
    }
    setQueueAllBusy(true)
    try {
      const r = await getLoa().applicationQueueAdd({ items })
      if (r.ok) {
        syncQueueUrls(r.state)
        const added = r.added ?? items.length
        void getLoa().trackEvent('Jobs Queued', { count: added, total_items: items.length }).catch(() => {})
        const serverSkippedApplied = r.skippedAlreadyApplied ?? 0
        const serverSkippedDup = r.skippedDuplicate ?? 0
        const totalSkipped = serverSkippedApplied + serverSkippedDup + clientSkippedQueued + clientSkippedNotEasyApply
        let msg = `${added} job${added === 1 ? '' : 's'} added`
        if (totalSkipped > 0) {
          const parts: string[] = []
          const inQueue = serverSkippedDup + clientSkippedQueued
          if (serverSkippedApplied > 0) parts.push(`${serverSkippedApplied} already processed`)
          if (inQueue > 0) parts.push(`${inQueue} already saved`)
          if (clientSkippedNotEasyApply > 0) parts.push(`${clientSkippedNotEasyApply} not Easy Apply`)
          msg += ` · ${parts.join(', ')}`
        }
        if (skipAutoStart) {
          msg = msg.replace('added', 'saved to Ready to apply')
        }
        showFeedback(msg)
        if (added > 0 && !applyQueue?.running && !skipAutoStart) {
          undoCancelledRef.current = false
          setUndoToast({ count: added, secondsLeft: 5 })
          if (undoTimerRef.current) clearInterval(undoTimerRef.current)
          let ticks = 5
          undoTimerRef.current = setInterval(() => {
            ticks--
            if (undoCancelledRef.current || ticks <= 0) {
              if (undoTimerRef.current) clearInterval(undoTimerRef.current)
              undoTimerRef.current = null
              setUndoToast(null)
              if (!undoCancelledRef.current) {
                void startQueue()
              }
              return
            }
            setUndoToast({ count: added, secondsLeft: ticks })
          }, 1000)
        }
      } else {
        showFeedback('Couldn\u2019t save jobs. Try again.')
      }
    } catch (e) {
      showFeedback(e instanceof Error ? e.message : 'Couldn\u2019t save jobs.')
    } finally {
      setQueueAllBusy(false)
    }
  }, [applyQueue, queuedJobUrls, showFeedback, startQueue, syncQueueUrls])

  useEffect(() => {
    const loa = getLoa()
    if (typeof loa.onJobsProgress !== 'function') return
    return loa.onJobsProgress((progress) => {
      if (!progress) return
      setState((s) => {
        if (!s.smartSearching) return s
        return {
          ...s,
          smartProgress: toSmartSearchProgress(progress)
        }
      })
    })
  }, [])

  useEffect(() => {
    if (!onSmartSearchActivity) return
    if (!state.smartSearching && !state.smartProgress) {
      onSmartSearchActivity(null)
      return
    }
    onSmartSearchActivity({
      smartSearching: state.smartSearching,
      smartProgress: state.smartProgress
    })
  }, [state.smartSearching, state.smartProgress, onSmartSearchActivity])

  useEffect(() => {
    return () => {
      onSmartSearchActivity?.(null)
    }
  }, [onSmartSearchActivity])

  useEffect(() => {
    if (state.smartSearching || state.searching) return
    setSmartSearchCancelPending(false)
  }, [state.searching, state.smartSearching])

  const cancelSmartSearch = useCallback(async () => {
    const searchActive = state.searching || state.smartSearching
    if (!searchActive || smartSearchCancelPending) return
    const cancelToken = ++smartSearchRunTokenRef.current
    setSmartSearchCancelPending(true)
    setState((s) => ({
      ...s,
      searching: false,
      smartSearching: false,
      smartProgress: null,
      searchError: null
    }))
    try {
      const loa = getLoa() as { jobsCancelSearch?: () => Promise<unknown> }
      if (typeof loa.jobsCancelSearch === 'function') {
        const raw = await loa.jobsCancelSearch()
        if (cancelToken !== smartSearchRunTokenRef.current) return
        const result = (raw && typeof raw === 'object') ? (raw as JobsCancelSearchResult) : null
        const detail =
          typeof result?.error === 'string' && result.error
            ? result.error
            : typeof result?.detail === 'string' && result.ok === false
              ? result.detail
              : null
        if (detail) {
          setState((s) => ({
            ...s,
            searchError: detail
          }))
        }
      } else {
        setState((s) => ({
          ...s,
          searchError: 'Cancel is not available in this build. Update the desktop app.'
        }))
      }
    } catch (e) {
      if (cancelToken !== smartSearchRunTokenRef.current) return
      setState((s) => ({
        ...s,
        searchError: e instanceof Error ? e.message : String(e)
      }))
    } finally {
      if (cancelToken !== smartSearchRunTokenRef.current) return
      setSmartSearchCancelPending(false)
    }
  }, [smartSearchCancelPending, state.searching, state.smartSearching])

  useEffect(() => {
    if (!initialSearch) {
      initialSearchConsumed.current = false
      return undefined
    }
    if (!chromeReady || initialSearchConsumed.current) return undefined
    initialSearchConsumed.current = true
    isOnboardingSearchRef.current = true
    userEditedJobSearchRef.current = false
    setKeywords(initialSearch.keywords)
    if (initialSearch.location) setLocation(initialSearch.location)
    onSearchConsumed?.()
    let cancelled = false
    const doSmartSearch = async () => {
      const runToken = ++smartSearchRunTokenRef.current
      setSmartSearchCancelPending(false)
      const startedAt = Date.now()
      setVisibleJobCount(INITIAL_VISIBLE_JOBS)
      setState((s) => ({
        ...s,
        smartSearching: true,
        smartProgress: {
          phase: 'planning',
          message: 'AI is analyzing your description and planning searches\u2026',
          startedAt,
          updatedAt: startedAt,
          queriesCompleted: 0
        },
        searching: false,
        searchError: null,
        scored: [],
        listings: [],
        hasSearched: false,
        hasScreened: false
      }))
      try {
        const res = await runJobsSmartSearch({
          background: initialSearch.keywords,
          location: initialSearch.location
        })
        if (cancelled || runToken !== smartSearchRunTokenRef.current) return
        if (!res.ok) {
          const canceledRes = !!(res as { canceled?: boolean }).canceled
          setState((s) => ({
            ...s,
            smartSearching: false,
            smartProgress: null,
            searchError: canceledRes ? null : res.detail || 'We couldn\u2019t complete the search.',
            hasSearched: !canceledRes
          }))
          return
        }
        if (res.plan?.criteria) setCriteria(res.plan.criteria)
        const enrichedMsg = res.enrichedCount && res.enrichedCount > 0
          ? ` Read full descriptions for ${res.enrichedCount} jobs.`
          : ''
        if (cancelled || runToken !== smartSearchRunTokenRef.current) return
        persistSuccessfulJobSearch(initialSearch.keywords, initialSearch.location ?? '')
        void getLoa().trackEvent('Job Searched', { query: initialSearch.keywords, location: initialSearch.location ?? '', result_count: (res.jobs || []).length, source: 'onboarding' }).catch(() => {})
        setVisibleJobCount(INITIAL_VISIBLE_JOBS)
        const smartListings = (res.jobs || []) as JobListing[]
        setState((s) => ({
          ...s,
          smartSearching: false,
          smartProgress: {
            phase: 'done',
            message: (res.plan?.summary || 'Search complete.') + enrichedMsg,
            backgroundSource: res.profileSource,
            startedAt: s.smartProgress?.startedAt ?? startedAt,
            updatedAt: Date.now(),
            queriesPlanned: res.plan?.queries,
            queriesCompleted: res.queryResults?.length,
            totalQueries: res.plan?.queries?.length,
            totalJobsFound: res.jobs?.length,
            enrichingCompleted: res.enrichedCount,
            screeningCount: res.jobs?.length
          },
          listings: smartListings,
          scored: (res.scored || []).map(sj => {
            const source = smartListings.find(j => j.jobUrl === sj.jobUrl)
            return source?.description ? { ...sj, description: source.description } : sj
          }),
          hasSearched: true,
          hasScreened: !!(res.scored && res.scored.length > 0)
        }))
      } catch (e) {
        if (cancelled || runToken !== smartSearchRunTokenRef.current) return
        setState((s) => ({
          ...s,
          smartSearching: false,
          smartProgress: null,
          searchError: e instanceof Error ? e.message : String(e),
          hasSearched: true
        }))
      }
    }
    void doSmartSearch()
    return () => {
      cancelled = true
    }
  }, [initialSearch, chromeReady, onSearchConsumed, persistSuccessfulJobSearch, runJobsSmartSearch])

  // Auto-queue top matches after onboarding-triggered smart search completes
  useEffect(() => {
    if (!isOnboardingSearchRef.current) return
    if (state.smartSearching || !state.hasScreened) return
    if (state.scored.length === 0) return
    isOnboardingSearchRef.current = false

    const topMatches = state.scored
      .filter((j) => j.easyApply && j.jobUrl)
      .slice(0, 5)
    if (topMatches.length === 0) return

    void getLoa().trackOnboarding('onboarding_auto_queue', { count: topMatches.length }).catch(() => {})
    void addAllToQueue(topMatches).then(() => {
      setActiveTab('queue')
    })
  }, [state.smartSearching, state.hasScreened, state.scored, addAllToQueue, setActiveTab])


  /* When a recent-search pill is clicked, keywords/location are set via setState which is
     async.  This effect waits for React to flush those updates and then fires searchJobs
     exactly once (the ref flag is consumed immediately). */
  useEffect(() => {
    if (!pillSearchTriggerRef.current) return
    if (!chromeReady || state.searching || state.smartSearching) return
    if (!keywords.trim()) return
    pillSearchTriggerRef.current = false
    void searchJobs()
  }, [keywords, location, chromeReady, state.searching, state.smartSearching, searchJobs])

  /* Auto-search on first land was removed: it could re-fire on HMR remounts and
     dev-mode component-tree churn, repeatedly triggering long LinkedIn searches
     the user didn't ask for. Users now explicitly click Find Jobs. */
  useEffect(() => {
    if (state.hasSearched && state.listings.length > 0 && !state.searching && !state.smartSearching) {
      setSearchCompact(true)
    }
  }, [state.hasSearched, state.listings.length, state.searching, state.smartSearching])

  const screenJobs = useCallback(async () => {
    const c = criteria.trim()
    if (!c || state.listings.length === 0) return
    const screenStart = Date.now()
    setState((s) => ({ ...s, screening: true, screenError: null }))
    try {
      const res = (await getLoa().jobsScreen({
        criteria: c,
        jobs: state.listings,
      })) as { ok: boolean; results?: ScoredJob[]; detail?: string }
      const elapsed = Date.now() - screenStart
      if (elapsed < 600) await new Promise((r) => setTimeout(r, 600 - elapsed))
      if (!res.ok) {
        setState((s) => ({
          ...s,
          screening: false,
          screenError: res.detail || 'AI screening didn\u2019t finish.'
        }))
        return
      }
      const isLlmFallback = res.detail === 'no_api_key' || res.detail === 'llm_disabled'
      setState((s) => ({
        ...s,
        screening: false,
        scored: res.results || [],
        hasScreened: true,
        screenError: isLlmFallback
          ? 'No API key — showing default scores. Add a key in Settings for AI-powered screening.'
          : null
      }))
      if (!isLlmFallback) {
        setQueueFeedback(`Scored ${(res.results || []).length} jobs with AI. Sort by "AI score" to see results.`)
      }
    } catch (e) {
      setState((s) => ({
        ...s,
        screening: false,
        screenError: e instanceof Error ? e.message : String(e)
      }))
    }
  }, [criteria, state.listings])

  const loadMoreJobListings = useCallback(async () => {
    if (!chromeReady || state.listings.length === 0 || state.searching) return
    const loa = getLoa() as { jobsLoadMoreJobListings?: (p: unknown) => Promise<unknown> }
    if (typeof loa.jobsLoadMoreJobListings !== 'function') {
      setLoadMoreMessage('Update the app to load more listings from the same LinkedIn page.')
      return
    }
    setVisibleJobCount(VISIBLE_JOBS_AFTER_LOAD_MORE)
    setLoadMoreBusy(true)
    setLoadMorePhase('navigate')
    setLoadMoreMessage(null)
    try {
      setLoadMorePhase('extract')
      const res = (await loa.jobsLoadMoreJobListings({
        existingJobUrls: state.listings.map((j) => j.jobUrl).filter(Boolean),
        keywords: keywords.trim(),
        location: location.trim() || undefined
      })) as { ok: boolean; jobs?: JobListing[]; detail?: string }
      if (!res.ok) {
        setLoadMoreMessage(res.detail || 'Could not load more listings.')
        return
      }
      const newJobs = res.jobs || []
      if (newJobs.length === 0) {
        setLoadMoreMessage(
          `No more results found on LinkedIn for this search. You've loaded all ${state.listings.length} available listings.`
        )
        return
      }
      let appendedCount = 0
      let totalCount = 0
      setState((s) => {
        const seen = new Set(s.listings.map((j) => j.jobUrl).filter(Boolean))
        const merged = [...s.listings]
        const appended: JobListing[] = []
        for (const j of newJobs) {
          if (!j.jobUrl || seen.has(j.jobUrl)) continue
          seen.add(j.jobUrl)
          merged.push(j)
          appended.push(j)
        }
        appendedCount = appended.length
        totalCount = merged.length
        if (appended.length === 0) {
          return { ...s, listings: merged }
        }
        if (!s.hasScreened) {
          return { ...s, listings: merged }
        }
        const scoredUrls = new Set(s.scored.map((x) => x.jobUrl).filter(Boolean))
        const stubs: ScoredJob[] = appended
          .filter((j) => j.jobUrl && !scoredUrls.has(j.jobUrl))
          .map((j) => ({
            ...j,
            score: 5,
            titleFit: 5,
            seniorityMatch: 5,
            locationFit: 5,
            companyFit: 5,
            reason:
              'Added after your last AI screening — run "Screen with AI" again if you want a fresh score for new rows.',
            nextStep: ''
          }))
        return { ...s, listings: merged, scored: [...s.scored, ...stubs] }
      })
      if (appendedCount === 0) {
        setLoadMoreMessage(`No more results found on LinkedIn for this search. You've loaded all ${totalCount} available listings.`)
      } else {
        setLoadMoreMessage(`Loaded ${appendedCount} more listing${appendedCount === 1 ? '' : 's'} (${totalCount} total).`)
        setTimeout(() => setLoadMoreMessage(null), 5000)
      }
    } catch (e) {
      setLoadMoreMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setLoadMoreBusy(false)
      setLoadMorePhase(null)
    }
  }, [chromeReady, state.listings, state.searching, state.hasScreened, keywords, location])

  const clearAllResults = useCallback(() => {
    clearAllTabCaches('jobs:')
    setState((s) => ({
      ...s,
      listings: [],
      scored: [],
      hasSearched: false,
      hasScreened: false,
      searchError: null,
      screenError: null
    }))
    setVisibleJobCount(INITIAL_VISIBLE_JOBS)
    setFilterText('')
    setLoadMoreMessage(null)
  }, [])

  useEffect(() => {
    if (state.hasScreened || !state.hasSearched) return
    const anyResume = state.listings.some((j) => j.resumeMatchPercent != null)
    if (!anyResume && sortBy === 'resumeMatch') setSortBy('title')
  }, [state.hasScreened, state.hasSearched, state.listings, sortBy])

  const displayJobs = useMemo(() => {
    const listingByUrl = new Map<string, JobListing>()
    for (const j of state.listings) {
      if (j.jobUrl) listingByUrl.set(j.jobUrl, j)
    }

    const source: ScoredJob[] = state.hasScreened
      ? state.scored.map((sj) => {
          const listing = sj.jobUrl ? listingByUrl.get(sj.jobUrl) : undefined
          if (!listing) return sj
          return {
            ...sj,
            resumeMatchPercent: listing.resumeMatchPercent ?? sj.resumeMatchPercent,
            resumeMatchReason: listing.resumeMatchReason ?? sj.resumeMatchReason,
            easyApply: listing.easyApply ?? sj.easyApply
          }
        })
      : state.listings.map((j) => ({ ...j, score: 0, reason: '' }))

    const ft = filterText.toLowerCase().trim()
    let filtered = state.hasScreened
      ? source.filter((j) => j.score >= minScore)
      : source

    if (ft) {
      filtered = filtered.filter((j) =>
        j.title.toLowerCase().includes(ft) ||
        j.company.toLowerCase().includes(ft) ||
        j.location.toLowerCase().includes(ft)
      )
    }

    return [...filtered].sort((a, b) => {
      if (state.hasScreened) {
        if (sortBy === 'resumeMatch') {
          const byResume = (b.resumeMatchPercent ?? -1) - (a.resumeMatchPercent ?? -1)
          if (byResume !== 0) return byResume
          return b.score - a.score
        }
        if (sortBy === 'score') return b.score - a.score
        if (sortBy === 'company') return a.company.localeCompare(b.company)
        return a.title.localeCompare(b.title)
      }
      if (sortBy === 'resumeMatch') {
        const byResume = (b.resumeMatchPercent ?? -1) - (a.resumeMatchPercent ?? -1)
        if (byResume !== 0) return byResume
        return a.title.localeCompare(b.title)
      }
      if (sortBy === 'score') return b.score - a.score
      if (sortBy === 'company') return a.company.localeCompare(b.company)
      return a.title.localeCompare(b.title)
    })
  }, [state.scored, state.listings, state.hasScreened, minScore, sortBy, filterText])

  const visibleDisplayJobs = useMemo(
    () => displayJobs.slice(0, visibleJobCount),
    [displayJobs, visibleJobCount]
  )

  const hasResumeMatchRanking = state.listings.some((j) => j.resumeMatchPercent != null)

  const searchErrorLikelyBuildSkew = isLikelyPreloadMethodSkew(state.searchError)
  const showJobsScreeningTile = state.hasSearched && state.listings.length > 0

  /** JobCard feedback handler: updates scored jobs' userFeedback field. */
  const handleJobFeedback = useCallback(
    (jobUrl: string, feedback: 'positive' | 'negative' | undefined) => {
      setState((prev) => ({
        ...prev,
        scored: prev.scored.map((j) =>
          j.jobUrl === jobUrl ? { ...j, userFeedback: feedback } : j
        )
      }))
    },
    []
  )

  /** JobCard expand/collapse toggle. */
  const handleToggleExpand = useCallback(
    (key: string) => {
      setExpandedJob((prev) => (prev === key ? null : key))
    },
    []
  )

  const handleRunChain = useCallback(async () => {
    setChainRunning(true)
    setChainStatus('')
    setChainProgress('')
    try {
      const res = await getLoa().outreachRunChain({})
      setChainStatus(res.detail)
      if (res.results && res.results.length > 0) {
        setOutreachSentUrls((prev) => {
          const next = new Set(prev)
          for (const r of res.results) {
            if (r.jobUrl) next.add(r.jobUrl)
          }
          return next
        })
      }
    } catch (err) {
      setChainStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setChainRunning(false)
    }
  }, [setChainRunning, setChainStatus, setChainProgress, setOutreachSentUrls])

  const handleSkipChain = useCallback(async () => {
    setChainSkipping(true)
    setChainDismissed(true)
    try {
      const res = await getLoa().outreachCandidates()
      if (res.ok) {
        let failed = 0
        for (const c of res.candidates) {
          try {
            await getLoa().outreachSkip({ applicationRecordId: c.applicationRecordId })
          } catch { failed++ }
        }
        if (failed > 0) {
          setChainStatus(`Skipped with ${failed} error${failed === 1 ? '' : 's'}. Some may reappear.`)
        }
      }
    } catch {
      setChainStatus('Could not skip outreach. Try again later.')
    } finally { setChainSkipping(false) }
  }, [setChainSkipping, setChainDismissed, setChainStatus])

  const handleDismissChainStatus = useCallback(() => {
    setChainStatus('')
    setChainDismissed(true)
  }, [setChainStatus, setChainDismissed])

  const handleSwitchToResults = useCallback(() => {
    setActiveTab('results')
    keywordsInputRef.current?.focus()
  }, [])

  const applyQueueTile = applyQueue ? (
    <ApplyQueueTile
      applyQueue={applyQueue}
      queueStats={queueStats}
      applyQueueOpenItems={applyQueueOpenItems}
      queueAriaAlert={queueAriaAlert}
      chromeReady={chromeReady}
      resumeFileName={resumeFileName}
      startingQueue={startingQueue}
      retryingItemUrls={retryingItemUrls}
      clearingQueue={clearingQueue}
      retryingBulk={retryingBulk}
      queuePausing={queuePausing}
      chainRunning={chainRunning}
      chainStatus={chainStatus}
      chainProgress={chainProgress}
      chainDismissed={chainDismissed}
      chainSkipping={chainSkipping}
      outreachSentUrls={outreachSentUrls}
      appliedJobUrls={appliedJobUrls}
      onStartQueue={() => void startQueue()}
      onStopQueue={() => void stopQueue()}
      onClearQueue={() => void clearQueue()}
      onRetryFailed={() => void retryFailed()}
      onRemoveItem={(id) => void removeQueueItem(id)}
      onRetryItem={(id) => void retryQueueItem(id)}
      onMarkItemDone={(id) => void markQueueItemDone(id)}
      onRunChain={() => void handleRunChain()}
      onSkipChain={() => void handleSkipChain()}
      onDismissChainStatus={handleDismissChainStatus}
      onSwitchToResults={handleSwitchToResults}
      onExtSetupNeeded={onExtSetupNeeded}
      onNavigateToSettings={onNavigateToSettings}
      answerBankCount={answerBankCount}
      reviewBeforeSubmit={reviewBeforeSubmit}
      applyDailyCap={applyDailyCap}
      appliedToday={appliedToday}
      applyCap={applyCap}
      showFirstSessionGuide={showFirstSessionGuide}
      onDismissGuide={onDismissGuide}
      setFeedback={showFeedback}
    />
  ) : (
    <div className="jobs-queue-panel--empty empty-state">
      <div className="empty-state__icon" aria-hidden="true">{'\u2261'}</div>
      <h3 className="empty-state__title">Ready to apply</h3>
      <p className="empty-state__body muted caption">
        No jobs saved yet.
      </p>
      <button type="button" className="link-button empty-state__action" onClick={handleSwitchToResults}>
        Switch to Results to add jobs
      </button>
    </div>
  )

  return (
    <div className="wizard jobs-panel jobs-panel--bento jobs-v5">
      <div className="wizard-card wizard-card--in-surface">
        <header className="jobs-panel__header">
        </header>
        <p id="jobs-keywords-hint" className="sr-only">
          Enter job title, keywords, or a LinkedIn jobs URL to search.
        </p>
        <p id="jobs-chrome-hint" className="sr-only">
          Connect Chrome with the LinkinReachly extension to enable job search.
        </p>

        {activeTab !== 'queue' && !chromeReady && (
          <div className="ext-setup-card" role="alert" style={{ marginBottom: 'var(--space-3)', padding: 'var(--space-5, 2rem)', borderRadius: 'var(--radius-lg, 12px)', background: 'var(--surface-raised, var(--desk-200))', border: '1px solid var(--border-subtle, var(--desk-300))', minHeight: '320px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
            {extensionConnected ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' }}>
                  <strong style={{ fontSize: '1.05rem' }}>Extension connected {'\u2014'} open LinkedIn</strong>
                </div>
                <p style={{ margin: '0 0 var(--space-3)', color: 'var(--ink-secondary, var(--ink-600))', lineHeight: 1.5 }}>
                  Open <strong>linkedin.com</strong> in the same Chrome window where the extension is active. The header will turn green when ready.
                </p>
              </>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-3)' }}>
                  <strong style={{ fontSize: '1.05rem' }}>Connect LinkinReachly to Chrome</strong>
                </div>
                <p style={{ margin: '0 0 var(--space-3)', color: 'var(--ink-secondary, var(--ink-600))', lineHeight: 1.5 }}>
                  LinkinReachly works through a Chrome extension that connects to LinkedIn for you. Follow these steps once {'\u2014'} it takes about 2 minutes.
                </p>
                <ol style={{ margin: '0 0 var(--space-3)', paddingLeft: 'var(--space-4)', lineHeight: 2, color: 'var(--ink-primary, var(--ink-800))' }}>
                  <li style={{ marginBottom: 'var(--space-1)' }}>
                    <button type="button" className="btn btn-primary btn-sm" style={{ verticalAlign: 'middle' }} onClick={() => void getLoa().openExtensionFolder()}>
                      Open extension folder
                    </button>
                    <span style={{ color: 'var(--ink-tertiary, var(--ink-500))', marginLeft: 'var(--space-2)', fontSize: '0.85em' }}>(this reveals the folder you{'\u2019'}ll add to Chrome)</span>
                  </li>
                  <li style={{ marginBottom: 'var(--space-1)' }}>
                    In Chrome, go to <code style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: '0.9em', background: 'var(--surface-sunken, var(--desk-100))', padding: '2px 6px', borderRadius: 4 }}>chrome://extensions</code> and flip the <strong>Developer mode</strong> toggle (top-right corner).
                  </li>
                  <li style={{ marginBottom: 'var(--space-1)' }}>Click <strong>Load unpacked</strong> and pick the folder from step 1.</li>
                  <li>Open <strong>linkedin.com</strong> in Chrome.</li>
                </ol>
              </>
            )}
            <div style={{ padding: 'var(--space-2) var(--space-3)', borderRadius: 'var(--radius-md, 8px)', background: 'var(--surface-sunken, var(--desk-100))', display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: extensionConnected ? 'var(--amber-500)' : 'var(--ink-disabled, var(--ink-400))', flexShrink: 0 }} />
              <span style={{ color: extensionConnected ? 'var(--amber-700)' : 'var(--ink-tertiary, var(--ink-500))' }}>
                {extensionConnected ? 'Extension connected \u2014 waiting for LinkedIn tab' : 'Waiting for extension connection\u2026'}

              </span>
            </div>
          </div>
        )}

        {activeTab !== 'queue' && extensionConnected && (searchCompact ? (
          <div className="jobs-search-compact">
            <span
              className="jobs-search-compact__param"
              role="button"
              tabIndex={0}
              title="Click to edit keywords"
              onClick={() => { setSearchCompact(false); setTimeout(() => keywordsInputRef.current?.focus(), 50) }}
              onKeyDown={(e) => { if (e.key === 'Enter') { setSearchCompact(false); setTimeout(() => keywordsInputRef.current?.focus(), 50) } }}
            >
              {keywords || 'Any job'}
            </span>
            <span className="jobs-search-compact__sep">{'\u00B7'}</span>
            <span
              className="jobs-search-compact__param"
              role="button"
              tabIndex={0}
              title="Click to edit location"
              onClick={() => { setSearchCompact(false); setTimeout(() => document.getElementById('jobs-location')?.focus(), 50) }}
              onKeyDown={(e) => { if (e.key === 'Enter') { setSearchCompact(false); setTimeout(() => document.getElementById('jobs-location')?.focus(), 50) } }}
            >
              {location || 'Anywhere'}
            </span>
            <span className="jobs-search-compact__sep">{'\u00B7'}</span>
            <span className="jobs-search-compact__count">
              {displayJobs.length} result{displayJobs.length === 1 ? '' : 's'}
            </span>
            <div className="jobs-search-compact__actions">
              {showJobsScreeningTile && !state.screening && (
                <span
                  className={`jobs-search-compact__pill ${state.hasScreened ? 'jobs-search-compact__pill--active' : 'jobs-search-compact__pill--inactive'}`}
                  role="button"
                  tabIndex={0}
                  title={
                    state.hasScreened
                      ? 'AI screening active — click to re-screen'
                      : criteria.trim()
                        ? 'Score jobs with AI against your criteria'
                        : 'Add criteria below, then click to score jobs with AI'
                  }
                  onClick={() => {
                    if (state.hasScreened || !criteria.trim()) {
                      // No criteria yet (or already screened) — open the form so they can edit
                      const el = document.querySelector('.jobs-screening-collapsible') as HTMLDetailsElement | null
                      if (el) {
                        el.open = true
                        el.scrollIntoView({ behavior: 'smooth', block: 'start' })
                        const ta = el.querySelector('#jobs-criteria') as HTMLTextAreaElement | null
                        if (ta) setTimeout(() => ta.focus(), 250)
                      }
                      return
                    }
                    void screenJobs()
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      (e.currentTarget as HTMLElement).click()
                      e.preventDefault()
                    }
                  }}
                >
                  {state.hasScreened ? '\u25A0' : '\u25CB'} Screen
                </span>
              )}
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                onClick={() => { setSearchCompact(false); setTimeout(() => keywordsInputRef.current?.focus(), 50) }}
              >
                Edit search
              </button>
            </div>
          </div>
        ) : (
          <div className="jobs-bento__workspace">
            <div className="jobs-bento__tile jobs-bento__search">
              <div className="jobs-search-bar j-search">
                <div className="jobs-search-bar__row">
                  <div className="jobs-search-bar__field jobs-search-bar__field--wide">
                    <label className="fl" htmlFor="jobs-keywords">Job title, keywords, or LinkedIn URL</label>
                    <input
                      ref={keywordsInputRef}
                      id="jobs-keywords"
                      className="inp inp-lg"
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      value={keywords}
                      onChange={(e) => {
                        userEditedJobSearchRef.current = true
                        setKeywords(e.target.value)
                      }}
                      placeholder="e.g. software engineer or paste a LinkedIn jobs URL"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void searchJobs()
                      }}
                    />
                  </div>
                  <div className="jobs-search-bar__field">
                    <label className="fl" htmlFor="jobs-location">Location</label>
                    <input
                      id="jobs-location"
                      className="inp inp-lg"
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      value={location}
                      onChange={(e) => {
                        userEditedJobSearchRef.current = true
                        setLocation(e.target.value)
                      }}
                      placeholder="e.g. San Francisco"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void searchJobs()
                      }}
                    />
                  </div>
                  <button
                    type="button"
                    className="btn btn-primary btn-lg"
                    disabled={smartSearchCancelPending || (!(state.searching || state.smartSearching) && (!keywords.trim() || !chromeReady))}
                    aria-describedby={
                      !keywords.trim() ? 'jobs-keywords-hint'
                      : !chromeReady ? 'jobs-chrome-hint'
                      : undefined
                    }
                    title={
                      !(state.searching || state.smartSearching) && !chromeReady
                        ? 'Connect Chrome to search'
                        : !(state.searching || state.smartSearching) && !keywords.trim()
                          ? 'Enter keywords to search'
                          : undefined
                    }
                    onClick={() => (state.searching || state.smartSearching) ? void cancelSmartSearch() : void searchJobs()}
                  >
                    {state.searching || state.smartSearching
                      ? (smartSearchCancelPending ? 'Stopping\u2026' : 'Stop')
                      : 'Find jobs'}
                  </button>
                </div>
              </div>

              <div className="jobs-meta-row">
                <JobSearchFilters
                  jobFilters={jobFilters}
                  onFilterChange={handleFilterChange}
                  onArrayFilterChange={handleArrayFilterChange}
                />

                {searchHistory.length > 0 && (
                  <div className="jobs-recent-pills">
                    <span className="jobs-recent-pills__label muted">Recent:</span>
                    {searchHistory.slice(0, 3).map((entry, i) => {
                      const label = recentSearchPillLabel(entry)
                      return (
                        <button
                          key={`${entry.keywords}\u0000${entry.location}-${i}`}
                          type="button"
                          className="chip"
                          title={label}
                          aria-label={`Apply past search: ${label}`}
                          onClick={() => {
                            userEditedJobSearchRef.current = false
                            setKeywords(entry.keywords)
                            setLocation(entry.location)
                            pillSearchTriggerRef.current = true
                          }}
                        >
                          {label}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>

          </div>
        ))}



        {activeTab !== 'queue' && (state.searching || state.smartSearching) && (
          <JobsSearchProgress progress={state.smartProgress} />
        )}

        {activeTab !== 'queue' && state.searchError && (
          <div className="wizard-feedback wizard-feedback--error" role="alert">
            <strong>Search didn&apos;t complete.</strong> {humanizeSearchError(state.searchError)}
            {searchErrorLikelyBuildSkew && (
              <p className="wizard-feedback__hint">
                App build mismatch — quit fully, restart, or reinstall if it persists.
              </p>
            )}
            <div className="mt-xs">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={state.searching || state.smartSearching || !keywords.trim() || !chromeReady}
                aria-busy={state.searching || state.smartSearching}
                onClick={() => void searchJobs()}
              >
                {state.searching || state.smartSearching ? 'Retrying\u2026' : 'Retry search'}
              </button>
            </div>
          </div>
        )}

        {!state.hasSearched && !(state.searching || state.smartSearching) && !state.searchError && !(applyQueue && applyQueue.items.length > 0) && (
          <div className="jobs-initial-empty">
            <div className="jobs-initial-empty__icon" aria-hidden="true">{'\u2609'}</div>
            <p className="jobs-initial-empty__text">
              Enter job titles, keywords, or paste a LinkedIn jobs URL above, then click <strong>Find jobs</strong>.
              {searchHistory.length > 0 && ' Or pick a recent search from the chips under the form.'}
            </p>
          </div>
        )}

        {/* Queue status banner — shown on Results while queue is active */}
        {applyQueue?.running && activeTab === 'results' && (
          <div className="jobs-queue-banner mb-sm">
            {applyQueueTile}
          </div>
        )}

        {activeTab === 'results' && state.hasSearched && state.listings.length === 0 && !state.searchError && (
          <div className="empty-state mt-sm" role="status">
            <div className="empty-state__icon" aria-hidden="true">{'\u2609'}</div>
            <h3 className="empty-state__title">No matching jobs found</h3>
            <p className="empty-state__body">Try different keywords, broaden your location, relax the &quot;Posted within&quot; filter in Settings, or check that LinkedIn is open in Chrome.</p>
          </div>
        )}

        {activeTab === 'results' && state.hasSearched && state.listings.length > 0 && (
          <div id="jobs-tab-results" role="tabpanel" aria-label="Results"
            className="jobs-tab-panel"
          >

            {state.screenError && (
              <div className="wizard-feedback wizard-feedback--error" role="alert">
                <strong>AI screening didn&apos;t finish.</strong> {state.screenError}
                <p className="wizard-feedback__hint">Check API key in Settings or try again later.</p>
                <div className="mt-xs">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={state.screening || !criteria.trim() || state.listings.length === 0 || isFeatureGated('ai_job_screening', plan)}
                    aria-busy={state.screening}
                    onClick={() => void screenJobs()}
                  >
                    {state.screening ? 'Retrying\u2026' : 'Retry screening'}
                  </button>
                </div>
              </div>
            )}

            {state.screening && (
              <div className="jobs-screening-banner" role="status" aria-live="polite">
                <span className="jobs-screening-banner__spinner" aria-hidden="true" />
                Screening {state.listings.length} job{state.listings.length === 1 ? '' : 's'} with AI\u2026
              </div>
            )}

            {showJobsScreeningTile && !state.screening && (
              <details className="section--collapsible jobs-screening-collapsible">
                <summary className="section__toggle jobs-section-title jobs-section-title--collapsible">AI screening</summary>
                <div className="jobs-screen-form jobs-screen-form--bento">
                  <p id="jobs-criteria-required-hint" className="sr-only">
                    Enter criteria in the field below before running AI screening.
                  </p>
                  <p id="jobs-ai-key-required-hint" className="sr-only">
                    Configure an API key in Settings to enable AI screening.
                  </p>
                  <label className="field field-span" htmlFor="jobs-criteria">
                    Your criteria
                    <textarea
                      id="jobs-criteria"
                      className="note-option-textarea note-option-textarea--compact min-h-textarea"
                      value={criteria}
                      onChange={(e) => setCriteria(e.target.value)}
                      placeholder="e.g. Remote-friendly product role at a Series B+ startup, ideally in fintech or health tech. 3-5 years experience level."
                    />
                  </label>
                  <div className="wizard-actions mt-xs">
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={!criteria.trim() || state.screening || !aiConfigured || isFeatureGated('ai_job_screening', plan)}
                      aria-busy={state.screening}
                      aria-describedby={[
                        !criteria.trim() && !state.screening ? 'jobs-criteria-required-hint' : '',
                        !aiConfigured && !state.screening ? 'jobs-ai-key-required-hint' : ''
                      ]
                        .filter(Boolean)
                        .join(' ') || undefined}
                      onClick={() => void screenJobs()}
                    >
                      {state.screening ? 'Screening\u2026' : 'Screen with AI'}
                    </button>
                    {isFeatureGated('ai_job_screening', plan) && <span className="gate-badge">Plus</span>}
                    {!aiConfigured && !isFeatureGated('ai_job_screening', plan) && (
                      <span className="caption ml-xs" title="Settings → AI Outreach">
                        API key needed — go to Settings → AI Outreach.
                      </span>
                    )}
                  </div>
                </div>
              </details>
            )}

            {/* Apply banner — primary CTA */}
            {state.hasSearched && !state.searching && !state.smartSearching && displayJobs.length > 0 && !applyQueue?.running && (() => {
              const unqueued = displayJobs.filter(j => j.jobUrl && !effectiveQueuedUrls.has(j.jobUrl) && !appliedJobUrls.has(j.jobUrl))
              if (unqueued.length === 0) return null
              return (
                <div className="jobs-apply-banner">
                  <div className="jobs-apply-banner__left">
                    <span className="jobs-apply-banner__text">{unqueued.length} job{unqueued.length === 1 ? '' : 's'} match your search</span>
                    <button
                      type="button"
                      className="jobs-apply-banner__save"
                      disabled={queueAllBusy}
                      onClick={() => {
                        suppressAutoStartRef.current = true
                        void addAllToQueue(unqueued)
                      }}
                    >
                      or save all for later
                    </button>
                  </div>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={loadMoreBusy || state.searching || state.screening || queueAllBusy}
                    aria-busy={queueAllBusy}
                    onClick={() => void addAllToQueue(unqueued)}
                  >
                    {queueAllBusy ? 'Adding\u2026' : `Apply to all ${unqueued.length}`}
                  </button>
                </div>
              )
            })()}

            {/* Unified toolbar — count + actions + sort/filter */}
            <div className="jobs-unified-toolbar">
              <span className="jobs-unified-toolbar__count">
                {visibleDisplayJobs.length === displayJobs.length
                  ? `${displayJobs.length} job${displayJobs.length === 1 ? '' : 's'}`
                  : `${visibleDisplayJobs.length} of ${displayJobs.length}`}
              </span>
              <div className="jobs-unified-toolbar__actions">
                {state.hasSearched && state.listings.length > 0 && !state.smartSearching && (
                  <>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={!chromeReady || loadMoreBusy || state.searching || state.screening}
                      aria-busy={loadMoreBusy}
                      onClick={() => void loadMoreJobListings()}
                    >
                      {loadMoreBusy ? 'Loading\u2026' : `Load more (${state.listings.length})`}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={loadMoreBusy || state.searching || state.screening}
                      onClick={clearAllResults}
                      title="Clear all cached search results"
                    >
                      Clear all
                    </button>
                  </>
                )}
              </div>
              <span className="jobs-unified-toolbar__spacer" />
              <label className="jobs-toolbar__filter" htmlFor="jobs-sort-by">
                <select
                  id="jobs-sort-by"
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
                  aria-label="Sort job list"
                >
                  {state.hasScreened && <option value="score">AI score</option>}
                  {hasResumeMatchRanking && <option value="resumeMatch">{`R\u00e9sum\u00e9 match`}</option>}
                  <option value="title">Title A{'\u2013'}Z</option>
                  <option value="company">Company A{'\u2013'}Z</option>
                </select>
              </label>
              {state.hasScreened && (
                <label className="jobs-toolbar__filter" htmlFor="jobs-min-score" title="Minimum AI fit score">
                  <select
                    id="jobs-min-score"
                    value={minScore}
                    onChange={(e) => setMinScore(Number(e.target.value))}
                    aria-label="Minimum AI score"
                  >
                    {MIN_SCORE_OPTIONS.map((n) => (
                      <option key={n} value={n}>{n}+</option>
                    ))}
                  </select>
                </label>
              )}
            </div>

            {loadMoreBusy && loadMorePhase && (
              <div className="load-more-progress" role="status" aria-live="polite">
                {(['navigate', 'extract', 'score'] as const).map((step) => {
                  const labels: Record<string, string> = { navigate: 'Opening LinkedIn page', extract: 'Reading listings', score: 'Scoring matches' }
                  const order = ['navigate', 'extract', 'score']
                  const currentIdx = order.indexOf(loadMorePhase)
                  const stepIdx = order.indexOf(step)
                  const done = stepIdx < currentIdx
                  const active = stepIdx === currentIdx
                  return (
                    <span key={step} className={`load-more-progress__step${active ? ' --active' : ''}${done ? ' --done' : ''}`}>
                      <span className="load-more-progress__icon" aria-hidden="true">
                        {done ? '\u2713' : active ? '\u2022' : '\u25CB'}
                      </span>
                      {labels[step]}
                    </span>
                  )
                })}
              </div>
            )}

            {loadMoreMessage && (
              <p className="jobs-load-more-msg" role="status">
                {loadMoreMessage}
              </p>
            )}

            {/* Running queue status is rendered above the Results list */}

            {/* Job list — two-column split: easy apply vs other (stacks on narrow viewports) */}
            {displayJobs.length === 0 && (
              <div className="empty-state mt-sm">
                <div className="empty-state__icon" aria-hidden="true">{'\u2261'}</div>
                <h3 className="empty-state__title">No jobs match your filters</h3>
                <p className="empty-state__body">Try lowering the minimum score or clearing the search text.</p>
              </div>
            )}
            {visibleDisplayJobs.length > 0 && (
              <ul className="jobs-split__list" role="list" aria-live="polite">
                {visibleDisplayJobs.map((job) => {
                  const rowKey = job.jobUrl || `${job.title}-${job.company}`
                  return (
                    <li key={rowKey} className="jobs-split__item">
                      <JobCard
                        job={job}
                        isExpanded={expandedJob === (job.jobUrl || `${job.title}-${job.company}`)}
                        onToggleExpand={handleToggleExpand}
                        hasScreened={state.hasScreened}
                        hasSearched={state.hasSearched}
                        queuedJobUrls={effectiveQueuedUrls}
                        appliedJobUrls={appliedJobUrls}
                        outreachSentUrls={outreachSentUrls}
                        tailoredResumes={tailoredResumes}
                        tailoringJobUrl={tailoringJobUrl}
                        reachOutBusyUrl={reachOutBusyUrl}
                        onAddToQueue={addJobToQueue}
                        onTailorResume={handleTailorResume}
                        onReachOut={handleReachOut}
                        onFeedback={handleJobFeedback}
                      />
                    </li>
                  )
                })}
              </ul>
            )}

            {displayJobs.length > 0 && (
              <div className="jobs-queue-actions mt-sm">
                <div className="wizard-actions">
                  {(() => {
                    const allQueued = displayJobs.every((j) => effectiveQueuedUrls.has(j.jobUrl) || appliedJobUrls.has(j.jobUrl))
                    const pendingCount = queueStats.pending
                    if (allQueued && pendingCount > 0) {
                      return (
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={startingQueue || applyQueue?.running}
                          aria-busy={startingQueue}
                          onClick={() => {
                            void startQueue()
                            setActiveTab('queue')
                          }}
                        >
                          {startingQueue ? 'Starting\u2026' : `Apply all ${pendingCount}`}
                        </button>
                      )
                    }
                    return null
                  })()}
                  {state.hasScreened && minScore > 1 && (
                    <span className="caption ml-xs">Score {minScore}+ only</span>
                  )}
                </div>
                {queueFeedback && (
                  <div className={`wizard-feedback mt-xs ${feedbackTone(queueFeedback)}`} role="status">
                    <span>{queueFeedback}</span>
                    <button
                      type="button"
                      className="wizard-feedback__dismiss"
                      aria-label="Dismiss"
                      onClick={() => setQueueFeedback(null)}
                    >
                      {'\u2715'}
                    </button>
                  </div>
                )}
              </div>
            )}

            {state.listings.length === 0 && !state.searchError && (
              <div className="empty-state mt-sm">
                <div className="empty-state__icon" aria-hidden="true">{'\u2609'}</div>
                <h3 className="empty-state__title">No matching jobs found</h3>
                <p className="empty-state__body">Try different keywords, broaden your location, or check that LinkedIn is open in Chrome.</p>
              </div>
            )}
          </div>
        )}

        {activeTab === 'queue' && (
          <div id="jobs-tab-queue" role="tabpanel" aria-label="Ready to apply"
            className="jobs-tab-panel"
          >
            <div
              className="jobs-bento__tile jobs-bento__queue"
              role="region"
              aria-label="Ready to apply"
            >
              {applyQueueTile}
            </div>
          </div>
        )}
      </div>

      {onOpenProfile && (
        <div className="jobs-profile-section" role="region" aria-label="Profile readiness">
          <button
            type="button"
            className={`jobs-profile-section__toggle ${profileExpanded ? 'jobs-profile-section__toggle--open' : ''}`}
            onClick={onOpenProfile}
            aria-expanded={!!profileExpanded}
          >
            <span className="jobs-profile-section__left">
              <span className={`jobs-profile-section__chevron ${profileExpanded ? 'jobs-profile-section__chevron--open' : ''}`} aria-hidden="true">{'\u25B8'}</span>
              <span className="jobs-profile-section__title">
                {profileExpanded ? 'Application profile' : profilePct < 30 ? 'Set up your profile to autofill applications' : 'Edit your application profile'}
              </span>
            </span>
            {profileExpanded && (
              <span className={`jobs-profile-section__badge ${profilePct >= 80 ? 'jobs-profile-section__badge--good' : profilePct >= 40 ? 'jobs-profile-section__badge--partial' : 'jobs-profile-section__badge--low'}`}>
                {profilePct}%
              </span>
            )}
          </button>
          {profileExpanded && (
            <div className="jobs-profile-section__body">
              <ApplicationAssistantPanel
                onNavigateToJobs={() => { if (onOpenProfile) onOpenProfile() }}
                onCompletionChange={(pct) => setProfilePct(pct)}
              />
            </div>
          )}
        </div>
      )}

      {undoToast && (
        <div className="jobs-undo-toast" role="alert">
          <span>Applying to {undoToast.count} job{undoToast.count === 1 ? '' : 's'}{'\u2026'} starting in {undoToast.secondsLeft}s</span>
          <button
            type="button"
            className="jobs-undo-toast__btn"
            onClick={() => {
              undoCancelledRef.current = true
              if (undoTimerRef.current) { clearInterval(undoTimerRef.current); undoTimerRef.current = null }
              setUndoToast(null)
              showFeedback('Saved to Ready to apply. Not applying yet.')
            }}
          >
            Undo
          </button>
        </div>
      )}
    </div>
  )
}
