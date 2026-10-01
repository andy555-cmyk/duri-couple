import { useEffect, useMemo, useRef, useState } from 'react';
import { blobToBase64, callGemini, GeminiError } from '../lib/gemini';
import {
  DAILY_SCHEMA,
  dailyFrom,
  dailyPrompt,
  PRONOUNCE_SCHEMA,
  pronouncePrompt,
  systemPrompt,
  TALK_SCHEMA,
  talkPrompt,
  turnFromTalk,
  type DailyJson,
  type PronounceJson,
  type TalkJson,
} from '../lib/prompts';
import { speak } from '../lib/speech';
import { dateKey, duePhrases, grade, phraseFrom, uid } from '../lib/store';
import type { Lang, Phrase } from '../lib/types';
import { useApp } from './AppContext';
import { Icon } from './Icon';
import { ErrorBox } from './MessageView';
import { Sheet } from './Sheet';
import { SpeakButtons } from './TurnCard';
import { useElapsed, useVoice } from './useVoice';

interface Card {
  target: string;
  reading: string;
  meaning: string;
  meaningReading?: string;
  note?: string;
  lang: Lang;
}

export function LearnView() {
  const app = useApp();
  const { t, my, their, settings, phrases } = app;
  const [dailyBusy, setDailyBusy] = useState(false);
  const [error, setError] = useState<{ text: string; kind: string } | null>(null);
  const [practice, setPractice] = useState<Card | null>(null);
  const [review, setReview] = useState(false);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const today = dateKey(Date.now());
  const due = useMemo(() => duePhrases(phrases), [phrases]);

  const cardOf = (p: { ko: string; ja: string; koKana: string; jaHangul: string; note?: string }): Card => ({
    lang: their,
    target: their === 'ja' ? p.ja : p.ko,
    reading: their === 'ja' ? p.jaHangul : p.koKana,
    meaning: my === 'ko' ? p.ko : p.ja,
    meaningReading: my === 'ko' ? p.koKana : p.jaHangul,
    note: p.note,
  });

  const fail = (caught: unknown) => {
    const kind = caught instanceof GeminiError ? caught.kind : (caught as Error)?.message || '';
    if (kind !== 'aborted') setError({ text: app.errorText(caught), kind });
  };

  async function fetchDaily() {
    if (dailyBusy) return;
    if (!settings.apiKey) return fail(new GeminiError('nokey'));
    setDailyBusy(true);
    setError(null);
    try {
      const result = await callGemini<DailyJson>({
        key: settings.apiKey,
        system: systemPrompt(app.profile, app.glossary),
        parts: [
          {
            text: dailyPrompt({
              profile: app.profile,
              turns: app.turns,
              known: [...phrases.map((p) => (their === 'ja' ? p.ja : p.ko)), app.daily?.[their] || ''].filter(Boolean),
              today: new Date(),
            }),
          },
        ],
        schema: DAILY_SCHEMA,
        temperature: 0.9,
      });
      app.setDaily(dailyFrom(result.data, app.profile, today));
    } catch (caught) {
      fail(caught);
    } finally {
      setDailyBusy(false);
    }
  }

  const autoTried = useRef(false);
  useEffect(() => {
    if (autoTried.current || !settings.apiKey || app.daily?.date === today) return;
    autoTried.current = true;
    void fetchDaily();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.apiKey]);

  const daily = app.daily;
  const filtered = phrases.filter((p) => !query.trim() || `${p.ko} ${p.ja} ${p.koKana} ${p.jaHangul}`.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <div className="page">
      <section className="daily-card">
        <div className="daily-head">
          <span className="kicker">
            <Icon name="sparkle" size={14} /> {t('learn.daily')}
          </span>
          {daily && (
            <button className="link-button" onClick={fetchDaily} disabled={dailyBusy}>
              {dailyBusy ? <span className="spinner" /> : <Icon name="refresh" size={14} />}
              {t('learn.dailyNew')}
            </button>
          )}
        </div>
        {daily ? (
          <>
            <p className="daily-main" lang={their}>
              {daily[their]}
            </p>
            <p className="reading">{their === 'ja' ? daily.jaHangul : daily.koKana}</p>
            <p className="daily-meaning">{daily[my]}</p>
            {daily.note && <p className="daily-note">{daily.note}</p>}
            <div className="action-row">
              <SpeakButtons text={daily[their]} lang={their} />
              <button className="chip-button" onClick={() => setPractice(cardOf(daily))}>
                <Icon name="mic" size={15} />
                {t('learn.practice')}
              </button>
              <button
                className={`chip-button ${app.isKept(daily) ? 'on' : ''}`}
                aria-label={t('turn.keep')}
                onClick={() => {
                  const kept = app.isKept(daily);
                  app.keepPhrase(daily);
                  if (!kept) app.toast(t('toast.saved'));
                }}
              >
                <Icon name="heart" size={15} fill={app.isKept(daily)} />
              </button>
            </div>
          </>
        ) : (
          <button className="primary-button wide" onClick={fetchDaily} disabled={dailyBusy}>
            {dailyBusy ? <span className="spinner light" /> : <Icon name="sparkle" size={16} />}
            {t('learn.dailyGet')}
          </button>
        )}
      </section>
      {error && <ErrorBox error={error} onClose={() => setError(null)} />}

      <section className="review-card">
        <div>
          <b>{due.length ? t('learn.reviewCount', { n: due.length }) : t('learn.review')}</b>
          <p>{due.length ? '' : t('learn.reviewNone')}</p>
        </div>
        {due.length > 0 && (
          <button className="primary-button" onClick={() => setReview(true)}>
            <Icon name="book" size={16} />
            {t('learn.review')}
          </button>
        )}
      </section>

      <div className="section-head">
        <h3 className="section-label">
          {t('learn.phrases')} <span className="count">{phrases.length}</span>
        </h3>
        <button className="chip-button" onClick={() => setAdding(true)}>
          <Icon name="plus" size={15} />
          {t('learn.add')}
        </button>
      </div>
      {phrases.length > 6 && (
        <label className="search">
          <Icon name="search" size={16} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('learn.search')} />
        </label>
      )}
      {phrases.length === 0 && <p className="hint-text">{t('learn.empty')}</p>}
      <ul className="phrase-list">
        {filtered.map((p) => {
          const card = cardOf(p);
          return (
            <li key={p.id}>
              <div className="phrase-text">
                <p lang={their}>{card.target}</p>
                <span className="reading">{card.reading}</span>
                <small>{card.meaning}</small>
              </div>
              <div className="phrase-actions">
                <button className="icon-button" onClick={() => speak(card.target, their, settings.slowRate)} aria-label={t('turn.slow')}>
                  <Icon name="play" size={16} fill />
                </button>
                <button className="icon-button" onClick={() => setPractice(card)} aria-label={t('learn.practice')}>
                  <Icon name="mic" size={16} />
                </button>
                <button
                  className="icon-button"
                  onClick={() => window.confirm(t('turn.delAsk')) && app.setPhrases((prev) => prev.filter((x) => x.id !== p.id))}
                  aria-label={t('delete')}
                >
                  <Icon name="trash" size={16} />
                </button>
              </div>
              <span className="box-dots" aria-label={t('learn.box', { n: p.box })}>
                {Array.from({ length: 5 }, (_, i) => (
                  <i key={i} className={i < p.box ? 'on' : ''} />
                ))}
              </span>
            </li>
          );
        })}
      </ul>

      {practice && <PronounceSheet card={practice} onClose={() => setPractice(null)} />}
      {review && <ReviewSheet initial={due} onClose={() => setReview(false)} cardOf={cardOf} />}
      {adding && <AddPhraseSheet onClose={() => setAdding(false)} />}
    </div>
  );
}

