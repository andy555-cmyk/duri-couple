import { useState } from 'react';
import { GeminiError, quickCheck } from '../lib/gemini';
import { makeT } from '../lib/i18n';
import type { Lang, Profile } from '../lib/types';
import { useApp } from './AppContext';
import { Icon } from './Icon';
import { ProfileFields } from './UsView';

const STUDIO_URL = 'https://aistudio.google.com/apikey';

export function KeyForm({ onDone, compact = false }: { onDone: () => void; compact?: boolean }) {
  const app = useApp();
  const { t } = app;
  const [draft, setDraft] = useState(app.settings.apiKey);
  const [show, setShow] = useState(false);
  const [state, setState] = useState<{ phase: 'idle' | 'checking' | 'ok' | 'error'; text?: string; canSave?: boolean }>({ phase: 'idle' });

  const clean = draft.replace(/\s/g, '');
  const saveKey = () => app.setSettings((s) => ({ ...s, apiKey: clean }));

  async function check() {
    if (!clean) return;
    setState({ phase: 'checking' });
    try {
      const result = await quickCheck(clean);
      saveKey();
      setState({ phase: 'ok', text: t('ob.ok', { model: result.model.replace('gemini-', ''), s: (result.ms / 1000).toFixed(1) }) });
      setTimeout(onDone, 900);
    } catch (caught) {
      const kind = caught instanceof GeminiError ? caught.kind : '';
      setState({ phase: 'error', text: app.errorText(caught), canSave: kind !== 'key' });
    }
  }

  async function paste() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setDraft(text.trim());
    } catch {
      app.toast(t('msg.noClip'));
    }
  }

  return (
    <div className="key-form">
      {!compact && <p className="lead">{t('ob.keyHelp')}</p>}
      <ol className="steps">
        <li>{t('ob.step1')}</li>
        <li>{t('ob.step2')}</li>
        <li>{t('ob.step3')}</li>
      </ol>
      <a className="secondary-button" href={STUDIO_URL} target="_blank" rel="noreferrer">
        <Icon name="key" size={16} />
        {t('ob.open')}
      </a>
      <div className="key-input">
        <input
          className="field"
          type={show ? 'text' : 'password'}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={t('ob.keyPh')}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <button className="chip-button" onClick={() => setShow(!show)}>
          {show ? t('ob.hide') : t('ob.show')}
        </button>
        <button className="chip-button" onClick={paste}>
          <Icon name="paste" size={14} />
          {t('key.paste')}
        </button>
      </div>
      <button className="primary-button wide" disabled={!clean || state.phase === 'checking'} onClick={check}>
        {state.phase === 'checking' ? <span className="spinner light" /> : <Icon name="check" size={16} />}
        {state.phase === 'checking' ? t('ob.checking') : t('ob.check')}
      </button>
      {state.phase === 'ok' && <p className="ok-text">{state.text}</p>}
      {state.phase === 'error' && (
        <div className="error-card">
          <p>{state.text}</p>
          {state.canSave && (
            <button
              className="chip-button strong"
              onClick={() => {
                saveKey();
                onDone();
              }}
            >
              {t('key.saveAnyway')}
            </button>
          )}
        </div>
      )}
      <p className="panel-help">{t('ob.safe')}</p>
    </div>
  );
}

export function Onboarding({ invitedBy }: { invitedBy?: string }) {
  const app = useApp();
  const [step, setStep] = useState<0 | 1 | 2>(invitedBy ? 1 : 0);
  const [draft, setDraft] = useState<Profile>(app.profile);
  const t = makeT(draft.myLang);

  const choose = (lang: Lang) => {
    const next = { ...draft, myLang: lang };
    setDraft(next);
    app.setProfile(next);
    setStep(1);
  };
  const finish = () => app.setSettings((s) => ({ ...s, onboarded: true }));

  return (
    <div className="onboarding">
      {step === 0 && (
        <div className="ob-hello">
          <div className="ob-logo" aria-hidden="true">
            <span className="bubble-a">말</span>
            <span className="bubble-b">言</span>
          </div>
          <h1>
            둘의 말 <small>ふたりの言葉</small>
          </h1>
          <p className="ob-sub">
            한국어와 일본어 사이, 둘만의 통역사
            <br />
            韓国語と日本語のあいだ、ふたりだけの通訳
          </p>
          <div className="ob-choices">
            <button className="primary-button wide" onClick={() => choose('ko')}>
              한국어로 쓸게요
            </button>
            <button className="primary-button wide coral" onClick={() => choose('ja')}>
              日本語で使います
            </button>
          </div>
        </div>
      )}
      {step === 1 && (
        <div className="ob-step">
          {invitedBy && <p className="invite">{t('ob.invite', { name: invitedBy })}</p>}
          <h2>{t('ob.about')}</h2>
          <p className="lead">{t('ob.aboutHelp')}</p>
          <ProfileFields value={draft} onChange={setDraft} showLang={!!invitedBy} />
          <div className="button-row">
            {!invitedBy && (
              <button className="secondary-button" onClick={() => setStep(0)}>
                {t('back')}
              </button>
            )}
            <button
              className="primary-button"
              onClick={() => {
                app.setProfile(draft);
                setStep(2);
              }}
            >
              {t('next')}
            </button>
          </div>
        </div>
      )}
      {step === 2 && (
        <div className="ob-step">
          <h2>{t('ob.keyTitle')}</h2>
          <KeyForm onDone={finish} />
          <div className="button-row">
            <button className="secondary-button" onClick={() => setStep(1)}>
              {t('back')}
            </button>
            <button className="link-button" onClick={finish}>
              {t('later')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
