import React, { useMemo, useState } from 'react'
import type { TargetRow } from '@core/types'
import { getLoa } from '@/loa-client'

interface TargetListPreviewProps {
  targets: TargetRow[]
  selectedTargets: TargetRow[]
  excludedIndices: Set<number>
  sendLimit: number | null
  onToggle: (index: number) => void
  onSelectAll: () => void
  onDeselectAll: () => void
  onSendLimitChange: (n: number | null) => void
}

function displayName(row: TargetRow): string {
  if (row.personName) return row.personName
  if (row.firstName) return row.firstName
  if (row.profileUrl) {
    const slug = row.profileUrl.replace(/\/$/, '').split('/').pop() || ''
    return slug.replace(/-/g, ' ')
  }
  return 'Unknown'
}

function shortUrl(url: string | undefined): string {
  if (!url) return ''
  return url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')
}

function rowStableIdentity(row: TargetRow): string {
  const profile = String(row.profileUrl || '').trim().toLowerCase()
  if (profile) return `profile:${profile}`
  const name = String(row.personName || row.firstName || '').trim().toLowerCase()
  const company = String(row.company || '').trim().toLowerCase()
  const headline = String(row.headline || '').trim().toLowerCase()
  return `row:${name}|${company}|${headline}`
}

export const TargetListPreview = React.memo(function TargetListPreview({
  targets,
  selectedTargets,
  excludedIndices,
  sendLimit,
  onToggle,
  onSelectAll,
  onDeselectAll,
  onSendLimitChange
}: TargetListPreviewProps) {
  const [expanded, setExpanded] = useState(true)
  const [visibleLimit, setVisibleLimit] = useState(50)
  const includedCount = targets.length - excludedIndices.size
  const effectiveCount = sendLimit != null ? Math.min(sendLimit, includedCount) : includedCount
  const allSelected = excludedIndices.size === 0 && sendLimit == null
  const rowKeys = useMemo(() => {
    const identityCounts = new Map<string, number>()
    return targets.map((row) => {
      const base = rowStableIdentity(row)
      const seen = identityCounts.get(base) || 0
      identityCounts.set(base, seen + 1)
      return `${base}#${seen}`
    })
  }, [targets])

  const beyondLimitIndices = useMemo(() => {
    if (sendLimit == null) return new Set<number>()
    const beyond = new Set<number>()
    let count = 0
    for (let i = 0; i < targets.length; i++) {
      if (!excludedIndices.has(i)) {
        count++
        if (count > sendLimit) beyond.add(i)
      }
    }
    return beyond
  }, [targets, excludedIndices, sendLimit])

  return (
    <div className="target-list">
      <div className="target-list__header">
        <div className="target-list__count-control">
          <label className="target-list__send-label" htmlFor="send-count">
            Send to
          </label>
          <input
            id="send-count"
            type="number"
            className="target-list__send-input"
            min={0}
            max={includedCount}
            value={effectiveCount}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10)
              if (isNaN(v) || v >= includedCount) {
                onSendLimitChange(null)
              } else {
                onSendLimitChange(Math.max(0, v))
              }
            }}
          />
          <span className="target-list__send-of">of {targets.length} {targets.length === 1 ? 'person' : 'people'}</span>
        </div>
        {targets.length > 1 && (
          <div className="target-list__bulk-actions">
            {!allSelected && (
              <button type="button" className="btn btn-ghost btn-xs" onClick={onSelectAll}>
                Select all
              </button>
            )}
            {excludedIndices.size < targets.length && (
              <button type="button" className="btn btn-ghost btn-xs" onClick={onDeselectAll}>
                Deselect all
              </button>
            )}
          </div>
        )}
      </div>

      {targets.length > 0 && sendLimit != null && sendLimit < includedCount && (
        <p className="target-list__limit-hint muted caption">
          Sending to the first {effectiveCount} of {includedCount} selected — use &quot;Send to&quot; above to change.
        </p>
      )}

      {targets.length > 0 && (
        <button
          type="button"
          className="btn btn-ghost btn-xs target-list__expand-btn"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
        >
          {expanded ? 'Hide list' : `Show ${targets.length} ${targets.length === 1 ? 'person' : 'people'}`}
        </button>
      )}

      {expanded && targets.length > 0 && (
        <>
          <div className="target-list__col-header">
            <span />
            <span>Name</span>
            <span>Title / Company</span>
            <span>Profile</span>
            <span />
          </div>
          <ul className="target-list__people" role="list">
            {targets.slice(0, visibleLimit).map((row, i) => {
              const excluded = excludedIndices.has(i)
              const beyondLimit = !excluded && beyondLimitIndices.has(i)
              const willSend = !excluded && !beyondLimit

              return (
                <li
                  key={rowKeys[i]}
                  className={`target-list__person ${!willSend ? 'target-list__person--excluded' : ''}`}
                >
                  <label className="target-list__person-label">
                    <input
                      type="checkbox"
                      checked={!excluded}
                      onChange={() => onToggle(i)}
                      className="target-list__checkbox"
                    />
                    <span className="target-list__person-name">{displayName(row)}</span>
                    {row.company ? (
                      <span className="target-list__person-company">{row.headline && !row.headline.toLowerCase().includes(row.company.toLowerCase()) ? `${row.headline} at ${row.company}` : row.headline || row.company}</span>
                    ) : row.headline ? (
                      <span className="target-list__person-headline">{row.headline}</span>
                    ) : (
                      <span />
                    )}
                    {row.profileUrl ? (
                      <a
                        href={row.profileUrl}
                        className="target-list__person-url"
                        onClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          void getLoa().openExternalUrl(row.profileUrl!).catch(() => {})
                        }}
                        title={`Open ${row.profileUrl} in your browser`}
                        rel="noreferrer noopener"
                      >
                        {shortUrl(row.profileUrl)}
                      </a>
                    ) : (
                      <span className="target-list__person-url" />
                    )}
                    {!willSend && !excluded ? (
                      <span className="target-list__person-badge">over limit</span>
                    ) : (
                      <span />
                    )}
                  </label>
                </li>
              )
            })}
          </ul>
          {targets.length > visibleLimit && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setVisibleLimit(l => l + 50)}>
              Show more ({targets.length - visibleLimit} remaining)
            </button>
          )}
        </>
      )}
    </div>
  )
})