function PronounceSheet({ card, onClose }: { card: Card; onClose: () => void }) {
  const app = useApp();
  const { t } = app;
  const [busy, setBusy] = useState(false);
  const [since, setSince] = useState(0);
  const [result, setResult] = useState<PronounceJson | null>(null);
  const [error, setError] = useState<{ text: string; kind: string } | null>(null);
  const seconds = useElapsed(busy, since);
  const voice = useVoice(
    async (recording) => {
      if (!app.settings.apiKey) return setError({ text: t('err.nokey'), kind: 'nokey' });
      setBusy(true);
      setSince(Date.now());
      setError(null);
      try {
        const res = await callGemini<PronounceJson>({
          key: app.settings.apiKey,
          system: systemPrompt(app.profile, app.glossary),
          parts: [
            { inlineData: { mimeType: recording.mime, data: await blobToBase64(recording.blob) } },
            { text: pronouncePrompt({ profile: app.profile, target: card.target, targetLang: card.lang, reading: card.reading }) },
          ],
          schema: PRONOUNCE_SCHEMA,
          timeoutMs: 30000,
        });
        setResult(res.data);
      } catch (caught) {
        setError({ text: app.errorText(caught), kind: caught instanceof GeminiError ? caught.kind : '' });
      } finally {
        setBusy(false);
      }
    },
    (caught) => setError({ text: app.errorText(caught), kind: caught.message }),
  );
  const score = Math.max(0, Math.min(5, Math.round(result?.score || 0)));
  return (
    <Sheet open onClose={onClose} closeLabel={t('close')} kicker={t('learn.practice')} title={<span lang={card.lang}>{card.target}</span>}>
      <p className="reading big">{card.reading}</p>
      <p className="sheet-meaning">{card.meaning}</p>
      <div className="action-row">
        <SpeakButtons text={card.target} lang={card.lang} />
      </div>
      <button
        ref={(el) => {
          if (voice.recording) voice.levelEl.current = el;
        }}
        className={`mic ${voice.recording ? 'recording' : busy ? 'working' : 'idle'} practice-mic`}
        disabled={busy}
        onClick={() => (voice.recording ? void voice.stop() : void voice.start())}
      >
        <span className="mic-visual">
          {voice.recording ? (
            <span className="bars">
              <i />
              <i />
              <i />
              <i />
              <i />
            </span>
          ) : busy ? (
            <span className="spinner light" />
          ) : (
            <Icon name="mic" size={24} />
          )}
        </span>
        <span className="mic-text">
          <b>{voice.recording ? t('talk.rec') : busy ? `${t('learn.checking')} ${seconds}s` : t('learn.tapSay')}</b>
        </span>
      </button>
      {error && <ErrorBox error={error} onClose={() => setError(null)} />}
      {result && !busy && (
        <div className="score-card">
          <div className="score-stars" aria-label={`${t('learn.score')} ${score}/5`}>
            {Array.from({ length: 5 }, (_, i) => (
              <Icon key={i} name="star" size={22} fill={i < score} />
            ))}
          </div>
          {result.heard && (
            <p>
              <small>{t('learn.heard')}</small>
              <span lang={card.lang}>{result.heard}</span>
            </p>
          )}
          {result.good && <p className="good">{result.good}</p>}
          {result.tip && <p className="tip">{result.tip}</p>}
        </div>
      )}
    </Sheet>
  );
}

