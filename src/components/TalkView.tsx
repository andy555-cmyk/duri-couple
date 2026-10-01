import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { errorKey, makeT } from '../lib/i18n';
import { speak } from '../lib/speech';
import { dateKey } from '../lib/store';
import type { Lang, Tone, Turn } from '../lib/types';
import { useApp } from './AppContext';
import { Icon } from './Icon';
import { readingOf, textIn, translated, TurnCard } from './TurnCard';
import { useTalk, type Talk } from './useTalk';
import { useElapsed } from './useVoice';

const TONES: { id: Tone; mark: string }[] = [
  { id: 'sweet', mark: '♡' },
  { id: 'natural', mark: '○' },
  { id: 'playful', mark: '☺' },
  { id: 'serious', mark: '◇' },
];

export function dayLabel(ts: number, lang: Lang, t: (k: 'today' | 'yesterday') => string) {
  const key = dateKey(ts);
  if (key === dateKey(Date.now())) return t('today');
  if (key === dateKey(Date.now() - 86400000)) return t('yesterday');
  return new Date(ts).toLocaleDateString(lang === 'ko' ? 'ko-KR' : 'ja-JP', { month: 'long', day: 'numeric', weekday: 'short' });
}

export function TalkView({ face, onCloseFace }: { face: boolean; onCloseFace: () => void }) {
  const app = useApp();
  const { t, my } = app;
  const talk = useTalk();
  const [limit, setLimit] = useState(40);
  const thread = useRef<HTMLDivElement>(null);
  const talkTurns = useMemo(() => app.turns.filter((turn) => turn.channel === 'talk'), [app.turns]);
  const shown = talkTurns.slice(-limit);

  const scrolled = useRef(false);
  useEffect(() => {
    const el = thread.current;
    if (!el) return;
    const behavior = scrolled.current ? 'smooth' : 'auto';
    scrolled.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior });
    // fonts and the alt box can grow the list right after mount
    const late = setTimeout(() => el.scrollTo({ top: el.scrollHeight, behavior }), 120);
    return () => clearTimeout(late);
  }, [talkTurns.length, talk.working, talk.error]);

  const update = useCallback((turn: Turn) => app.setTurns((prev) => prev.map((x) => (x.id === turn.id ? turn : x))), [app.setTurns]);
  const remove = useCallback((id: string) => app.setTurns((prev) => prev.filter((x) => x.id !== id)), [app.setTurns]);

  return (
    <div className="talk">
      <div className="thread" ref={thread}>
        {talkTurns.length > limit && (
          <button className="older" onClick={() => setLimit((n) => n + 40)}>
            {t('talk.older')}
          </button>
        )}
        {shown.length === 0 && !talk.working && (
          <div className="empty-talk">
            <div className="empty-mark" aria-hidden="true">
              <span className="bubble-a">말</span>
              <span className="bubble-b">言</span>
            </div>
            <h2>{t('talk.emptyTitle')}</h2>
            <p>{t('talk.emptyBody')}</p>
            <p className="try-label">{t('talk.try')}</p>
            <div className="try-list">
              {(['talk.ex1', 'talk.ex2', 'talk.ex3'] as const).map((key) => (
                <button key={key} onClick={() => talk.sendText(t(key))}>
                  {t(key)}
                </button>
              ))}
            </div>
          </div>
        )}
        {shown.map((turn, index) => {
          const showDay = index === 0 || dateKey(shown[index - 1].ts) !== dateKey(turn.ts);
          return (
            <Fragment key={turn.id}>
              {showDay && (
                <div className="day-label">
                  <span />
                  {dayLabel(turn.ts, my, t)}
                  <span />
                </div>
              )}
              <TurnCard turn={turn} onChange={update} onDelete={remove} partnerLabel={app.partnerName} />
            </Fragment>
          );
        })}
        {talk.working && <PendingCard talk={talk} />}
        {talk.error && !talk.working && (
          <div className="error-card" role="alert">
            <p>{talk.error.text}</p>
            <div className="action-row">
              {talk.error.retry && (
                <button className="chip-button strong" onClick={talk.retry}>
                  <Icon name="refresh" size={15} />
                  {t('retry')}
                </button>
              )}
              {(talk.error.kind === 'nokey' || talk.error.kind === 'key') && (
                <button className="chip-button strong" onClick={app.openKey}>
                  <Icon name="key" size={15} />
                  {t('err.openKey')}
                </button>
              )}
              <button className="chip-button" onClick={talk.dismiss}>
                {t('close')}
              </button>
            </div>
          </div>
        )}
      </div>
      <Composer talk={talk} />
      {face && <FaceToFace talk={talk} turns={talkTurns} onClose={onCloseFace} />}
    </div>
  );
}

