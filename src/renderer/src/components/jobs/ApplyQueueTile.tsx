/**
 * Apply queue panel: hero card for active job, compact queue list, chain outreach, session summary.
 * Variation 6 — "Active Job Hero Card" design.
 */
import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import type { ApplyQueueState } from '@core/application-types'
import { normalizeFieldLabelForSnapshotMatch } from '@core/field-name-aliases'
import { getLoa } from '@/loa-client'
import { StuckFieldsPrompt } from '../StuckFieldsPrompt'
import { CooldownCountdown } from './JobsSearchProgress'
import { QueueEventFeed } from './QueueEventFeed'
import { humanizeQueueDetail, activePhaseLabel, queueItemNeedsCompletion, queueItemAriaStatus } from './jobs-helpers'

/** Parse stuck-field labels from item, preferring stuckFieldLabels, falling back to detail string */
function parseStuckLabels(item: ApplyQueueState['items'][number]): string[] {
  let labels = item.stuckFieldLabels
  if ((!labels || labels.length === 0) && item.detail) {
    const m = item.detail.match(/unfilled\s*\(([^)]+)\)/i)
    if (m) labels = m[1].split(',').map(s => s.trim()).filter(s => s && s !== '...')
  }
  return labels && labels.length > 0 ? labels : []
}
import type { QueueStats } from './useApplyQueue'

type Props = {
  applyQueue: ApplyQueueState
  queueStats: QueueStats
  applyQueueOpenItems: ApplyQueueState['items']
  queueAriaAlert: string
  chromeReady: boolean
  resumeFileName?: string
  startingQueue: boolean
  retryingItemUrls: Set<string>
  clearingQueue: boolean
  retryingBulk: boolean
  queuePausing: boolean
  chainRunning: boolean
  chainStatus: string
  chainProgress: string
  chainDismissed: boolean
  chainSkipping: boolean
  outreachSentUrls: Set<string>
  appliedJobUrls: Set<string>
  onStartQueue: () => void
  onStopQueue: () => void
  onClearQueue: () => void
  onRetryFailed: () => void
  onRemoveItem: (id: string) => void
  onRetryItem: (id: string) => void
  onMarkItemDone: (id: string) => void
  onRunChain: () => void
  onSkipChain: () => void
  onDismissChainStatus: () => void
  onSwitchToResults: () => void
  onExtSetupNeeded?: () => void
  onNavigateToSettings?: (section: 'answers' | 'limits') => void
  answerBankCount?: number
  reviewBeforeSubmit?: boolean
  applyDailyCap?: number
  appliedToday?: number
  applyCap?: number
  showFirstSessionGuide?: boolean
  onDismissGuide?: () => void
  setFeedback: (msg: string) => void
}

