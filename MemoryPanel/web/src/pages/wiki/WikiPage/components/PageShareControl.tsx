/**
 * PageShareControl — per-page visibility control (Pillar-4). On mount it loads the wiki's page-share
 * map (owner-only endpoint) and finds this page's current visibility; the owner can set Inherit /
 * Private / Team. "Inherit" clears the override (the page follows the wiki again). The control is
 * ALWAYS rendered so it's discoverable: for non-owners (or if the status can't be loaded) it shows a
 * disabled state with a short hint instead of vanishing.
 */
import { useEffect, useState } from 'react';
import { Select } from 'tea-component';
import { knowledgeApi } from '@/lib/knowledge-api';
import { tea } from '@/lib/tea-bridge';

function canonical(ref: string): string {
  return ref.replace(/^wiki\//, '').replace(/\.md$/, '');
}

const OPTIONS = [
  { value: 'inherit', text: 'Inherit (wiki default)' },
  { value: 'private', text: 'Private — only me' },
  { value: 'team', text: 'Team — everyone' },
];

export default function PageShareControl(props: { wikiId: string; pageRef: string }) {
  const [value, setValue] = useState('inherit');
  const [busy, setBusy] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [hint, setHint] = useState('loading…');

  const pid = canonical(props.pageRef);

  useEffect(() => {
    let alive = true;
    setHint('loading…');
    knowledgeApi.wiki
      .pageShareList(props.wikiId)
      .then((shares) => {
        if (!alive) return;
        setCanEdit(true);
        setValue(shares[pid]?.visibility ?? 'inherit');
        setHint('');
      })
      .catch((e: any) => {
        if (!alive) return;
        setCanEdit(false);
        setHint(e?.code === 403 || /owner/i.test(e?.rawMessage || e?.message || '') ? 'only the wiki owner can change sharing' : 'sharing status unavailable');
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.wikiId, props.pageRef]);

  async function change(next: string): Promise<void> {
    setBusy(true);
    try {
      await knowledgeApi.wiki.pageShareSet(props.wikiId, props.pageRef, next === 'inherit' ? null : next);
      setValue(next);
      tea.notify.success(next === 'inherit' ? 'Page now inherits the wiki.' : `Page is now “${next}”.`);
    } catch (e) {
      tea.notify.error(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0 10px' }}>
      <span style={{ fontSize: 12, color: '#888', whiteSpace: 'nowrap' }}>Who can see this page:</span>
      <Select
        size="s"
        value={value}
        onChange={(v) => void change(v as string)}
        options={OPTIONS}
        disabled={busy || !canEdit}
      />
      {hint && <span style={{ fontSize: 11, color: '#aaa' }}>{hint}</span>}
    </div>
  );
}