function PendingCard({ talk }: { talk: Talk }) {
  const { t } = useApp();
  const seconds = useElapsed(talk.working, talk.workingSince);
  return (
    <div className={`pending ${talk.pendingText ? 'mine' : ''}`}>
      {talk.pendingText && <p className="pending-text">{talk.pendingText}</p>}
      <div className="pending-row">
        <span className="spinner" />
        <span>{t('talk.work')}</span>
        <span className="muted">
          {seconds}s{talk.model ? ` · ${talk.model.replace('gemini-', '')}` : ''}
        </span>
        {seconds >= 6 && (
          <button className="link-button" onClick={talk.stopWork}>
            {t('cancel')}
          </button>
        )}
      </div>
      <div className="skeleton" />
      <div className="skeleton short" />
    </div>
  );
}

function Composer({ talk }: { talk: Talk }) {
  const { t, settings, setSettings } = useApp();
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');
  const [toneOpen, setToneOpen] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const tone = TONES.find((x) => x.id === settings.tone) || TONES[1];

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [draft, typing]);

  const submit = () => {
    if (!draft.trim() || talk.working) return;
    talk.sendText(draft);
    setDraft('');
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="composer">
      {toneOpen && (
        <div className="tone-pop" role="menu">
          <p>{t('tone.title')}</p>
          {TONES.map((x) => (
            <button
              key={x.id}
              className={x.id === settings.tone ? 'on' : ''}
              onClick={() => {
                setSettings((s) => ({ ...s, tone: x.id }));
                setToneOpen(false);
              }}
            >
              <span>{x.mark}</span>
              {t(`tone.${x.id}`)}
            </button>
          ))}
        </div>
      )}
      {typing ? (
        <div className="type-row">
          <button className="round-button" onClick={() => setTyping(false)} aria-label={t('talk.voice')}>
            <Icon name="mic" />
          </button>
          <textarea
            ref={area}
            rows={1}
            value={draft}
            autoFocus
            placeholder={t('talk.typePh')}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKey}
            enterKeyHint="send"
          />
          <button className="send-button" onClick={submit} disabled={!draft.trim() || talk.working} aria-label={t('share')}>
            <Icon name="send" />
          </button>
        </div>
      ) : (
        <div className="mic-row">
          <button
            className="round-button"
            onClick={() => (talk.phase === 'recording' ? talk.voice.cancel() : setTyping(true))}
            aria-label={talk.phase === 'recording' ? t('talk.cancelRec') : t('talk.keyboard')}
          >
            <Icon name={talk.phase === 'recording' ? 'close' : 'keyboard'} />
          </button>
          <MicButton talk={talk} onPress={() => (talk.phase === 'recording' ? void talk.voice.stop() : talk.startVoice())} />
          <button className="round-button tone-button" onClick={() => setToneOpen(!toneOpen)} aria-label={t('tone.title')}>
            <span className="tone-mark">{tone.mark}</span>
            <small>{t(`tone.${tone.id}`)}</small>
          </button>
        </div>
      )}
    </div>
  );
}