export function ApplyQueueTile({
  applyQueue,
  queueStats,
  applyQueueOpenItems,
  queueAriaAlert,
  chromeReady,
  resumeFileName,
  startingQueue,
  retryingItemUrls,
  clearingQueue,
  retryingBulk,
  queuePausing,
  chainRunning,
  chainStatus,
  chainProgress,
  chainDismissed,
  chainSkipping,
  outreachSentUrls,
  appliedJobUrls,
  onStartQueue,
  onStopQueue,
  onClearQueue,
  onRetryFailed,
  onRemoveItem,
  onRetryItem,
  onMarkItemDone,
  onRunChain,
  onSkipChain,
  onDismissChainStatus,
  onSwitchToResults,
  onExtSetupNeeded,
  onNavigateToSettings,
  answerBankCount,
  reviewBeforeSubmit,
  applyDailyCap,
  appliedToday,
  applyCap,
  showFirstSessionGuide,
  onDismissGuide,
  setFeedback
}: Props) {
  const guideStep = useMemo(() => {
    if (!showFirstSessionGuide) return null
    if (applyQueue.items.length === 0) return 1
    if ((answerBankCount ?? 0) === 0) return 2
    if (queueStats.done === 0) return 3
    return 4
  }, [showFirstSessionGuide, applyQueue.items.length, answerBankCount, queueStats.done])

  // Derive a short phase label from the pipeline's lastDetail so the hero
  // card rotates text ("Opening job page", "Filling out form", …) instead
  // of showing a static "Applying now" that looks stuck.
  const heroPhaseLabel = useMemo(
    () => activePhaseLabel(applyQueue.lastDetail) || 'Applying',
    [applyQueue.lastDetail]
  )

  // V4 collapsed accordion: only one card expanded at a time
  const [expandedItemId, setExpandedItemId] = useState<string | null>(null)
  const toggleAccordion = useCallback((id: string) => {
    setExpandedItemId(prev => prev === id ? null : id)
  }, [])

  const guideContent: Record<number, { title: string; body: string }> = {
    1: { title: 'Review your matches', body: 'Search for jobs and click the + button on ones that interest you to save them to Ready to apply.' },
    2: { title: 'Set up Saved Answers', body: 'Add answers to common screening questions so forms auto-fill during applications.' },
    3: { title: 'Start applying', body: 'Hit the Start button to begin auto-applying. You can pause anytime.' },
    4: { title: 'Check your history', body: 'Head to the History tab to review what was submitted and follow up.' },
  }

  if (applyQueue.items.length === 0) {
    return (
      <div className="queue-hero--empty">
        <div className="queue-hero--empty__icon" aria-hidden="true">{'\u2609'}</div>
        <p className="queue-hero--empty__text">
          No jobs saved yet.{' '}
          <button type="button" className="link-button" onClick={onSwitchToResults}>
            Search for jobs
          </button>{' '}
          to start.
        </p>
        {guideStep === 1 && (
          <div className="queue-guide-callout">
            <span className="queue-guide-callout__step">1</span>
            <div className="queue-guide-callout__body">
              <strong>{guideContent[1].title}</strong>
              <div>{guideContent[1].body}</div>
              <div className="queue-guide-callout__meta">
                <span>Step 1 of 4</span>
                <button type="button" className="queue-guide-callout__skip" onClick={onDismissGuide}>Skip guide</button>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  const activeItem = applyQueue.running
    ? applyQueue.items.find((i) => i.status === 'active')
    : null
  const remaining = queueStats.pending + queueStats.activeCount
  const errorCount = queueStats.error - queueStats.resumeErr

  return (
    <div className="queue-hero queue-hero--v3">
      <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true">
        {queueAriaAlert}
      </div>

      {applyQueue.lastErrorCode === 'extension_stale' && (
        <div className="wizard-feedback wizard-feedback--warn" role="status">
          <strong>Extension needs a refresh.</strong>{' '}
          Click Retry below — if that doesn{'\u2019'}t work, reload the extension in Chrome{'\u2019'}s Extensions page.
        </div>
      )}

      {/* Hero card — shown when queue is running and there's an active item */}
      {applyQueue.running && activeItem && (
        <div className="queue-hero__card" role="status" aria-live="polite">
          <div className="queue-hero__card-accent" aria-hidden="true" />
          <div className="queue-hero__card-status">
            <span className="queue-hero__spinner" aria-hidden="true" />
            <span className="queue-hero__card-label queue-hero__card-label--phase" key={heroPhaseLabel}>{heroPhaseLabel}</span>
          </div>
          <div className="queue-hero__card-title">{activeItem.jobTitle}</div>
          <div className="queue-hero__card-company">{activeItem.company}{activeItem.location ? ` \u00b7 ${activeItem.location}` : ''}</div>
          <div className="queue-hero__card-footer">
            <span className="queue-hero__card-progress">
              {queueStats.done} of {queueStats.actionableTotal} done
              {queueStats.error > 0 ? ` \u00b7 ${queueStats.resumeErr > 0 ? `${queueStats.resumeErr} have questions` : ''}${errorCount > 0 ? `${queueStats.resumeErr > 0 ? ', ' : ''}${errorCount} need attention` : ''}` : ''}
            </span>
            <button
              type="button"
              className="queue-hero__card-btn"
              onClick={onStopQueue}
              disabled={queuePausing}
              aria-busy={queuePausing}
            >
              {queuePausing ? 'Stopping\u2026' : 'Pause'}
            </button>
          </div>
        </div>
      )}

      {/* Hero card — running but no active item (cooldown / between items) */}
      {applyQueue.running && !activeItem && (
        <div className="queue-hero__card queue-hero__card--idle" role="status" aria-live="polite">
          <div className="queue-hero__card-status">
            <span className="queue-hero__spinner" aria-hidden="true" />
            <span className="queue-hero__card-label">
              {humanizeQueueDetail(applyQueue.lastDetail) || 'Applying\u2026'}
            </span>
          </div>
          <div className="queue-hero__card-footer">
            <span className="queue-hero__card-progress">
              {queueStats.done}/{queueStats.actionableTotal} done
              {remaining > 0 ? ` \u00b7 ${remaining} left` : ''}
            </span>
            <button
              type="button"
              className="queue-hero__card-btn"
              onClick={onStopQueue}
              disabled={queuePausing}
              aria-busy={queuePausing}
            >
              {queuePausing ? 'Stopping\u2026' : 'Pause'}
            </button>
          </div>
          {applyQueue.cooldownEndsAt && applyQueue.cooldownEndsAt > Date.now() && (
            <CooldownCountdown endsAt={applyQueue.cooldownEndsAt} />
          )}
        </div>
      )}

      {/* Summary stats ribbon — when not running */}
      {!applyQueue.running && (
        <div className="queue-hero__stats-ribbon">
          <span>{queueStats.done} done</span>
          <span>{queueStats.pending} pending</span>
          {queueStats.resumeErr > 0 && (
            <span className="queue-hero__stats-ribbon--warn">{queueStats.resumeErr} have questions</span>
          )}
          {errorCount > 0 && (
            <span className="queue-hero__stats-ribbon--warn">{errorCount} need attention</span>
          )}
          {queueStats.skipped > 0 && <span className="queue-hero__stats-ribbon--muted">{queueStats.skipped} skipped</span>}
          {outreachSentUrls.size > 0 && <span className="queue-hero__stats-ribbon--action">{outreachSentUrls.size} reached out</span>}
          {queueStats.actionableTotal > 0 && (
            <div className="queue-hero__stats-ribbon-bar">
              <div
                className="queue-hero__stats-ribbon-fill"
                role="progressbar"
                aria-valuenow={queueStats.progress}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`Ready to apply progress: ${queueStats.progress}%`}
                style={{ width: `${queueStats.progress}%` }}
              />
            </div>
          )}
        </div>
      )}

      {/* Quick settings shortcuts */}
      {!applyQueue.running && onNavigateToSettings && (
        <div className="queue-quick-settings" role="navigation" aria-label="Quick settings">
          <span className="queue-quick-settings__label">Quick settings:</span>
          <button type="button" className="queue-quick-settings__link" onClick={() => onNavigateToSettings('answers')}>
            Saved answers{answerBankCount != null ? ` (${answerBankCount})` : ''}
          </button>
          <button type="button" className="queue-quick-settings__link" onClick={() => onNavigateToSettings('limits')}>
            Daily limit: {applyDailyCap ?? 20}
          </button>
          {reviewBeforeSubmit && (
            <span className="queue-quick-settings__badge">{'\u2713'} Review mode</span>
          )}
        </div>
      )}

      {/* Post-onboarding first session guide */}
      {guideStep && guideStep >= 2 && guideStep <= 4 && (
        <div className="queue-guide-callout">
          <span className="queue-guide-callout__step">{guideStep}</span>
          <div className="queue-guide-callout__body">
            <strong>{guideContent[guideStep].title}</strong>
            <div>{guideContent[guideStep].body}</div>
            <div className="queue-guide-callout__meta">
              <span>Step {guideStep} of 4</span>
              {guideStep === 2 && onNavigateToSettings && (
                <button type="button" className="queue-guide-callout__action" onClick={() => onNavigateToSettings('answers')}>Open Saved Answers</button>
              )}
              <button type="button" className="queue-guide-callout__skip" onClick={onDismissGuide}>Skip guide</button>
            </div>
          </div>
        </div>
      )}

      {/* Chrome not connected — prominent blocker banner */}
      {!applyQueue.running && queueStats.hasPending && !chromeReady && (
        <div className="queue-ext-banner" role="alert">
          <div className="queue-ext-banner__icon" aria-hidden="true">!</div>
          <div className="queue-ext-banner__body">
            <strong>Chrome extension disconnected</strong>
            <span className="queue-ext-banner__detail">You need the Chrome extension connected to submit applications.</span>
          </div>
          {onExtSetupNeeded && (
            <button type="button" className="btn btn-sm queue-ext-banner__action" onClick={onExtSetupNeeded}>
              Set up extension
            </button>
          )}
        </div>
      )}

      {!applyQueue.running && queueStats.hasResumeErr && queueStats.hasPending && !startingQueue && (
        <p className="muted caption" style={{margin: 0}}>Need-info items will be skipped. Answer anytime, then retry.</p>
      )}

      {/* Last error — hidden when stuck items exist (accordion cards handle them inline) */}
      {applyQueue.lastError && !applyQueue.running && applyQueue.lastErrorCode && queueStats.resumeErr === 0 && (
        <div className="wizard-feedback wizard-feedback--warn" role="alert">
          {applyQueue.lastErrorCode === 'consecutive_failures'
            ? `${errorCount} application${errorCount === 1 ? '' : 's'} hit temporary issues. LinkedIn may be rate-limiting. Wait 2\u20133 minutes, then retry.`
            : humanizeQueueDetail(applyQueue.lastError) || 'Something went wrong. Try again.'}
          <div className="mt-xs">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={retryingBulk}
              aria-busy={retryingBulk}
              onClick={onRetryFailed}
            >
              {retryingBulk ? 'Retrying\u2026' : 'Retry'}
            </button>
          </div>
        </div>
      )}

      {/* Stuck fields: handled per-item inside accordion cards below */}

      {/* Chain banner: hiring manager outreach */}
      {!applyQueue.running && queueStats.done > 0 && outreachSentUrls.size < queueStats.done && !chainDismissed && (
        <div className="queue-hero__chain" role="region" aria-label="Hiring manager outreach">
          {!chainRunning && !chainStatus && (
            <>
              <div className="queue-hero__chain-text">
                <strong>{queueStats.done} application{queueStats.done === 1 ? '' : 's'} submitted.</strong>{' '}
                Want to 5x your chances? We{'\u2019'}ll send a personalized connection request to the hiring manager for each role.
              </div>
              <div className="queue-hero__chain-actions">
                <button type="button" className="btn btn-primary btn-sm" disabled={chainSkipping} aria-busy={chainRunning} onClick={onRunChain}>
                  Reach out
                </button>
                <button type="button" className="btn btn-ghost btn-sm" disabled={chainSkipping} aria-busy={chainSkipping} onClick={onSkipChain}>
                  {chainSkipping ? 'Skipping\u2026' : 'Skip'}
                </button>
              </div>
            </>
          )}
          {chainRunning && (
            <div className="queue-hero__chain-running">
              <span className="queue-hero__spinner" aria-hidden="true" />
              <div>
                <strong>Reaching out to hiring contacts\u2026</strong>
                {chainProgress && <p className="muted caption">{chainProgress}</p>}
              </div>
            </div>
          )}
          {!chainRunning && chainStatus && (
            <div className="queue-hero__chain-result">
              <span>{chainStatus}</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={onDismissChainStatus}>Dismiss</button>
            </div>
          )}
        </div>
      )}

      {/* Promote screening answers to answer bank */}
      <PromoteAnswersBanner applyQueue={applyQueue} setFeedback={setFeedback} />

      {/* Session summary */}
      {!applyQueue.running && queueStats.done > 0 && appliedJobUrls.size <= outreachSentUrls.size && outreachSentUrls.size > 0 && (
        <div className="queue-hero__session">
          <div className="queue-hero__session-title">Session complete</div>
          <div className="queue-hero__summary-stats">
            <div className="queue-hero__stat">
              <span className="queue-hero__stat-value">{queueStats.done}</span>
              <span className="queue-hero__stat-label">Applied</span>
            </div>
            <div className="queue-hero__stat">
              <span className="queue-hero__stat-value">{outreachSentUrls.size}</span>
              <span className="queue-hero__stat-label">Reached out</span>
            </div>
            <div className="queue-hero__stat">
              <span className="queue-hero__stat-value">{queueStats.done + outreachSentUrls.size}</span>
              <span className="queue-hero__stat-label">Total</span>
            </div>
          </div>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={clearingQueue}
            aria-busy={clearingQueue}
            onClick={onClearQueue}
          >
            {clearingQueue ? 'Working\u2026' : 'Start new search'}
          </button>
        </div>
      )}

      {/* Daily usage meter */}
      {applyCap != null && appliedToday != null && (
        <div className="queue-hero__usage-meter" role="meter" aria-label="Daily usage" aria-valuenow={appliedToday} aria-valuemin={0} aria-valuemax={applyCap}>
          <div className="queue-hero__usage-bar">
            <div className="queue-hero__usage-fill" style={{ width: `${Math.min(100, Math.round((appliedToday / applyCap) * 100))}%` }} />
          </div>
          <span className="queue-hero__usage-label">{appliedToday} / {applyCap} applied today</span>
        </div>
      )}

      {/* Live event feed */}
      <QueueEventFeed applyQueue={applyQueue} />

      {/* Queue list — accordion cards */}
      {applyQueueOpenItems.length > 0 && (
        <div className="queue-hero__list">
          <div className="queue-hero__list-header">
            Ready to apply
            {queueStats.resumeErr > 0 && <span className="queue-hero__list-stuck">{queueStats.resumeErr} have questions</span>}
            {errorCount > 0 && <span className="queue-hero__list-failed">{errorCount} need attention</span>}
          </div>
          <div className="queue-hero__list-scroll">
            <div className="queue-hero__items queue-hero__items--accordion" role="list">
              {applyQueueOpenItems.map((item) => {
              const needsCompletion = queueItemNeedsCompletion(item)
              const stuckLabels = parseStuckLabels(item)
              const isOpen = expandedItemId === item.id
              const qCount = stuckLabels.length
              const chipLabel = needsCompletion && qCount > 0
                ? `${qCount} Q${qCount > 1 ? 's' : ''}`
                : item.status === 'active' ? 'in progress'
                : item.status === 'error' ? 'needs attention'
                : 'ready'
              const chipTone = needsCompletion ? 'pending'
                : item.status === 'error' ? 'warning'
                : item.status === 'active' ? 'active'
                : 'pending'
              const isRetryingItem = retryingItemUrls.has(item.id)

              return (
                <div
                  key={item.id}
                  className={`queue-accordion queue-accordion--${needsCompletion ? 'stuck' : item.status}${isOpen ? ' queue-accordion--open' : ''}`}
                  role="listitem"
                >
                  <button
                    type="button"
                    className="queue-accordion__head"
                    onClick={() => toggleAccordion(item.id)}
                    aria-expanded={isOpen}
                  >
                    <div className="queue-accordion__info">
                      <span className="queue-accordion__title">{item.jobTitle}</span>
                      <span className="queue-accordion__company">
                        {item.company}
                        {item.location ? ` \u00b7 ${item.location}` : ''}
                      </span>
                    </div>
                    <div className="queue-accordion__status">
                      <span className={`application-chip application-chip--${chipTone}`} role="status">
                        <span className="sr-only">{queueItemAriaStatus(item, needsCompletion)}</span>
                        <span aria-hidden="true">{chipLabel}</span>
                      </span>
                      <span className={`queue-accordion__chevron${isOpen ? ' queue-accordion__chevron--open' : ''}`} aria-hidden="true">{'\u25B8'}</span>
                    </div>
                  </button>
                  {isOpen && (
                    <div className="queue-accordion__body">
                      {item.detail && !needsCompletion && (
                        <p className="queue-accordion__detail">{humanizeQueueDetail(item.detail)}</p>
                      )}

                      {needsCompletion && stuckLabels.length > 0 && (
                        <InlineQRows
                          labels={stuckLabels}
                          isRetrying={isRetryingItem}
                          onSave={async (answers) => {
                            try {
                              await getLoa().applicantSave({ screeningAnswerCache: answers })
                              setFeedback(`Saved ${Object.keys(answers).length} answer${Object.keys(answers).length === 1 ? '' : 's'}. Will auto-fill next time.`)
                            } catch {
                              setFeedback('Couldn\u2019t save answers. Try again.')
                            }
                          }}
                          onAfterSave={async () => { await onRetryItem(item.id) }}
                        />
                      )}

                      {needsCompletion && stuckLabels.length === 0 && (
                        <p className="sui-muted caption">
                          This application has a question we couldn{'\u2019'}t read automatically. Open it on LinkedIn to see the question, answer it there, and we{'\u2019'}ll learn from it for next time.
                        </p>
                      )}

                      <div className="queue-accordion__actions queue-accordion__actions--v4">
                        {!applyQueue.running && item.status === 'error' && !needsCompletion && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            disabled={isRetryingItem}
                            aria-busy={isRetryingItem}
                            onClick={() => void onRetryItem(item.id)}
                          >
                            {isRetryingItem ? 'Retrying\u2026' : 'Retry'}
                          </button>
                        )}
                        {(item.linkedinJobUrl || item.applyUrl) && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => getLoa().openExternalUrl(item.linkedinJobUrl || item.applyUrl)}
                            aria-label={`Open ${item.jobTitle} on LinkedIn`}
                          >
                            View on LinkedIn
                          </button>
                        )}
                        {!applyQueue.running && item.status !== 'active' && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm queue-accordion__remove"
                            aria-label={`Remove ${item.jobTitle} from Ready to apply`}
                            onClick={() => void onRemoveItem(item.id)}
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )
              })}
            </div>
          </div>
        </div>
      )}

      {applyQueueOpenItems.length === 0 && !applyQueue.running && (
        <p className="muted caption" role="status">
          Saved jobs cleared.{' '}
          <button type="button" className="link-button" onClick={onSwitchToResults}>Back to Results</button>{' '}
          to add more jobs.
        </p>
      )}

      {!applyQueue.running && (
        <div className="queue-hero__fab">
          <button type="button" className="btn btn-primary"
            onClick={!chromeReady && onExtSetupNeeded ? onExtSetupNeeded : onStartQueue}
            disabled={(!chromeReady && !onExtSetupNeeded) || !queueStats.hasPending || startingQueue} aria-busy={startingQueue}>
            {startingQueue ? 'Starting\u2026' : !chromeReady ? 'Connect Chrome to start' : `Start applying${queueStats.pending > 0 ? ` (${queueStats.pending})` : ''}`}
          </button>
          {queueStats.hasError && (
            <button type="button" className="btn btn-ghost" disabled={retryingBulk} aria-busy={retryingBulk} onClick={onRetryFailed}>
              {retryingBulk ? 'Retrying\u2026' : queueStats.hasResumeErr ? 'Retry with answers' : 'Retry all'}
            </button>
          )}
          <button type="button" className="btn btn-ghost" onClick={onClearQueue}
            disabled={clearingQueue} aria-busy={clearingQueue}>
            {clearingQueue ? 'Clearing\u2026' : 'Clear saved jobs'}
          </button>
        </div>
      )}
    </div>
  )
}

function PromoteAnswersBanner({ applyQueue, setFeedback }: { applyQueue: ApplyQueueState; setFeedback: (msg: string) => void }) {
  const [dismissed, setDismissed] = useState(false)
  const [promoting, setPromoting] = useState(false)
  const learned = applyQueue.lastRunSummary?.answersLearned ?? 0
  const summaryFinishedAt = applyQueue.lastRunSummary?.finishedAt

  // Re-open the prompt when a new queue run completes.
  useEffect(() => {
    setDismissed(false)
  }, [summaryFinishedAt])

  if (applyQueue.running || learned === 0 || dismissed) return null

  const onPromote = async () => {
    setPromoting(true)
    try {
      const r = await getLoa().applicantPromoteScreeningAnswers()
      setFeedback(`Saved ${r.promoted} answer${r.promoted === 1 ? '' : 's'}.`)
      setDismissed(true)
    } catch {
      setFeedback('Couldn\u2019t save answers.')
    } finally {
      setPromoting(false)
    }
  }

  return (
    <div className="queue-hero__chain" role="region" aria-label="Save screening answers">
      <div className="queue-hero__chain-text">
        <strong>{learned} new answer{learned === 1 ? '' : 's'} learned.</strong>{' '}
        Save to your Saved Answers so future applications auto-fill?
      </div>
      <div className="queue-hero__chain-actions">
        <button type="button" className="btn btn-primary btn-sm" disabled={promoting} aria-busy={promoting} onClick={onPromote}>
          {promoting ? 'Saving\u2026' : 'Save Answers'}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDismissed(true)}>
          Skip
        </button>
      </div>
    </div>
  )
}

/** V4 inline question rows — question label can wrap to two lines + input + save icon */
function InlineQRows({ labels, isRetrying = false, onSave, onAfterSave }: {
  labels: string[]
  isRetrying?: boolean
  onSave: (answers: Record<string, string>) => Promise<void>
  onAfterSave?: () => void | Promise<void>
}) {
  const normalizeAnswerKey = useCallback((label: string) => {
    return normalizeFieldLabelForSnapshotMatch(label).toLowerCase().replace(/\s+/g, ' ').trim()
  }, [])
  const labelsKey = useMemo(() => labels.join('\u0001'), [labels])
  const stableLabels = useMemo(() => (labelsKey ? labelsKey.split('\u0001') : []), [labelsKey])
  const labelMeta = useMemo(() => {
    return stableLabels.map((label) => ({
      label,
      key: normalizeAnswerKey(label),
      legacyKey: label.toLowerCase().replace(/\s+/g, ' ').trim()
    }))
  }, [stableLabels, normalizeAnswerKey])
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [savedLabels, setSavedLabels] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState<string | null>(null)
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({})

  // Load cached answers for the currently displayed stuck labels only.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const applicant = await getLoa().applicantGet()
        if (!applicant.ok || !applicant.profile?.screeningAnswerCache) {
          if (!cancelled) {
            setSavedLabels(new Set())
          }
          return
        }
        const cache = applicant.profile.screeningAnswerCache
        const cachedByLabel: Record<string, string> = {}
        const nextSaved = new Set<string>()
        for (const { label, key, legacyKey } of labelMeta) {
          const cached = cache[key] ?? cache[legacyKey]
          if (!cached) continue
          cachedByLabel[label] = String(cached)
          nextSaved.add(label)
        }
        if (!cancelled) {
          setAnswers((prev) => {
            const next: Record<string, string> = {}
            for (const { label } of labelMeta) {
              const typed = prev[label]
              if (typed && typed.trim()) {
                next[label] = typed
                continue
              }
              if (cachedByLabel[label]) next[label] = cachedByLabel[label]
            }
            return next
          })
          setSavedLabels(nextSaved)
        }
      } catch { /* silently ignore fetch errors */ }
    })()
    return () => { cancelled = true }
  }, [labelMeta])

  const handleSave = async (label: string) => {
    const val = (answers[label] || '').trim()
    if (!val) return
    setSaving(label)
    try {
      const key = normalizeAnswerKey(label)
      await onSave({ [key]: val })
      setSavedLabels(prev => new Set([...prev, label]))
      if (onAfterSave) await onAfterSave()
    } catch { /* parent handles feedback */ }
    finally { setSaving(null) }
  }

  const allSaved = labels.length > 0 && labels.every(label => savedLabels.has(label))
  if (allSaved) {
    return (
      <div className="queue-accordion__q-saved" role="status">
        {'\u2713'} Answers saved {isRetrying ? `\u2014 retrying\u2026` : ''}
      </div>
    )
  }

  return (
    <div className="queue-accordion__q-list" role="region" aria-label="Answer stuck questions">
      {labels.map(label => {
        const isSaved = savedLabels.has(label)
        if (isSaved) {
          return (
            <div key={label} className="queue-accordion__q-row queue-accordion__q-row--saved">
              <span className="queue-accordion__q-label">{label}</span>
              <span className="queue-accordion__q-check">{'\u2713'}</span>
            </div>
          )
        }
        const val = (answers[label] || '').trim()
        return (
          <div key={label} className="queue-accordion__q-row">
            <span className="queue-accordion__q-label">{label}</span>
            <input
              ref={el => { inputRefs.current[label] = el }}
              className="queue-accordion__q-input"
              type="text"
              value={answers[label] || ''}
              onChange={e => setAnswers(prev => ({ ...prev, [label]: e.target.value }))}
              placeholder="Your answer"
              aria-label={`Answer for: ${label}`}
              onKeyDown={e => {
                if (e.key === 'Enter' && val) {
                  e.preventDefault()
                  void handleSave(label)
                }
              }}
            />
            <button
              type="button"
              className="queue-accordion__q-save"
              disabled={!val || saving === label}
              aria-busy={saving === label}
              aria-label={`Save answer for ${label}`}
              onClick={() => void handleSave(label)}
            >
              {'\u21B5'}
            </button>
          </div>
        )
      })}
    </div>
  )
}
