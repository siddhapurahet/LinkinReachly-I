import { useEffect, useState, useCallback, useRef } from 'react'
import { getLoa } from '@/loa-client'

interface DailyProgress {
  applied: number
  cap: number
  configuredCap?: number
}

interface WeeklyOutreachWarn {
  sent: number
  cap: number
}

interface LifecycleCounts {
  applied: number
  outreach: number
  connected: number
  followedUp: number
  responded: number
}

export function useAppPolling() {
  const [dailyProgress, setDailyProgress] = useState<DailyProgress | null>(null)
  const [dailyOutreach, setDailyOutreach] = useState<number>(0)
  const [weeklyOutreachWarn, setWeeklyOutreachWarn] = useState<WeeklyOutreachWarn | null>(null)
  const [answerBankCount, setAnswerBankCount] = useState<number | null>(null)
  const [followUpBadge, setFollowUpBadge] = useState(0)
  const [queuedCount, setQueuedCount] = useState(0)
  const [lifecycleCounts, setLifecycleCounts] = useState<LifecycleCounts>({
    applied: 0, outreach: 0, connected: 0, followedUp: 0, responded: 0
  })

  const fetchDaily = useCallback(() => {
    getLoa().applicationQueueState().then((res) => {
      if (!mountedRef.current) return
      // The handler at application-assistant-queue.ts:72 returns
      //   { ok, state: { items: [...] }, dailyUsage, dailyOutreach, weeklyOutreach }
      // — items live on r.state.items, not r.items. The previous reading of
      // r.items was always undefined, so setQueuedCount never ran and the
      // "{N} saved" badge was permanently stuck at 0.
      const r = res as {
        ok?: boolean
        state?: { items?: Array<{ status?: string }> }
        dailyUsage?: { sent: number; cap: number; configuredCap?: number }
        dailyOutreach?: { sent: number }
        weeklyOutreach?: { sent: number; cap: number; pendingWarning: boolean }
      }
      if (!r?.ok) return
      if (r.dailyUsage) setDailyProgress({ applied: r.dailyUsage.sent, cap: r.dailyUsage.cap, configuredCap: r.dailyUsage.configuredCap })
      if (r.dailyOutreach) setDailyOutreach(r.dailyOutreach.sent)
      if (r.weeklyOutreach?.pendingWarning) setWeeklyOutreachWarn({ sent: r.weeklyOutreach.sent, cap: r.weeklyOutreach.cap })
      else setWeeklyOutreachWarn(null)
      const items = r.state?.items
      if (Array.isArray(items)) {
        // Match the "Ready to apply" panel filter at useApplyQueue.ts:60 —
        // any item that isn't done or skipped is visible there (pending,
        // active, error). Count must agree with what the user can see.
        setQueuedCount(items.filter(i => i.status !== 'done' && i.status !== 'skipped').length)
      }
    }).catch((err: unknown) => { console.warn('[useAppPolling] fetchDaily failed:', err) })
  }, [])

  const [historyAppliedUrls, setHistoryAppliedUrls] = useState<Set<string>>(new Set())

  const fetchBadges = useCallback(() => {
    getLoa().applicationHistory().then((res) => {
      if (!mountedRef.current || !res.ok) return
      const records = res.records as Array<{ outcome?: string; outreachStatus?: string; pipelineStage?: string; createdAt: string; jobUrl?: string }>
      const appRecords = records.filter((r) => r.outcome === 'submitted' || r.outcome === 'autofilled')
      const outreachSent = records.filter((r) => r.outreachStatus === 'sent').length
      const connected = records.filter((r) => r.outreachStatus === 'connected').length
      setLifecycleCounts(prev => ({
        ...prev,
        applied: appRecords.length,
        outreach: outreachSent,
        connected
      }))
      const urls = new Set<string>()
      for (const r of records) {
        if ((r.outcome === 'submitted' || r.outcome === 'autofilled') && r.jobUrl) urls.add(r.jobUrl)
      }
      setHistoryAppliedUrls(urls)
    }).catch((err: unknown) => { console.warn('[useAppPolling] applicationHistory failed:', err) })
    getLoa().followUpState().then((res) => {
      if (!mountedRef.current || !res.ok) return
      const data = res as { ok: boolean; stats: { acceptsThisWeek: number; responded: number } }
      setFollowUpBadge(data.stats.acceptsThisWeek)
      setLifecycleCounts(prev => ({
        ...prev,
        followedUp: data.stats.acceptsThisWeek,
        responded: data.stats.responded
      }))
    }).catch((err: unknown) => { console.warn('[useAppPolling] followUpState failed:', err) })
  }, [])

  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    fetchDaily()
    fetchBadges()
    getLoa().applicantGet().then((res) => {
      if (!mountedRef.current) return
      if (res.ok) setAnswerBankCount(Object.keys(res.profile.screeningAnswerCache || {}).length)
    }).catch((err: unknown) => { console.warn('[useAppPolling] applicantGet failed:', err) })
    const id = setInterval(fetchDaily, 15_000)
    const badgeId = setInterval(fetchBadges, 30_000)

    // Subscribe to apply-queue ticks so the daily-applied counter and the
    // "X saved" counter refresh immediately on any queue change (item added,
    // removed, or completed) instead of waiting for the 15s poll. Debounce
    // to avoid spamming the backend during rapid status updates.
    let prevSig = ''
    let refetchTimer: ReturnType<typeof setTimeout> | null = null
    const loa = getLoa() as { onApplyQueueTick?: (cb: (s: { items?: Array<{ status?: string }> }) => void) => () => void }
    let unsubTick: (() => void) | undefined
    if (typeof loa.onApplyQueueTick === 'function') {
      unsubTick = loa.onApplyQueueTick((state) => {
        if (!mountedRef.current) return
        const items = state.items || []
        // Signature combines total count + per-status counts. Changes on any
        // add/remove/status-transition; doesn't change on cosmetic re-emits.
        let pending = 0, active = 0, done = 0, error = 0, skipped = 0
        for (const i of items) {
          if (i.status === 'pending') pending++
          else if (i.status === 'active') active++
          else if (i.status === 'done') done++
          else if (i.status === 'error') error++
          else if (i.status === 'skipped') skipped++
        }
        const sig = `${items.length}|${pending}|${active}|${done}|${error}|${skipped}`
        if (sig === prevSig) return
        prevSig = sig
        if (refetchTimer) clearTimeout(refetchTimer)
        refetchTimer = setTimeout(() => {
          if (mountedRef.current) {
            fetchDaily()
            fetchBadges()
          }
        }, 350)
      })
    }

    return () => {
      mountedRef.current = false
      clearInterval(id)
      clearInterval(badgeId)
      if (refetchTimer) clearTimeout(refetchTimer)
      unsubTick?.()
    }
  }, [fetchDaily, fetchBadges])

  return { dailyProgress, dailyOutreach, weeklyOutreachWarn, answerBankCount, followUpBadge, queuedCount, lifecycleCounts, historyAppliedUrls }
}
