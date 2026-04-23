import type { ApplicationRecord, ApplyQueueItem } from '@core/application-types'
import { detailSuggestsUnconfirmedEasyApply } from '@core/apply-queue-heuristics'
import type { JobSearchHistoryEntry } from '@core/job-search-history'
import type { JobsSearchFiltersPersisted } from '@/types/app'
import { readJobsSearchLocal } from '@/jobs-search-local'
import type { SmartSearchProgress } from '../jobs-smart-search-status'
import type { JobsProgressState } from '@core/jobs-progress'

// ───────────────────���──────────────────────────────────
// Types
// ──────────────────────────────────────────────────────

export type JobListing = {
  title: string
  company: string
  location: string
  jobUrl: string
  postedDate?: string
  description?: string
  easyApply?: boolean
  applyUrl?: string
  /** Heuristic 0–100 fit vs structured resume / profile (before AI screening). */
  resumeMatchPercent?: number
  resumeMatchReason?: string
}

export type ScoredJob = JobListing & {
  score: number
  titleFit?: number
  seniorityMatch?: number
  locationFit?: number
  companyFit?: number
  reason: string
  nextStep?: string
  description?: string
  matchedSkills?: string[]
  missingSkills?: string[]
  userFeedback?: 'positive' | 'negative'
}

export type JobsState = {
  searching: boolean
  screening: boolean
  smartSearching: boolean
  smartProgress: SmartSearchProgress | null
  listings: JobListing[]
  scored: ScoredJob[]
  searchError: string | null
  screenError: string | null
  hasSearched: boolean
  hasScreened: boolean
}

// ──────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────

export const MIN_SCORE_OPTIONS = [1, 3, 5, 7] as const

export const DEFAULT_JOBS_SEARCH_FILTERS: JobsSearchFiltersPersisted = {
  jobsSearchRecencySeconds: 86400,
  jobsSearchSortBy: 'DD',
  jobsSearchDistanceMiles: 0,
  jobsSearchExperienceLevels: [],
  jobsSearchJobTypes: [],
  jobsSearchRemoteTypes: [],
  jobsSearchSalaryFloor: 0,
  jobsSearchFewApplicants: false,
  jobsSearchVerifiedOnly: false,
  jobsSearchEasyApplyOnly: true
}

export const JOB_SEARCH_RECENCY_OPTIONS = [
  { value: 0, label: 'Any time' },
  { value: 3600, label: 'Past hour' },
  { value: 86400, label: 'Past 24 hours' },
  { value: 604800, label: 'Past week' },
  { value: 2_592_000, label: 'Past month' }
] as const

export const JOB_SEARCH_SORT_OPTIONS = [
  { value: 'DD' as const, label: 'Date posted' },
  { value: 'R' as const, label: 'Relevance' }
]

export const JOB_SEARCH_DISTANCE_OPTIONS = [
  { value: 0, label: 'Any distance' },
  { value: 10, label: '10 mi' },
  { value: 25, label: '25 mi' },
  { value: 50, label: '50 mi' },
  { value: 100, label: '100 mi' }
] as const

export const JOB_SEARCH_SALARY_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0, label: 'Any salary' },
  { value: 1, label: '$40K+' },
  { value: 2, label: '$60K+' },
  { value: 3, label: '$80K+' },
  { value: 4, label: '$100K+' },
  { value: 5, label: '$120K+' },
  { value: 6, label: '$140K+' },
  { value: 7, label: '$160K+' },
  { value: 8, label: '$180K+' },
  { value: 9, label: '$200K+' }
]

export const JOB_SEARCH_EXPERIENCE_OPTIONS = [
  { id: '1', label: 'Internship' },
  { id: '2', label: 'Entry' },
  { id: '3', label: 'Associate' },
  { id: '4', label: 'Mid-Senior' },
  { id: '5', label: 'Director' },
  { id: '6', label: 'Executive' }
] as const

export const JOB_SEARCH_TYPE_OPTIONS = [
  { id: 'F', label: 'Full-time' },
  { id: 'P', label: 'Part-time' },
  { id: 'C', label: 'Contract' },
  { id: 'T', label: 'Temporary' },
  { id: 'I', label: 'Internship' },
  { id: 'V', label: 'Volunteer' }
] as const

export const JOB_SEARCH_REMOTE_OPTIONS = [
  { id: '1', label: 'On-site' },
  { id: '2', label: 'Remote' },
  { id: '3', label: 'Hybrid' }
] as const

/** First paint: show this many rows (sorted best -> worst). "Load more" expands to `VISIBLE_JOBS_AFTER_LOAD_MORE`. */
export const INITIAL_VISIBLE_JOBS = 25
export const VISIBLE_JOBS_AFTER_LOAD_MORE = 50

// ──────────────────────────────────────────────────────
// Pure utility functions
// ──────────────────────────────────────────────────────

