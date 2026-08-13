/**
 * First-run onboarding — a dismissible "getting started" card shown on the workbench.
 *
 * A brand-new user lands on a near-empty workspace; this points them at the three things worth doing
 * first (add knowledge, record memory, browse code) and then gets out of the way. Dismissal is
 * remembered in localStorage so it never nags a returning user. Frontend-only, no backend.
 */
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card, Button } from 'tea-component';
import './onboarding-card.css';

const DISMISS_KEY = 'tdai-onboarding-dismissed';

interface Step {
  key: string;
  path: string;
}

const STEPS: Step[] = [
  { key: 'wiki', path: '/wiki' },
  { key: 'memory', path: '/memory' },
  { key: 'code', path: '/code' },
];

export function OnboardingCard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [visible, setVisible] = useState<boolean>(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) !== '1';
    } catch {
      return true;
    }
  });

  const dismiss = useCallback(() => {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* private mode etc. — just hide for this session */
    }
    setVisible(false);
  }, []);

  if (!visible) return null;

  return (
    <Card className="_onboarding-card">
      <Card.Body>
        <div className="_onboarding-head">
          <div>
            <h3 className="_onboarding-title">{t('onboarding.title')}</h3>
            <p className="_onboarding-sub">{t('onboarding.subtitle')}</p>
          </div>
          <Button type="text" onClick={dismiss} className="_onboarding-dismiss">
            {t('onboarding.dismiss')}
          </Button>
        </div>
        <div className="_onboarding-steps">
          {STEPS.map((s, i) => (
            <button key={s.key} className="_onboarding-step" onClick={() => navigate(s.path)}>
              <span className="_onboarding-step-num">{i + 1}</span>
              <span className="_onboarding-step-text">
                <span className="_onboarding-step-title">{t(`onboarding.${s.key}.title`)}</span>
                <span className="_onboarding-step-desc">{t(`onboarding.${s.key}.desc`)}</span>
              </span>
            </button>
          ))}
        </div>
      </Card.Body>
    </Card>
  );
}
