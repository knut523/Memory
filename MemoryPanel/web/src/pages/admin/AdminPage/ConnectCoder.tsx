/**
 * ConnectCoder — the missing "how do I actually connect a coder?" surface.
 *
 * The panel already APPROVES pending pairings (the card below this one); what was missing is the
 * one command a teammate runs on their own machine to show up in that list. There is no API here:
 * the install command is static, parameterised only by client kind (raw / jcode / claude-code).
 * This closes the onboarding loop end-to-end inside the app — run → appears below → Approve.
 */
import { useState } from 'react';
import { Card, Button, Select } from 'tea-component';

// Public pairing entrypoint (device-flow installer) over HTTPS with a trusted Let's Encrypt cert on a
// stable hostname — so a paired coder connects to a named, encrypted endpoint, not a raw-IP "foreign
// entity". The pairing gate is the admin's Approve, not network reachability, so this is public.
const PAIR_BASE = 'https://159-195-148-142.sslip.io/pair-svc/pair';
const ADMIN_URL = 'https://159-195-148-142.sslip.io/tdai-admin/';

const KINDS = [
  { value: 'jcode', text: 'jcode' },
  { value: 'claude-code', text: 'Claude Code' },
  { value: 'raw', text: 'Generic (raw API)' },
];

function cmdFor(kind: string): string {
  return kind === 'raw' ? `curl -s ${PAIR_BASE} | sh` : `curl -s ${PAIR_BASE} | sh -s ${kind}`;
}

export function ConnectCoder() {
  const [kind, setKind] = useState('jcode');
  const [copied, setCopied] = useState(false);
  const cmd = cmdFor(kind);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked (insecure origin) — the command is selectable anyway */
    }
  };

  return (
    <Card>
      <Card.Body title="Connect a coder">
        <p className="_admin-section-sub">
          Give a teammate or an AI coder <b>owned, scoped, revocable</b> access to this team&apos;s memory.
          Three steps, ~30 seconds — no account, no password.
        </p>

        <div className="_connect-row">
          <span className="_connect-step">1</span>
          <div className="_connect-body">
            <div className="_connect-label">Pick the client and run this on the coder&apos;s machine:</div>
            <div className="_connect-kind">
              <Select
                size="s"
                value={kind}
                onChange={(v) => setKind(v as string)}
                options={KINDS}
                appearance="button"
              />
            </div>
            <div className="_connect-cmd">
              <code>{cmd}</code>
              <Button type="weak" onClick={() => void copy()}>
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          </div>
        </div>

        <div className="_connect-row">
          <span className="_connect-step">2</span>
          <div className="_connect-body">
            It prints a short code and a link (<code>{ADMIN_URL}</code>). The coder can just leave it running.
          </div>
        </div>

        <div className="_connect-row">
          <span className="_connect-step">3</span>
          <div className="_connect-body">
            The request appears under <b>Connect requests</b> below — click <b>Approve</b>. A config is written to{' '}
            <code>~/.tdai-memory.json</code> on the coder, and it now has team memory.
          </div>
        </div>
      </Card.Body>
    </Card>
  );
}