function linkedInJobUrlKey(url: string): string {
  const t = url.trim()
  try {
    const u = new URL(t)
    return `${u.pathname.replace(/\/$/, '')}`.toLowerCase()
  } catch {
    return t.split('?')[0].replace(/\/$/, '').toLowerCase()
  }
}

export function applicationRecordForListedJob(
  records: ApplicationRecord[] | undefined,
  job: { jobUrl: string; title: string; company: string }
): ApplicationRecord | undefined {
  if (!records?.length) return undefined
  const want = linkedInJobUrlKey(job.jobUrl)
  const byUrl = records.find((r) => r.jobUrl && linkedInJobUrlKey(r.jobUrl) === want)
  if (byUrl) return byUrl
  return records.find(
    (r) => r.company.trim() === job.company.trim() && r.title.trim() === job.title.trim()
  )
}

export function jobSearchFiltersSignature(f: JobsSearchFiltersPersisted): string {
  return JSON.stringify({
    ...f,
    jobsSearchExperienceLevels: [...f.jobsSearchExperienceLevels].sort(),
    jobsSearchJobTypes: [...f.jobsSearchJobTypes].sort(),
    jobsSearchRemoteTypes: [...f.jobsSearchRemoteTypes].sort()
  })
}

export function normalizeRecencySeconds(n: number): number {
  const allowed = JOB_SEARCH_RECENCY_OPTIONS.map((o) => o.value)
  return (allowed as number[]).includes(n) ? n : 86400
}

export function normalizeDistanceMiles(n: number): number {
  const allowed = JOB_SEARCH_DISTANCE_OPTIONS.map((o) => o.value)
  return (allowed as number[]).includes(n) ? n : 0
}

const JOBS_API_VERSION_SKEW_RE =
  /\b(?:getLoa\([^)]*\)\.)?(?:jobsSmartSearch|jobsSearch|jobsScreen|sessionToken)\s+is not a function\b|\bno handler registered for ['"](?:jobs:smartSearch|jobs:search|jobs:screen|session:token)['"]\b|\bunknown channel:\s*(?:jobs:smartSearch|jobs:search|jobs:screen|session:token)\b/i

export function isLikelyPreloadMethodSkew(message: string | null): boolean {
  if (!message) return false
  return JOBS_API_VERSION_SKEW_RE.test(message)
}

export function queueItemNeedsCompletion(item: ApplyQueueItem): boolean {
  if (item.status !== 'error') return false
  if (item.stuckFieldLabels?.length) return true
  return detailSuggestsUnconfirmedEasyApply(item.detail) && /unfilled\s*\([^)]+\)/i.test(item.detail || '')
}

export function humanizeQueueDetail(detail?: string): string | null {
  if (!detail) return null
  if (/easy_apply_not_available/i.test(detail)) return 'This job requires applying on the company site \u2014 skipped'
  if (/job_closed_no_longer_accepting/i.test(detail)) return 'Job is no longer accepting applications'
  if (/easy_apply_button_not_found/i.test(detail)) return 'Easy Apply button not found on the job page'
  if (/clicked_easy_apply_cdp_no_modal|no_button_for_js_fallback/i.test(detail)) return "The Easy Apply form didn’t open on this page. The job may have been removed or may not support Easy Apply."
  if (/extension.*not connected|bridge.*disconnected/i.test(detail)) return 'Chrome extension disconnected'
  if (/verification_required|challenge|captcha/i.test(detail)) return 'Action needed in Chrome \u2014 check your LinkedIn tab'
  if (/easy_apply_failed/i.test(detail)) return 'Application could not be completed automatically'
  if (/daily.*cap|limit.*reached/i.test(detail)) return 'Daily application limit reached'
  if (/finish the upload and submit manually/i.test(detail)) return 'Needs your input \u2014 review and complete manually'
  if (/could not advance past step/i.test(detail)) return 'Form could not advance to next step'
  if (/auto-fill paused/i.test(detail)) {
    const afFilled = detail.match(/Filled (\d+)\/(\d+) fields/)
    const afPre = detail.match(/(\d+) pre-filled by LinkedIn/)
    const afParts = ['Auto-fill paused']
    if (afFilled) afParts.push(`${afFilled[1]} of ${afFilled[2]} filled`)
    if (afPre) afParts.push(`${afPre[1]} pre-filled`)
    return afParts.join(' \u00b7 ')
  }
  const fieldMatch = detail.match(/(\d+) required fields? unfilled \(([^)]+)\)/)
  if (fieldMatch) {
    const fields = fieldMatch[2]
    const filledMatch = detail.match(/Filled (\d+)\/(\d+) fields/)
    const prefilledMatch = detail.match(/(\d+) pre-filled by LinkedIn/)
    const parts = [`Stuck on required fields: ${fields}`]
    if (filledMatch) parts.push(`${filledMatch[1]} of ${filledMatch[2]} filled`)
    if (prefilledMatch) parts.push(`${prefilledMatch[1]} pre-filled`)
    return parts.join(' \u00b7 ')
  }
  return detail
}