function ReviewSheet({ initial, onClose, cardOf }: { initial: Phrase[]; onClose: () => void; cardOf: (p: Phrase) => Card }) {
  const app = useApp();
  const { t, my, their } = app;
  const [queue] = useState(() => initial.slice(0, 15));
  const [index, setIndex] = useState(0);
  const [shown, setShown] = useState(false);
  const [mode, setMode] = useState<'meaning' | 'listen'>('meaning');
  const [practice, setPractice] = useState(false);
  const current = queue[index];
  const card = current ? cardOf(current) : null;

  useEffect(() => {
    if (card && mode === 'listen' && !shown) speak(card.target, their, 0.9);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, mode]);

  const answer = (knew: boolean) => {
    if (!current) return;
    app.setPhrases((prev) => prev.map((p) => (p.id === current.id ? grade(p, knew) : p)));
    setShown(false);
    setIndex((i) => i + 1);
  };

  return (
    <Sheet open tall onClose={onClose} closeLabel={t('close')} kicker={`${t('learn.review')} ${Math.min(index + 1, queue.length)} / ${queue.length}`}>
      <div className="segmented small">
        <button className={mode === 'meaning' ? 'on' : ''} onClick={() => setMode('meaning')}>
          {t('learn.modeMean')}
        </button>
        <button className={mode === 'listen' ? 'on' : ''} onClick={() => setMode('listen')}>
          {t('learn.modeListen')}
        </button>
      </div>
      {card ? (
        <div className="flash">
          <p className="flash-ask">{mode === 'meaning' ? t('learn.howSay', { lang: t(`lang.${their}`) }) : t('learn.whatMean')}</p>
          {mode === 'meaning' ? (
            <p className="flash-front" lang={my}>
              {card.meaning}
            </p>
          ) : (
            <button className="flash-listen" onClick={() => speak(card.target, their, 0.9)}>
              <Icon name="speaker" size={34} />
            </button>
          )}
          {shown ? (
            <div className="flash-back">
              <p className="flash-target" lang={their}>
                {card.target}
              </p>
              <p className="reading">{card.reading}</p>
              {mode === 'listen' && <p className="sheet-meaning">{card.meaning}</p>}
              <div className="action-row center">
                <SpeakButtons text={card.target} lang={their} />
                <button className="chip-button" onClick={() => setPractice(true)}>
                  <Icon name="mic" size={15} />
                  {t('learn.practice')}
                </button>
              </div>
              <div className="flash-grade">
                <button className="secondary-button" onClick={() => answer(false)}>
                  {t('learn.didnt')}
                </button>
                <button className="primary-button" onClick={() => answer(true)}>
                  {t('learn.knew')}
                </button>
              </div>
            </div>
          ) : (
            <button className="primary-button wide" onClick={() => setShown(true)}>
              {t('learn.reveal')}
            </button>
          )}
        </div>
      ) : (
        <div className="flash done">
          <Icon name="check" size={40} />
          <p>{t('learn.done', { n: queue.length })}</p>
          <button className="primary-button wide" onClick={onClose}>
            {t('close')}
          </button>
        </div>
      )}
      {practice && card && <PronounceSheet card={card} onClose={() => setPractice(false)} />}
    </Sheet>
  );
}

