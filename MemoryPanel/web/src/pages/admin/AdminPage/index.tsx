/**
 * AdminPage — the former standalone :8901 admin UI, folded into the panel ("not two links").
 *
 * Four sections, all read from `/api/v1/admin/*` (server-side gated on user_type=system_admin):
 *   - Connect requests (pending pairings) + Approve
 *   - Chain integrity (tamper-evident ledger verify)
 *   - Knowledge gaps (what the team's memory can't answer)
 *   - Provenance ledger (who did what)
 *
 * The nav item is only shown to global admins (ConsoleLayout filters on userRole==='admin'); the
 * server enforces the real boundary, so a non-admin hitting this route directly still gets 403s.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Button } from 'tea-component';
import {
  fetchPending,
  approvePairing,
  fetchAudit,
  fetchVerify,
  fetchGaps,
  fetchGrants,
  revokeGrant,
  type PendingPairing,
  type AuditEvent,
  type KnowledgeGap,
  type VerifyResult,
  type AclGrant,
} from '@/lib/api/admin';
import './admin-page.css';

function fmtTs(ts: number): string {
  if (!ts) return '—';
  // ledger ts is epoch seconds (float)
  const d = new Date(ts * 1000);
  return d.toLocaleString();
}

export function AdminPage() {
  const { t } = useTranslation();

  const [pending, setPending] = useState<PendingPairing[]>([]);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [gaps, setGaps] = useState<KnowledgeGap[]>([]);
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [grants, setGrants] = useState<AclGrant[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [p, a, g, v, gr] = await Promise.all([
        fetchPending().catch(() => [] as PendingPairing[]),
        fetchAudit(50).catch(() => [] as AuditEvent[]),
        fetchGaps().catch(() => ({ gaps: [] as KnowledgeGap[], sources: 0 })),
        fetchVerify().catch(() => null),
        fetchGrants().catch(() => [] as AclGrant[]),
      ]);
      setPending(p);
      setAudit(a);
      setGaps(g.gaps);
      setVerify(v);
      setGrants(gr);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onApprove = useCallback(
    async (code: string) => {
      setApproving(code);
      setError(null);
      try {
        await approvePairing(code);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setApproving(null);
      }
    },
    [load],
  );

  const onRevoke = useCallback(
    async (id: string) => {
      setRevoking(id);
      setError(null);
      try {
        await revokeGrant(id);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setRevoking(null);
      }
    },
    [load],
  );

  return (
    <div className="_admin-page">
      <div className="_admin-head">
        <div>
          <h2>{t('admin.title')}</h2>
          <p className="_admin-sub">{t('admin.subtitle')}</p>
        </div>
        <Button type="weak" onClick={() => void load()} disabled={loading}>
          {loading ? t('admin.loading') : t('admin.refresh')}
        </Button>
      </div>

      {error && <div className="_admin-error">{error}</div>}

      {/* ===== Connect requests ===== */}
      <Card>
        <Card.Body title={t('admin.pending.title')}>
          <p className="_admin-section-sub">{t('admin.pending.subtitle')}</p>
          {pending.length === 0 ? (
            <div className="_admin-empty">{t('admin.pending.empty')}</div>
          ) : (
            <table className="_admin-table">
              <thead>
                <tr>
                  <th>{t('admin.pending.code')}</th>
                  <th>{t('admin.pending.client')}</th>
                  <th>{t('admin.pending.kind')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pending.map((r) => (
                  <tr key={r.user_code}>
                    <td className="_mono">{r.user_code}</td>
                    <td>{r.client ?? '—'}</td>
                    <td>{r.kind ?? '—'}</td>
                    <td className="_admin-right">
                      <Button
                        type="primary"
                        onClick={() => void onApprove(r.user_code)}
                        disabled={approving === r.user_code}
                      >
                        {approving === r.user_code ? t('admin.pending.approving') : t('admin.pending.approve')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card.Body>
      </Card>

      {/* ===== Chain integrity ===== */}
      <Card>
        <Card.Body title={t('admin.verify.title')}>
          <p className="_admin-section-sub">{t('admin.verify.subtitle')}</p>
          {verify ? (
            <div className="_admin-verify">
              <span className={verify.ok ? '_admin-badge ok' : '_admin-badge bad'}>
                {verify.ok ? t('admin.verify.ok') : t('admin.verify.bad')}
              </span>
              <span className="_admin-verify-meta">
                {t('admin.verify.events', { count: verify.events })}
              </span>
              {verify.tip && <code className="_admin-tip" title={verify.tip}>{verify.tip.slice(0, 16)}…</code>}
            </div>
          ) : (
            <div className="_admin-empty">{t('admin.verify.unavailable')}</div>
          )}
        </Card.Body>
      </Card>

      {/* ===== Grants (who can see what) ===== */}
      <Card>
        <Card.Body title={t('admin.grants.title')}>
          <p className="_admin-section-sub">{t('admin.grants.subtitle')}</p>
          {grants.length === 0 ? (
            <div className="_admin-empty">{t('admin.grants.empty')}</div>
          ) : (
            <table className="_admin-table">
              <thead>
                <tr>
                  <th>{t('admin.grants.asset')}</th>
                  <th>{t('admin.grants.subject')}</th>
                  <th>{t('admin.grants.permission')}</th>
                  <th>{t('admin.grants.expires')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {grants.map((g) => (
                  <tr key={g.id}>
                    <td className="_mono">{g.asset_id}</td>
                    <td className="_mono">
                      {g.subject_type}:{g.subject_id}
                      {g.effect === 'deny' && <span className="_admin-tag">deny</span>}
                    </td>
                    <td>{g.permission}</td>
                    <td className="_admin-nowrap">{g.expires_at ? new Date(g.expires_at).toLocaleDateString() : '—'}</td>
                    <td className="_admin-right">
                      <Button
                        type="weak"
                        onClick={() => void onRevoke(g.id)}
                        disabled={revoking === g.id}
                      >
                        {revoking === g.id ? t('admin.grants.revoking') : t('admin.grants.revoke')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card.Body>
      </Card>

      {/* ===== Knowledge gaps ===== */}
      <Card>
        <Card.Body title={t('admin.gaps.title')}>
          <p className="_admin-section-sub">{t('admin.gaps.subtitle')}</p>
          {gaps.length === 0 ? (
            <div className="_admin-empty">{t('admin.gaps.empty')}</div>
          ) : (
            <table className="_admin-table">
              <thead>
                <tr>
                  <th>{t('admin.gaps.source')}</th>
                  <th>{t('admin.gaps.question')}</th>
                </tr>
              </thead>
              <tbody>
                {gaps.map((g, i) => (
                  <tr key={`${g.source_id}-${i}`}>
                    <td className="_mono">
                      {g.source_id}
                      <span className="_admin-tag">{g.source_type}</span>
                    </td>
                    <td>{g.gap}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card.Body>
      </Card>

      {/* ===== Provenance ledger ===== */}
      <Card>
        <Card.Body title={t('admin.audit.title')}>
          <p className="_admin-section-sub">{t('admin.audit.subtitle')}</p>
          {audit.length === 0 ? (
            <div className="_admin-empty">{t('admin.audit.empty')}</div>
          ) : (
            <table className="_admin-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>{t('admin.audit.when')}</th>
                  <th>{t('admin.audit.action')}</th>
                  <th>{t('admin.audit.actor')}</th>
                  <th>{t('admin.audit.target')}</th>
                  <th>{t('admin.audit.team')}</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((ev) => (
                  <tr key={ev.seq}>
                    <td>{ev.seq}</td>
                    <td className="_admin-nowrap">{fmtTs(ev.ts)}</td>
                    <td className="_mono">{ev.action ?? ev.type ?? '—'}</td>
                    <td>{ev.actor_name ?? ev.actor_id ?? '—'}</td>
                    <td className="_mono">
                      {ev.target_type ? `${ev.target_type}:` : ''}
                      {ev.target_id ?? '—'}
                    </td>
                    <td className="_mono">{ev.group ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card.Body>
      </Card>
    </div>
  );
}
