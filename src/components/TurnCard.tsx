import { memo, useState } from 'react';
import { speak } from '../lib/speech';
import type { Lang, Line, Turn } from '../lib/types';
import { other } from '../lib/types';
import { useApp } from './AppContext';
import { Icon } from './Icon';
import { Sheet } from './Sheet';

export function textIn(turn: Turn, lang: Lang) {
  return lang === 'ko' ? turn.ko : turn.ja;
}
export function readingOf(turn: Turn, lang: Lang) {
  return lang === 'ko' ? turn.koKana : turn.jaHangul;
}

/** The translated side of a turn, honouring the speaker's "use the better line" choice. */
export function translated(turn: Turn) {
  const target = other(turn.lang);
  if (turn.useAlt && turn.alt) return { lang: target, text: turn.alt.text, reading: turn.alt.reading };
  return { lang: target, text: textIn(turn, target), reading: readingOf(turn, target) };
}

/** What goes into the phrasebook: the line actually used, paired with its meaning. */
export function phraseOf(turn: Turn) {
  const p = { ko: turn.ko, ja: turn.ja, koKana: turn.koKana, jaHangul: turn.jaHangul, note: turn.note };
  if (turn.useAlt && turn.alt) {
    if (other(turn.lang) === 'ja') {
      p.ja = turn.alt.text;
      p.jaHangul = turn.alt.reading;
      if (turn.alt.meaning) [p.ko, p.koKana] = [turn.alt.meaning, ''];
    } else {
      p.ko = turn.alt.text;
      p.koKana = turn.alt.reading;
      if (turn.alt.meaning) [p.ja, p.jaHangul] = [turn.alt.meaning, ''];
    }
  }
  return p;
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

export function SpeakButtons({ text, lang, compact = false }: { text: string; lang: Lang; compact?: boolean }) {
  const { t, settings } = useApp();
  return (
    <>
      <button className="chip-button" onClick={() => speak(text, lang, 1)}>
        <Icon name="play" size={14} fill />
        {!compact && t('turn.listen')}
      </button>
      <button className="chip-button" onClick={() => speak(text, lang, settings.slowRate)}>
        <Icon name="slow" size={15} />
        {!compact && t('turn.slow')}
      </button>
    </>
  );
}

export function LineCard({ line, lang, onCopied }: { line: Line; lang: Lang; onCopied?: () => void }) {
  const { t, keepPhrase, isKept, my, toast } = useApp();
  const phrase =
    lang === 'ja'
      ? { ko: line.meaning, ja: line.text, koKana: '', jaHangul: line.reading }
      : { ko: line.text, ja: line.meaning, koKana: line.reading, jaHangul: '' };
  const kept = isKept(phrase);
  return (
    <div className="line-card">
      {line.label && <span className="line-label">{line.label}</span>}
      <p className="line-text" lang={lang}>
        {line.text}
      </p>
      {line.reading && <p className="reading">{line.reading}</p>}
      {line.meaning && (
        <p className="line-meaning" lang={my}>
          {line.meaning}
        </p>
      )}
      {line.why && <p className="line-why">{line.why}</p>}
      <div className="action-row">
        <button
          className="chip-button strong"
          onClick={async () => {
            if (await copyText(line.text)) {
              toast(t('msg.copiedHint'));
              onCopied?.();
            }
          }}
        >
          <Icon name="copy" size={15} />
          {t('copy')}
        </button>
        {typeof navigator !== 'undefined' && 'share' in navigator && (
          <button className="chip-button" onClick={() => navigator.share({ text: line.text }).catch(() => {})}>
            <Icon name="share" size={15} />
            {t('msg.send')}
          </button>
        )}
        <SpeakButtons text={line.text} lang={lang} compact />
        <button
          className={`chip-button ${kept ? 'on' : ''}`}
          onClick={() => {
            keepPhrase(phrase);
            if (!kept) toast(t('toast.saved'));
          }}
          aria-label={t('turn.keep')}
        >
          <Icon name="heart" size={15} fill={kept} />
        </button>
      </div>
    </div>
  );
}

function TurnCardInner({ turn, onChange, onDelete, partnerLabel }: { turn: Turn; onChange: (turn: Turn) => void; onDelete: (id: string) => void; partnerLabel: string }) {
  const app = useApp();
  const { t, my, their, toast } = app;
  const [menu, setMenu] = useState(false);
  const [altOpen, setAltOpen] = useState(false);
  const [memo, setMemo] = useState(turn.memo || '');
  const mine = turn.lang === my;
  const out = translated(turn);
  const source = { lang: turn.lang, text: textIn(turn, turn.lang), reading: readingOf(turn, turn.lang) };
  const partnerSide = mine ? out : source;
  const phrase = phraseOf(turn);
  const kept = app.isKept(phrase);
  const time = new Date(turn.ts).toLocaleTimeString(my === 'ko' ? 'ko-KR' : 'ja-JP', { hour: 'numeric', minute: '2-digit' });
  const channelIcon = turn.channel === 'talk' ? null : <Icon name="message" size={12} />;

  return (
    <article className={`turn ${mine ? 'mine' : 'theirs'} ${turn.star ? 'starred' : ''}`}>
      <div className="turn-meta">
        {channelIcon}
        <span>{mine ? t('turn.mine') : partnerLabel}</span>
        <span className="dot">·</span>
        <time>{time}</time>
        {turn.star && <Icon name="star" size={12} fill className="star-mark" />}
      </div>
      <div className="bubble">
        {mine ? (
          <>
            <p className="bubble-source" lang={source.lang}>
              {source.text}
              {source.reading && <span className="source-reading">{source.reading}</span>}
            </p>
            <p className="bubble-main" lang={out.lang}>
              {out.text}
            </p>
            {out.reading && <p className="reading">{out.reading}</p>}
          </>
        ) : (
          <>
            <p className="bubble-main" lang={out.lang}>
              {out.text}
            </p>
            <p className="bubble-original" lang={source.lang}>
              {source.text}
            </p>
            {source.reading && <p className="reading">{source.reading}</p>}
          </>
        )}
        {turn.note && <p className="turn-note">{turn.note}</p>}
        {turn.nuance && <p className="turn-note">{turn.nuance}</p>}
        {turn.memo && <p className="turn-memo">“{turn.memo}”</p>}
        <div className="action-row">
          <SpeakButtons text={partnerSide.text} lang={partnerSide.lang} />
          <button
            className={`chip-button ${kept ? 'on' : ''}`}
            onClick={() => {
              app.keepPhrase(phrase);
              if (!kept) toast(t('toast.saved'));
            }}
          >
            <Icon name="heart" size={15} fill={kept} />
            {kept ? t('turn.kept') : t('turn.keep')}
          </button>
          <button className="chip-button icon-only" onClick={() => setMenu(true)} aria-label={t('turn.more')}>
            <Icon name="more" size={16} />
          </button>
        </div>
      </div>

      {turn.alt && (
        <aside className={`alt ${altOpen || turn.useAlt ? 'open' : ''}`}>
          <button className="alt-head" onClick={() => setAltOpen(!altOpen)}>
            <Icon name="sparkle" size={14} />
            <b>{turn.useAlt ? t('turn.orig') : t('turn.alt')}</b>
            {!altOpen && !turn.useAlt && (
              <span className="alt-preview" lang={out.lang}>
                {turn.alt.text}
              </span>
            )}
          </button>
          {(altOpen || turn.useAlt) && (
            <div className="alt-body">
              <p className="alt-text" lang={other(turn.lang)}>
                {turn.useAlt ? textIn(turn, other(turn.lang)) : turn.alt.text}
              </p>
              {other(turn.lang) !== my && <p className="reading">{turn.useAlt ? readingOf(turn, other(turn.lang)) : turn.alt.reading}</p>}
              {!turn.useAlt && turn.alt.meaning && <p className="alt-meaning">{turn.alt.meaning}</p>}
              {!turn.useAlt && turn.alt.why && <p className="alt-why">{turn.alt.why}</p>}
              <button className="alt-switch" onClick={() => onChange({ ...turn, useAlt: !turn.useAlt })}>
                {turn.useAlt ? t('turn.useOrig') : t('turn.useAlt')}
              </button>
            </div>
          )}
        </aside>
      )}

      {turn.words && turn.words.length > 0 && (
        <ul className="word-chips">
          {turn.words.map((w) => (
            <li key={w.w}>
              <b lang={turn.lang}>{w.w}</b>
              <span>{w.r}</span>
              <small>{w.m}</small>
            </li>
          ))}
        </ul>
      )}
      {turn.lines && turn.lines.length > 0 && (
        <div className="line-stack">
          {turn.lines.map((line, index) => (
            <LineCard key={index} line={line} lang={their} />
          ))}
        </div>
      )}

      <Sheet open={menu} onClose={() => setMenu(false)} closeLabel={t('close')} title={out.text}>
        <div className="menu-list">
          <button
            onClick={async () => {
              if (await copyText(partnerSide.text)) toast(t('copied'));
              setMenu(false);
            }}
          >
            <Icon name="copy" />
            {t('turn.copyOther', { lang: t(`lang.${their}`) })}
          </button>
          <button
            onClick={async () => {
              if (await copyText(textIn(turn, my))) toast(t('copied'));
              setMenu(false);
            }}
          >
            <Icon name="copy" />
            {t('turn.copyOther', { lang: t(`lang.${my}`) })}
          </button>
          <button
            onClick={() => {
              onChange({ ...turn, star: !turn.star });
              if (!turn.star) toast(t('toast.starred'));
              setMenu(false);
            }}
          >
            <Icon name="star" fill={turn.star} />
            {turn.star ? t('turn.unstar') : t('turn.star')}
          </button>
          <label className="memo-field">
            <span>
              <Icon name="edit" />
              {t('turn.memo')}
            </span>
            <textarea
              value={memo}
              placeholder={t('turn.memoPh')}
              rows={2}
              onChange={(event) => setMemo(event.target.value)}
              onBlur={() => memo !== (turn.memo || '') && onChange({ ...turn, memo: memo.trim() || undefined, star: memo.trim() ? true : turn.star })}
            />
          </label>
          <button
            className="danger"
            onClick={() => {
              if (window.confirm(t('turn.delAsk'))) {
                onDelete(turn.id);
                setMenu(false);
              }
            }}
          >
            <Icon name="trash" />
            {t('turn.del')}
          </button>
        </div>
      </Sheet>
    </article>
  );
}

export const TurnCard = memo(TurnCardInner);
