import { useMemo, useState } from 'react';
import { blobToBase64, callGemini, failureOf, GeminiError, type Part } from '../lib/gemini';
import {
  systemPrompt,
  turnFromUnderstand,
  turnFromWrite,
  understandPrompt,
  UNDERSTAND_SCHEMA,
  validateUnderstand,
  validateWrite,
  writePrompt,
  WRITE_SCHEMA,
  type UnderstandJson,
  type WriteJson,
} from '../lib/prompts';
import { uid, useSession } from '../lib/store';
import type { Tone, Turn } from '../lib/types';
import { useApp } from './AppContext';
import { Icon } from './Icon';
import { LineCard, SpeakButtons, textIn } from './TurnCard';
import { useElapsed, useVoice } from './useVoice';

type Mode = 'in' | 'out';
const TONES: Tone[] = ['sweet', 'natural', 'playful', 'serious'];

export function MessageView() {
  const app = useApp();
  const { t, my, their, settings } = app;
  const [mode, setMode] = useSession<Mode>('duri.msg.mode', 'in');
  const [inText, setInText] = useSession('duri.msg.in', '');
  const [outText, setOutText] = useSession('duri.msg.out', '');
  const [replyTo, setReplyTo] = useSession<Turn | null>('duri.msg.reply', null);
  const [busy, setBusy] = useState<Mode | null>(null);
  const [since, setSince] = useState(0);
  const [error, setError] = useState<{ text: string; kind: string } | null>(null);
  const [lastIn, setLastIn] = useSession<string | null>('duri.msg.lastIn', null);
  const [lastOut, setLastOut] = useSession<string | null>('duri.msg.lastOut', null);
  const seconds = useElapsed(!!busy, since);

  const inTurn = useMemo(() => app.turns.find((x) => x.id === lastIn) || null, [app.turns, lastIn]);
  const outTurn = useMemo(() => app.turns.find((x) => x.id === lastOut) || null, [app.turns, lastOut]);
  const recent = useMemo(() => app.turns.filter((x) => x.channel === (mode === 'in' ? 'msg-in' : 'msg-out')).slice(-6).reverse(), [app.turns, mode]);

  const fail = (caught: unknown) => {
    const kind = caught instanceof GeminiError ? caught.kind : (caught as Error)?.message || '';
    if (kind !== 'aborted') setError({ text: app.errorText(caught), kind });
  };

  async function explain() {
    const text = inText.trim();
    if (!text || busy) return;
    if (!settings.apiKey) return fail(new GeminiError('nokey'));
    setBusy('in');
    setSince(Date.now());
    setError(null);
    try {
      const result = await callGemini<UnderstandJson>({
        key: settings.apiKey,
        system: systemPrompt(app.profile, app.glossary),
        parts: [{ text: understandPrompt({ profile: app.profile, turns: app.turns, text }) }],
        schema: UNDERSTAND_SCHEMA,
        validate: (data) => validateUnderstand(data, app.profile),
        hedgeMs: 8000,
      });
      if (result.invalid === 'translation') throw failureOf(result);
      const turn = turnFromUnderstand(result.data, text, { model: result.model, ms: result.ms, id: uid(), ts: Date.now(), myLang: my });
      app.setTurns((prev) => [...prev, turn]);
      setLastIn(turn.id);
      setInText('');
    } catch (caught) {
      fail(caught);
    } finally {
      setBusy(null);
    }
  }

  async function compose(audio?: { blob: Blob; mime: string }) {
    const text = outText.trim();
    if ((!text && !audio) || busy) return;
    if (!settings.apiKey) return fail(new GeminiError('nokey'));
    setBusy('out');
    setSince(Date.now());
    setError(null);
    try {
      const parts: Part[] = [];
      if (audio) parts.push({ inlineData: { mimeType: audio.mime, data: await blobToBase64(audio.blob) } });
      parts.push({
        text: writePrompt({
          profile: app.profile,
          turns: app.turns,
          tone: settings.tone,
          text: audio ? undefined : text,
          replyTo: replyTo ? textIn(replyTo, replyTo.lang) : undefined,
        }),
      });
      const result = await callGemini<WriteJson>({
        key: settings.apiKey,
        system: systemPrompt(app.profile, app.glossary),
        parts,
        schema: WRITE_SCHEMA,
        validate: (data) => validateWrite(data, app.profile),
        timeoutMs: audio ? 30000 : 25000,
        hedgeMs: audio ? 10000 : 8000,
      });
      const turn = turnFromWrite(result.data, { profile: app.profile, input: audio ? 'voice' : 'text', model: result.model, ms: result.ms, id: uid(), ts: Date.now() });
      if (!turn.lines?.length) throw failureOf(result);
      app.setTurns((prev) => [...prev, turn]);
      setLastOut(turn.id);
      if (audio) setOutText(textIn(turn, my));
    } catch (caught) {
      fail(caught);
    } finally {
      setBusy(null);
    }
  }

  const dictation = useVoice(
    (recording) => void compose(recording),
    (caught) => fail(caught),
  );

  async function paste() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setInText(text);
    } catch {
      app.toast(t('msg.noClip'));
    }
  }

  return (
    <div className="page">
      <div className="segmented" role="tablist">
        <button role="tab" aria-selected={mode === 'in'} className={mode === 'in' ? 'on' : ''} onClick={() => setMode('in')}>
          {t('msg.in')}
        </button>
        <button role="tab" aria-selected={mode === 'out'} className={mode === 'out' ? 'on' : ''} onClick={() => setMode('out')}>
          {t('msg.out')}
        </button>
      </div>

      {mode === 'in' ? (
        <>
          <div className="input-card">
            <textarea value={inText} rows={4} placeholder={t('msg.inPh', { name: app.partnerName })} onChange={(event) => setInText(event.target.value)} />
            <div className="input-actions">
              <button className="chip-button" onClick={paste}>
                <Icon name="paste" size={15} />
                {t('msg.paste')}
              </button>
              <button className="primary-button" disabled={!inText.trim() || !!busy} onClick={explain}>
                {busy === 'in' ? <span className="spinner light" /> : <Icon name="sparkle" size={16} />}
                {busy === 'in' ? `${t('talk.work')} ${seconds}s` : t('msg.explain')}
              </button>
            </div>
          </div>
          {!inTurn && !busy && <p className="hint-text">{t('msg.emptyIn')}</p>}
          {error && <ErrorBox error={error} onClose={() => setError(null)} />}
          {inTurn && (
            <article className="result-card">
              <p className="result-main" lang={my}>
                {textIn(inTurn, my)}
              </p>
              <p className="bubble-original" lang={inTurn.lang}>
                {textIn(inTurn, inTurn.lang)}
              </p>
              <p className="reading">{inTurn.lang === 'ja' ? inTurn.jaHangul : inTurn.koKana}</p>
              <div className="action-row">
                <SpeakButtons text={textIn(inTurn, their)} lang={their} />
              </div>
              {inTurn.nuance && (
                <div className="note-box">
                  <b>{t('msg.nuance')}</b>
                  <p>{inTurn.nuance}</p>
                </div>
              )}
              {inTurn.words && inTurn.words.length > 0 && (
                <>
                  <h3 className="section-label">{t('msg.words')}</h3>
                  <ul className="word-chips">
                    {inTurn.words.map((w) => (
                      <li key={w.w}>
                        <b lang={inTurn.lang}>{w.w}</b>
                        <span>{w.r}</span>
                        <small>{w.m}</small>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {inTurn.lines && inTurn.lines.length > 0 && (
                <>
                  <h3 className="section-label">{t('msg.replies')}</h3>
                  <div className="line-stack">
                    {inTurn.lines.map((line, index) => (
                      <LineCard key={index} line={line} lang={their} />
                    ))}
                  </div>
                </>
              )}
              <button
                className="secondary-button"
                onClick={() => {
                  setReplyTo(inTurn);
                  setMode('out');
                }}
              >
                <Icon name="edit" size={16} />
                {t('msg.replySelf')}
              </button>
            </article>
          )}
        </>
      ) : (
        <>
          <div className="input-card">
            {replyTo && (
              <div className="reply-chip">
                <span>{t('msg.replyTo')}</span>
                <p lang={replyTo.lang}>{textIn(replyTo, replyTo.lang)}</p>
                <button className="icon-button" onClick={() => setReplyTo(null)} aria-label={t('close')}>
                  <Icon name="close" size={14} />
                </button>
              </div>
            )}
            <textarea value={outText} rows={4} placeholder={t('msg.outPh')} onChange={(event) => setOutText(event.target.value)} />
            <div className="tone-chips">
              {TONES.map((tone) => (
                <button key={tone} className={settings.tone === tone ? 'on' : ''} onClick={() => app.setSettings((s) => ({ ...s, tone }))}>
                  {t(`tone.${tone}`)}
                </button>
              ))}
            </div>
            <div className="input-actions">
              <button
                ref={(el) => {
                  if (dictation.recording) dictation.levelEl.current = el;
                }}
                className={`chip-button ${dictation.recording ? 'recording' : ''}`}
                disabled={!!busy}
                onClick={() => (dictation.recording ? void dictation.stop() : void dictation.start())}
              >
                <Icon name={dictation.recording ? 'wave' : 'mic'} size={15} />
                {dictation.recording ? t('talk.listening') : t('msg.dictate')}
              </button>
              <button className="primary-button" disabled={!outText.trim() || !!busy || dictation.recording} onClick={() => compose()}>
                {busy === 'out' ? <span className="spinner light" /> : <Icon name="sparkle" size={16} />}
                {busy === 'out' ? `${t('talk.work')} ${seconds}s` : t('msg.make', { lang: t(`lang.${their}`) })}
              </button>
            </div>
          </div>
          {!outTurn && !busy && <p className="hint-text">{t('msg.emptyOut')}</p>}
          {error && <ErrorBox error={error} onClose={() => setError(null)} />}
          {outTurn && (
            <div className="line-stack">
              {outTurn.note && <p className="turn-note">{outTurn.note}</p>}
              {(outTurn.lines || []).map((line, index) => (
                <LineCard key={index} line={line} lang={their} />
              ))}
            </div>
          )}
        </>
      )}

      {recent.length > 0 && (
        <section className="recent">
          <h3 className="section-label">{t('msg.recent')}</h3>
          {recent.map((turn) => (
            <button
              key={turn.id}
              className="recent-row"
              onClick={() => {
                if (mode === 'in') setLastIn(turn.id);
                else setLastOut(turn.id);
                window.scrollTo({ top: 0, behavior: 'smooth' });
                document.querySelector('.screen')?.scrollTo({ top: 0, behavior: 'smooth' });
              }}
            >
              <span lang={turn.lang}>{textIn(turn, turn.lang)}</span>
              <small>{textIn(turn, turn.lang === 'ko' ? 'ja' : 'ko')}</small>
            </button>
          ))}
        </section>
      )}
    </div>
  );
}

export function ErrorBox({ error, onClose }: { error: { text: string; kind: string }; onClose: () => void }) {
  const app = useApp();
  return (
    <div className="error-card" role="alert">
      <p>{error.text}</p>
      <div className="action-row">
        {(error.kind === 'nokey' || error.kind === 'key') && (
          <button className="chip-button strong" onClick={app.openKey}>
            <Icon name="key" size={15} />
            {app.t('err.openKey')}
          </button>
        )}
        <button className="chip-button" onClick={onClose}>
          {app.t('close')}
        </button>
      </div>
    </div>
  );
}