export function MicButton({
  talk,
  onPress,
  label,
  sub,
  lang,
  big = true,
}: {
  talk: Talk;
  onPress: () => void;
  label?: { idle: string; rec: string; work: string };
  sub?: string;
  lang?: Lang;
  big?: boolean;
}) {
  const app = useApp();
  const t = lang ? makeT(lang) : app.t;
  const phase = talk.phase;
  const seconds = useElapsed(phase === 'recording', talk.voice.startedAt);
  const text = label || { idle: t('talk.mic'), rec: t('talk.rec'), work: t('talk.work') };
  return (
    <button
      ref={(el) => {
        if (phase === 'recording') talk.voice.levelEl.current = el;
      }}
      className={`mic ${phase} ${big ? 'big' : ''}`}
      onClick={onPress}
      disabled={phase === 'working'}
    >
      <span className="mic-visual" aria-hidden="true">
        {phase === 'recording' ? (
          <span className="bars">
            <i />
            <i />
            <i />
            <i />
            <i />
          </span>
        ) : phase === 'working' ? (
          <span className="spinner light" />
        ) : (
          <Icon name="mic" size={big ? 26 : 22} />
        )}
      </span>
      <span className="mic-text">
        <b>{phase === 'recording' ? text.rec : phase === 'working' ? text.work : text.idle}</b>
        <small>{phase === 'recording' ? t('talk.recSub', { s: seconds }) : phase === 'working' ? '' : sub ?? t('talk.micSub')}</small>
      </span>
    </button>
  );
}

function FaceToFace({ talk, turns, onClose }: { talk: Talk; turns: Turn[]; onClose: () => void }) {
  const app = useApp();
  const last = turns[turns.length - 1];
  const out = last ? translated(last) : null;
  return (
    <div className="face" role="dialog" aria-modal="true">
      <FaceHalf lang={app.their} talk={talk} last={last} flipped />
      <div className="face-divider">
        <button className="round-button" onClick={onClose} aria-label={app.t('close')}>
          <Icon name="close" />
        </button>
        <button className="round-button" disabled={!out} onClick={() => out && speak(out.text, out.lang, 1)} aria-label={app.t('face.replay')}>
          <Icon name="play" fill />
        </button>
        <button
          className={`round-button ${app.settings.autoSpeak ? 'on' : ''}`}
          onClick={() => app.setSettings((s) => ({ ...s, autoSpeak: !s.autoSpeak }))}
          aria-label={app.t('us.autoSpeak')}
        >
          <Icon name={app.settings.autoSpeak ? 'speaker' : 'speakerOff'} />
        </button>
      </div>
      <FaceHalf lang={app.my} talk={talk} last={last} />
    </div>
  );
}

function FaceHalf({ lang, talk, last, flipped = false }: { lang: Lang; talk: Talk; last?: Turn; flipped?: boolean }) {
  const t = makeT(lang);
  const fromOther = last && last.lang !== lang;
  let big = '';
  if (last) {
    const out = translated(last);
    big = out.lang === lang ? out.text : textIn(last, lang);
  }
  const mineRecording = talk.phase === 'recording' && talk.forcedLang.current === lang;
  const otherRecording = talk.phase === 'recording' && !mineRecording;
  const error = talk.error ? t(errorKey(talk.error.kind) || 'err.format') : '';
  return (
    <section className={`face-half ${flipped ? 'flipped' : ''}`} lang={lang}>
      <div className="face-text">
        {talk.working ? (
          <p className="face-wait">
            <span className="spinner" /> {t('talk.work')}
          </p>
        ) : error && !mineRecording ? (
          <p className="face-error">{error}</p>
        ) : last ? (
          <>
            <p className="face-big">{big}</p>
            {fromOther && (
              <p className="face-small">
                <span lang={last.lang}>{textIn(last, last.lang)}</span>
                <span className="reading">{readingOf(last, last.lang)}</span>
              </p>
            )}
          </>
        ) : (
          <p className="face-hint">{t('face.hint')}</p>
        )}
      </div>
      <MicButton
        talk={{ ...talk, phase: mineRecording ? 'recording' : talk.working ? 'working' : 'idle' }}
        lang={lang}
        big={false}
        sub=""
        onPress={() => {
          if (otherRecording) return;
          if (mineRecording) void talk.voice.stop();
          else talk.startVoice(lang);
        }}
      />
    </section>
  );
}