/**
 * Map raw pipeline `lastDetail` strings to short active-phase labels
 * for the hero card. Returns null if the detail doesn't map to a known
 * in-progress phase (caller should fall back to a default).
 */
export function activePhaseLabel(detail?: string): string | null {
  if (!detail) return null
  if (/navigating to job/i.test(detail)) return 'Opening job page'
  if (/opening easy apply/i.test(detail)) return 'Opening application'
  if (/filling.*field/i.test(detail)) return 'Filling out form'
  if (/verifying submission/i.test(detail)) return 'Verifying submission'
  if (/preparing queue/i.test(detail)) return 'Preparing'
  if (/browsing listing/i.test(detail)) return 'Browsing listings'
  if (/checking out/i.test(detail)) return 'Wrapping up'
  if (/checking prior/i.test(detail)) return 'Checking history'
  if (/waiting|break|cooldown/i.test(detail)) return 'Pacing'
  if (/skipping/i.test(detail)) return 'Skipping'
  return null
}

export function humanizeSearchError(detail?: string): string {
  if (!detail) return 'We couldn\u2019t complete that search.'
  if (/selectors_miss:no_cards/i.test(detail)) return 'LinkedIn loaded but no job results appeared. Try refreshing the LinkedIn tab, then search again.'
  if (/selectors_miss:no_items/i.test(detail)) return 'Found job cards but couldn\u2019t read titles. Try again in a moment.'
  if (/content_inject_failed|Receiving end does not exist|content_script_timeout/i.test(detail)) return 'Chrome extension lost contact with LinkedIn. Reload the extension in Chrome\u2019s Extensions page, refresh the LinkedIn tab, then retry.'
  if (/extension.*not connected|bridge.*disconnected/i.test(detail)) return 'Chrome extension disconnected. Reconnect and try again.'
  if (/timeout|timed?\s*out/i.test(detail)) return 'Search timed out. Try again in a moment.'
  if (/navigate|navigation/i.test(detail)) return 'Couldn\u2019t navigate to LinkedIn Jobs. Open LinkedIn in Chrome first.'
  return detail
}

/** Screen-reader-friendly status for a queue row (avoids raw enum tokens). */
export function queueItemAriaStatus(item: ApplyQueueItem, needsCompletion: boolean): string {
  if (needsCompletion) return 'Stuck on required fields — retryable'
  switch (item.status) {
    case 'active':
      return 'In progress'
    case 'error':
      return 'Needs attention'
    case 'pending':
      return 'Waiting in queue'
    case 'skipped':
      return 'Skipped'
    default:
      return item.status
  }
}

export function recentSearchPillLabel(entry: JobSearchHistoryEntry): string {
  const loc = entry.location.trim()
  return loc ? `${entry.keywords} \u00b7 ${loc}` : entry.keywords
}

export function jobSearchFieldKey(keywords: string, location: string): string {
  return `${keywords}\u0000${location}`
}

export function feedbackTone(msg: string): 'wizard-feedback--warn' | 'wizard-feedback--error' | 'wizard-feedback--ok' {
  if (/failed|could not|error/i.test(msg)) return 'wizard-feedback--error'
  if (/already|not easy apply|no new jobs|no contacts|only linkedin|not available|not an easy/i.test(msg)) return 'wizard-feedback--warn'
  return 'wizard-feedback--ok'
}

export function scoreColor(score: number): string {
  if (score >= 8) return 'jobs-score--high'
  if (score >= 5) return 'jobs-score--mid'
  return 'jobs-score--low'
}

export function resumeMatchColor(percent: number): string {
  if (percent >= 70) return 'jobs-resume-match--high'
  if (percent >= 40) return 'jobs-resume-match--mid'
  return 'jobs-resume-match--low'
}

export function mergePersistedJobSearchFields(
  persistedKeywords: string,
  persistedLocation: string
): { keywords: string; location: string } {
  const cache = readJobsSearchLocal()
  const diskHas = !!(persistedKeywords.trim() || persistedLocation.trim())
  if (diskHas) {
    return { keywords: persistedKeywords, location: persistedLocation }
  }
  return { keywords: cache.keywords || '', location: cache.location || '' }
}

export function toSmartSearchProgress(progress: JobsProgressState): SmartSearchProgress {
  return {
    phase: progress.phase,
    message: progress.message,
    startedAt: progress.startedAt,
    updatedAt: progress.updatedAt,
    queriesPlanned: progress.queriesPlanned,
    queriesCompleted: progress.queriesCompleted,
    currentQuery: progress.currentQuery,
    currentQueryIndex: progress.currentQueryIndex,
    totalQueries: progress.totalQueries,
    currentQueryResultCount: progress.currentQueryResultCount,
    totalJobsFound: progress.totalJobsFound,
    enrichingCompleted: progress.enrichingCompleted,
    enrichingTotal: progress.enrichingTotal,
    screeningCount: progress.screeningCount
  }
}
