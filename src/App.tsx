import { lazy, Suspense, useEffect, useState } from 'react';
import { AppProvider, useApp } from './components/AppContext';
import { Icon } from './components/Icon';
import { KeyForm, Onboarding } from './components/Onboarding';
import { Sheet } from './components/Sheet';
import { TalkView } from './components/TalkView';
import { daysTogether } from './lib/prompts';
import { initSpeech } from './lib/speech';
import { mergeGlossary, profileFromShare, readShareHash, useSession, type SharePayload } from './lib/store';

// The talk screen loads first; the other tabs load the first time they are opened.
const MessageView = lazy(() => import('./components/MessageView').then((m) => ({ default: m.MessageView })));
const LearnView = lazy(() => import('./components/LearnView').then((m) => ({ default: m.LearnView })));
const UsView = lazy(() => import('./components/UsView').then((m) => ({ default: m.UsView })));

type Tab = 'talk' | 'msg' | 'learn' | 'us';
const TABS: { id: Tab; icon: string }[] = [
  { id: 'talk', icon: 'chat' },
  { id: 'msg', icon: 'message' },
  { id: 'learn', icon: 'book' },
  { id: 'us', icon: 'people' },
];

function useViewport() {
  const [keyboard, setKeyboard] = useState(false);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let frame = 0;
    const sync = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        document.documentElement.style.setProperty('--vvh', `${vv.height}px`);
        // Only a focused text field with an unzoomed page counts as "keyboard open" (Codex review I4).
        const focused = !!document.activeElement?.matches('input, textarea, [contenteditable="true"]');
        setKeyboard(focused && vv.scale <= 1.01 && window.innerHeight - vv.height > 140);
      });
    };
    sync();
    vv.addEventListener('resize', sync);
    window.addEventListener('focusin', sync);
    window.addEventListener('focusout', sync);
    return () => {
      cancelAnimationFrame(frame);
      vv.removeEventListener('resize', sync);
      window.removeEventListener('focusin', sync);
      window.removeEventListener('focusout', sync);
    };
  }, []);
  return keyboard;
}

function Shell() {
  const app = useApp();
  const { t, settings } = app;
  const [tab, setTab] = useSession<Tab>('duri.tab', 'talk');
  const [face, setFace] = useState(false);
  const [keyOpen, setKeyOpen] = useState(false);
  const [invite, setInvite] = useState<SharePayload | null>(null);
  const keyboard = useViewport();

  useEffect(() => {
    initSpeech();
    const payload = readShareHash(location.hash);
    if (!payload) return;
    history.replaceState(null, '', location.pathname + location.search);
    if (!settings.onboarded) {
      app.setProfile((p) => profileFromShare(payload, p));
      app.setGlossary((g) => mergeGlossary(g, payload.glossary));
    }
    setInvite(payload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (app.keyRequest) setKeyOpen(true);
  }, [app.keyRequest]);

  if (!settings.onboarded) return <Onboarding key={invite ? 'invite' : 'plain'} invitedBy={invite?.fromName || undefined} />;

  const days = daysTogether(app.profile.startDate);
  return (
    <div className={`app ${keyboard ? 'keyboard' : ''}`}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">ふたり</span>
          <b>
            {app.profile.myName || app.profile.partnerName ? (
              <>
                {app.myName} <Icon name="heart" size={12} fill className="heart" /> {app.partnerName}
              </>
            ) : (
              t('appName')
            )}
          </b>
          {days && <span className="dday">{t('dday', { n: days.toLocaleString() })}</span>}
        </div>
        {tab === 'talk' && (
          <div className="top-actions">
            <button
              className={`icon-button ${settings.autoSpeak ? 'on' : ''}`}
              onClick={() => {
                app.setSettings((s) => ({ ...s, autoSpeak: !s.autoSpeak }));
                app.toast(settings.autoSpeak ? t('head.speakOff') : t('head.speakOn'));
              }}
              aria-label={t('us.autoSpeak')}
            >
              <Icon name={settings.autoSpeak ? 'speaker' : 'speakerOff'} />
            </button>
            <button className="live-pill" onClick={() => setFace(true)} aria-label={t('head.face')}>
              <Icon name="bolt" size={16} fill />
              {t('live.mode')}
            </button>
          </div>
        )}
      </header>

      <main className={`screen ${tab === 'talk' ? 'fixed' : ''}`}>
        {tab === 'talk' && <TalkView face={face} onCloseFace={() => setFace(false)} />}
        <Suspense fallback={<div className="page loading-page"><span className="spinner" /></div>}>
          {tab === 'msg' && <MessageView />}
          {tab === 'learn' && <LearnView />}
          {tab === 'us' && <UsView />}
        </Suspense>
      </main>

      <nav className="tabbar" aria-label="tabs">
        {TABS.map((item) => (
          <button key={item.id} className={tab === item.id ? 'on' : ''} onClick={() => setTab(item.id)} aria-current={tab === item.id ? 'page' : undefined}>
            <Icon name={item.icon} size={22} />
            <span>{t(`tab.${item.id}`)}</span>
          </button>
        ))}
      </nav>

      <Sheet open={keyOpen} onClose={() => setKeyOpen(false)} closeLabel={t('close')} title={t('ob.keyTitle')} tall>
        <KeyForm compact onDone={() => setKeyOpen(false)} />
      </Sheet>

      {invite && settings.onboarded && (
        <Sheet open onClose={() => setInvite(null)} closeLabel={t('close')} title={t('join.title', { name: invite.fromName || t('partner') })}>
          <p className="sheet-meaning">{t('join.body', { n: invite.glossary.length })}</p>
          <button
            className="primary-button wide"
            onClick={() => {
              app.setGlossary((g) => mergeGlossary(g, invite.glossary));
              app.setProfile((p) => ({ ...profileFromShare(invite, p), myLang: p.myLang }));
              setInvite(null);
            }}
          >
            {t('join.ok')}
          </button>
        </Sheet>
      )}
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}