function AddPhraseSheet({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const { t } = app;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; kind: string } | null>(null);

  async function add() {
    const clean = text.trim();
    if (!clean || busy) return;
    if (!app.settings.apiKey) return setError({ text: t('err.nokey'), kind: 'nokey' });
    setBusy(true);
    setError(null);
    try {
      const result = await callGemini<TalkJson>({
        key: app.settings.apiKey,
        system: systemPrompt(app.profile, app.glossary),
        parts: [{ text: talkPrompt({ profile: app.profile, turns: [], tone: app.settings.tone, text: clean }) }],
        schema: TALK_SCHEMA,
      });
      const turn = turnFromTalk(result.data, { input: 'text', model: result.model, ms: result.ms, id: uid(), ts: Date.now() });
      app.setPhrases((prev) => [phraseFrom(turn), ...prev]);
      app.toast(t('toast.saved'));
      onClose();
    } catch (caught) {
      setError({ text: app.errorText(caught), kind: caught instanceof GeminiError ? caught.kind : '' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open onClose={onClose} closeLabel={t('close')} title={t('learn.add')}>
      <textarea className="field" rows={3} autoFocus value={text} placeholder={t('learn.addPh')} onChange={(event) => setText(event.target.value)} />
      {error && <ErrorBox error={error} onClose={() => setError(null)} />}
      <button className="primary-button wide" disabled={!text.trim() || busy} onClick={add}>
        {busy ? <span className="spinner light" /> : <Icon name="plus" size={16} />}
        {busy ? t('learn.adding') : t('add')}
      </button>
    </Sheet>
  );
}
