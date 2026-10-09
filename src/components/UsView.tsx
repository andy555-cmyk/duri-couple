import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Recorder, type Recording } from '../lib/audio';
import { callGemini, GeminiError, MODELS, modelHealth, probeModel, recentLog } from '../lib/gemini';
import { daysTogether, FILL_SCHEMA, fillPrompt, systemPrompt } from '../lib/prompts';
import { dateKey, makeBackup, makeShareLink, mergeById, mergeGlossary, parseBackup, uid } from '../lib/store';
import type { GlossaryItem, Lang, Turn } from '../lib/types';
import { useApp } from './AppContext';
import { Icon } from './Icon';
import { ErrorBox } from './MessageView';
import { ProfileFields } from './ProfileFields';
import { Sheet } from './Sheet';
import { dayLabel } from './TalkView';
import { copyText, textIn, TurnCard } from './TurnCard';

export const APP_VERSION = '2.0.0';

export function UsView() {
  const app = useApp();
  const { t, my, profile } = app;
  const [editProfile, setEditProfile] = useState(false);
  const [wordSheet, setWordSheet] = useState<GlossaryItem | 'new' | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [starOnly, setStarOnly] = useState(false);
  const days = daysTogether(profile.startDate);

  const diary = useMemo(() => {
    const q = query.trim().toLowerCase();
    const groups = new Map<string, Turn[]>();
    for (const turn of app.turns) {
      if (starOnly && !turn.star) continue;
      if (q && !`${turn.ko} ${turn.ja} ${turn.memo || ''}`.toLowerCase().includes(q)) continue;
      const key = dateKey(turn.ts);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(turn);
    }
    return [...groups.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [app.turns, query, starOnly]);

  const share = async () => {
    // The link is readable by anyone who sees it; say exactly what goes in (Codex review C3).
    if (!window.confirm(t('us.shareAsk', { n: Math.min(app.glossary.length, 60) }))) return;
    const base = `${location.origin}${location.pathname}`;
    const link = makeShareLink(profile, app.glossary, base);
    const text = t('us.sendText');
    if (navigator.share) {
      try {
        await navigator.share({ text, url: link });
        return;
      } catch {
        /* cancelled or unsupported: fall back to copying */
      }
    }
    if (await copyText(`${text}\n${link}`)) app.toast(t('toast.linkCopied'));
  };

  return (
    <div className="page">
      <section className="couple-card">
        <div className="couple-names">
          <span>{app.myName}</span>
          <Icon name="heart" size={16} fill />
          <span>{app.partnerName}</span>
        </div>
        {days && <p className="couple-days">{t('dday', { n: days.toLocaleString() })}</p>}
        {profile.startDate && <p className="couple-since">{t('us.since', { date: profile.startDate.replace(/-/g, '.') })}</p>}
        <button className="chip-button" onClick={() => setEditProfile(true)}>
          <Icon name="edit" size={14} />
          {t('us.editProfile')}
        </button>
      </section>

      <section className="panel">
        <div className="section-head">
          <h3 className="section-label">
            {t('us.glossary')} <span className="count">{app.glossary.length}</span>
          </h3>
          <button className="chip-button" onClick={() => setWordSheet('new')}>
            <Icon name="plus" size={15} />
            {t('us.addWord')}
          </button>
        </div>
        <p className="panel-help">{t('us.glossaryHelp')}</p>
        {app.glossary.length === 0 ? (
          <p className="hint-text">{t('us.glossaryEmpty')}</p>
        ) : (
          <ul className="gloss-list">
            {app.glossary.map((g) => (
              <li key={g.id}>
                <button onClick={() => setWordSheet(g)}>
                  <span lang={my}>{my === 'ko' ? g.ko : g.ja}</span>
                  <Icon name="chevron" size={12} />
                  <span lang={my === 'ko' ? 'ja' : 'ko'}>{my === 'ko' ? g.ja : g.ko}</span>
                  {g.note && <small>{g.note}</small>}
                </button>
              </li>
            ))}
          </ul>
        )}
        <button className="secondary-button" onClick={share}>
          <Icon name="share" size={16} />
          {t('us.sendTo', { name: app.partnerName })}
        </button>
      </section>

      <section className="panel">
        <div className="section-head">
          <h3 className="section-label">{t('us.diary')}</h3>
          <button className={`chip-button ${starOnly ? 'on' : ''}`} onClick={() => setStarOnly(!starOnly)}>
            <Icon name="star" size={14} fill={starOnly} />
            {t('us.starOnly')}
          </button>
        </div>
        {app.turns.length > 0 && (
          <label className="search">
            <Icon name="search" size={16} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('us.searchPh')} />
          </label>
        )}
        {diary.length === 0 ? (
          <p className="hint-text">{t('us.diaryEmpty')}</p>
        ) : (
          <ul className="diary-list">
            {diary.slice(0, 60).map(([key, turns]) => (
              <li key={key}>
                <button onClick={() => setDay(key)}>
                  <span className="diary-date">{dayLabel(turns[0].ts, my, t)}</span>
                  <span className="diary-preview" lang={turns[turns.length - 1].lang}>
                    {textIn(turns[turns.length - 1], my)}
                  </span>
                  <span className="diary-count">
                    {turns.some((x) => x.star) && <Icon name="star" size={12} fill />}
                    {t('us.count', { n: turns.length })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Settings />

      {editProfile && <ProfileSheet onClose={() => setEditProfile(false)} />}
      {wordSheet && <WordSheet item={wordSheet === 'new' ? null : wordSheet} onClose={() => setWordSheet(null)} />}
      {day && <DaySheet date={day} turns={diary.find(([key]) => key === day)?.[1] || []} onClose={() => setDay(null)} />}
    </div>
  );
}

function DaySheet({ date, turns, onClose }: { date: string; turns: Turn[]; onClose: () => void }) {
  const app = useApp();
  const update = useCallback((turn: Turn) => app.setTurns((prev) => prev.map((x) => (x.id === turn.id ? turn : x))), [app.setTurns]);
  const remove = useCallback((id: string) => app.setTurns((prev) => prev.filter((x) => x.id !== id)), [app.setTurns]);
  return (
    <Sheet open tall onClose={onClose} closeLabel={app.t('close')} title={turns[0] ? dayLabel(turns[0].ts, app.my, app.t) : date}>
      <div className="day-thread">
        {turns.map((turn) => (
          <TurnCard key={turn.id} turn={turn} onChange={update} onDelete={remove} partnerLabel={app.partnerName} />
        ))}
      </div>
    </Sheet>
  );
}

function ProfileSheet({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const [draft, setDraft] = useState(app.profile);
  return (
    <Sheet open tall onClose={onClose} closeLabel={app.t('close')} title={app.t('us.editProfile')}>
      <ProfileFields value={draft} onChange={setDraft} />
      <button
        className="primary-button wide"
        onClick={() => {
          app.setProfile(draft);
          onClose();
        }}
      >
        {app.t('save')}
      </button>
    </Sheet>
  );
}

function WordSheet({ item, onClose }: { item: GlossaryItem | null; onClose: () => void }) {
  const app = useApp();
  const { t } = app;
  const [ko, setKo] = useState(item?.ko || '');
  const [ja, setJa] = useState(item?.ja || '');
  const [noteText, setNoteText] = useState(item?.note || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; kind: string } | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  async function save() {
    let k = ko.trim();
    let j = ja.trim();
    if ((!k && !j) || request.current) return;
    if ((!k || !j) && app.settings.apiKey) {
      const controller = new AbortController();
      request.current = controller;
      setBusy(true);
      setError(null);
      try {
        const result = await callGemini<{ ko: string; ja: string }>({
          signal: controller.signal,
          key: app.settings.apiKey,
          system: systemPrompt(app.profile, app.glossary),
          parts: [{ text: fillPrompt({ ko: k, ja: j, note: noteText }) }],
          schema: FILL_SCHEMA,
          maxTokens: 1024,
          hedgeMs: 7000,
        });
        k = k || String(result.data.ko || '').trim();
        j = j || String(result.data.ja || '').trim();
      } catch (caught) {
        request.current = null;
        if (controller.signal.aborted) return;
        setBusy(false);
        setError({ text: app.errorText(caught), kind: caught instanceof GeminiError ? caught.kind : '' });
        return;
      }
      request.current = null;
      setBusy(false);
    }
    const next: GlossaryItem = { id: item?.id || uid(), ko: k, ja: j, note: noteText.trim() || undefined };
    app.setGlossary((prev) => (item ? prev.map((g) => (g.id === item.id ? next : g)) : [...prev, next]));
    onClose();
  }

  return (
    <Sheet open onClose={onClose} closeLabel={t('close')} title={t('us.addWord')}>
      <div className="form">
        <label>
          <span>한국어</span>
          <input className="field" lang="ko" value={ko} onChange={(event) => setKo(event.target.value)} />
        </label>
        <label>
          <span>日本語</span>
          <input className="field" lang="ja" value={ja} onChange={(event) => setJa(event.target.value)} />
        </label>
        <label>
          <span>{t('us.wordNote')}</span>
          <input className="field" value={noteText} onChange={(event) => setNoteText(event.target.value)} />
        </label>
        <p className="panel-help">{t('us.autoFill')}</p>
      </div>
      {error && <ErrorBox error={error} onClose={() => setError(null)} />}
      <div className="button-row">
        {item && (
          <button
            className="secondary-button danger"
            onClick={() => {
              app.setGlossary((prev) => prev.filter((g) => g.id !== item.id));
              onClose();
            }}
          >
            <Icon name="trash" size={16} />
            {t('delete')}
          </button>
        )}
        <button className="primary-button" disabled={(!ko.trim() && !ja.trim()) || busy} onClick={save}>
          {busy ? <span className="spinner light" /> : <Icon name="check" size={16} />}
          {t('save')}
        </button>
      </div>
    </Sheet>
  );
}

const RESULT_TEXT: Record<string, string> = { '404': 'not found', '403': 'no access', '429': 'quota', '503': 'busy', '500': 'busy' };

function Settings() {
  const app = useApp();
  const { t, settings, setSettings } = app;
  const [testing, setTesting] = useState(false);
  const [results, setResults] = useState<Record<string, string>>({});
  const [mic, setMic] = useState<{ state: 'idle' | 'rec' | 'done' | 'error'; info?: string; url?: string }>({ state: 'idle' });
  const [logOpen, setLogOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  async function runTest() {
    if (!settings.apiKey) return app.openKey();
    setTesting(true);
    setResults({});
    for (const spec of MODELS) {
      setResults((r) => ({ ...r, [spec.id]: '…' }));
      const result = await probeModel(settings.apiKey, spec);
      const text = result.ok
        ? `✓ ${(result.ms / 1000).toFixed(1)}s`
        : `✗ ${result.status || ''} ${RESULT_TEXT[String(result.status)] || result.kind}`.replace(/\s+/g, ' ');
      setResults((r) => ({ ...r, [spec.id]: text }));
      if (!result.ok && result.kind === 'key') break;
    }
    setTesting(false);
  }

  async function micTest() {
    if (mic.url) URL.revokeObjectURL(mic.url);
    const recorder = new Recorder({ autoEnd: false });
    try {
      await recorder.start(3000);
      setMic({ state: 'rec' });
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const result: Recording | null = await recorder.stop();
      if (!result) throw new Error('short');
      setMic({
        state: 'done',
        info: `${result.mime} · ${(result.blob.size / 1024).toFixed(0)}KB · ${(result.ms / 1000).toFixed(1)}s`,
        url: URL.createObjectURL(result.blob),
      });
    } catch (caught) {
      recorder.cancel();
      setMic({ state: 'error', info: app.errorText(caught) });
    }
  }

  function backup() {
    const data = makeBackup({ profile: app.profile, turns: app.turns, phrases: app.phrases, glossary: app.glossary });
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `duri-backup-${dateKey(Date.now())}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  async function restore(file: File) {
    try {
      const data = parseBackup(await file.text());
      app.setTurns((prev) => mergeById(prev, data.turns));
      app.setPhrases((prev) => mergeById(prev, data.phrases));
      app.setGlossary((prev) => mergeGlossary(prev, data.glossary));
      app.setProfile((prev) => ({
        ...prev,
        myName: prev.myName || data.profile.myName,
        partnerName: prev.partnerName || data.profile.partnerName,
        startDate: prev.startDate || data.profile.startDate,
        meCalls: prev.meCalls || data.profile.meCalls,
        partnerCalls: prev.partnerCalls || data.profile.partnerCalls,
        style: data.profile.style,
      }));
      app.toast(t('us.restored', { n: data.turns.length + data.phrases.length }));
    } catch {
      app.toast(t('err.format'));
    }
  }

  const health = modelHealth();
  return (
    <section className="panel settings">
      <h3 className="section-label">{t('us.settings')}</h3>

      <div className="setting">
        <div>
          <b>{t('us.key')}</b>
          <small className={settings.apiKey ? 'ok' : 'warn'}>{settings.apiKey ? `✓ ${t('us.keySaved')}` : t('us.keyNone')}</small>
        </div>
        <button className="chip-button" onClick={app.openKey}>
          <Icon name="key" size={14} />
          {t('us.keyChange')}
        </button>
      </div>

      <div className="setting column">
        <div className="setting-line">
          <b>{t('us.models')}</b>
          <button className="chip-button" onClick={runTest} disabled={testing}>
            {testing ? <span className="spinner" /> : <Icon name="refresh" size={14} />}
            {testing ? t('us.testing') : t('us.test')}
          </button>
        </div>
        <ul className="model-list">
          {MODELS.map((spec) => (
            <li key={spec.id}>
              <code>{spec.id}</code>
              <span>{results[spec.id] || (health[spec.id]?.okAt ? `✓ ${((health[spec.id].ms || 0) / 1000).toFixed(1)}s` : '')}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="setting column">
        <div className="setting-line">
          <b>{t('us.micTest')}</b>
          <button className="chip-button" onClick={micTest} disabled={mic.state === 'rec'}>
            <Icon name="mic" size={14} />
            {mic.state === 'rec' ? t('us.micTesting') : t('us.micTest')}
          </button>
        </div>
        {mic.info && <small className="mono">{mic.info}</small>}
        {mic.url && <audio controls src={mic.url} />}
      </div>

      <div className="setting">
        <b>{t('us.autoSpeak')}</b>
        <button
          className={`switch ${settings.autoSpeak ? 'on' : ''}`}
          role="switch"
          aria-checked={settings.autoSpeak}
          onClick={() => setSettings((s) => ({ ...s, autoSpeak: !s.autoSpeak }))}
        >
          <i />
        </button>
      </div>

      <div className="setting">
        <div>
          <b>{t('us.autoSend')}</b>
          <small>{t('us.autoSendHelp')}</small>
        </div>
        <button
          className={`switch ${settings.autoSend ? 'on' : ''}`}
          role="switch"
          aria-checked={settings.autoSend}
          aria-label={t('us.autoSend')}
          onClick={() => setSettings((s) => ({ ...s, autoSend: !s.autoSend }))}
        >
          <i />
        </button>
      </div>

      <div className="setting">
        <b>{t('us.slow')}</b>
        <div className="segmented small">
          {[0.5, 0.6, 0.75].map((rate) => (
            <button key={rate} className={settings.slowRate === rate ? 'on' : ''} onClick={() => setSettings((s) => ({ ...s, slowRate: rate }))}>
              {rate}×
            </button>
          ))}
        </div>
      </div>

      <div className="setting">
        <b>{t('us.myLang')}</b>
        <div className="segmented small">
          {(['ko', 'ja'] as Lang[]).map((lang) => (
            <button key={lang} className={app.my === lang ? 'on' : ''} onClick={() => app.setProfile((p) => ({ ...p, myLang: lang }))}>
              {lang === 'ko' ? '한국어' : '日本語'}
            </button>
          ))}
        </div>
      </div>

      <div className="setting-buttons">
        <button className="secondary-button" onClick={backup}>
          <Icon name="download" size={16} />
          {t('us.backup')}
        </button>
        <button className="secondary-button" onClick={() => fileInput.current?.click()}>
          <Icon name="upload" size={16} />
          {t('us.restore')}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void restore(file);
            event.target.value = '';
          }}
        />
      </div>

      <div className="info-box">
        <b>{t('us.home')}</b>
        <p>{t('us.homeHow')}</p>
      </div>
      <p className="panel-help">{t('us.privacy')}</p>

      <button className="link-button" onClick={() => setLogOpen(!logOpen)}>
        {t('us.log')}
      </button>
      {logOpen && (
        <ul className="log-list">
          {recentLog().map((entry, index) => (
            <li key={index}>
              <time>{new Date(entry.at).toLocaleTimeString()}</time> <code>{entry.model.replace('gemini-', '')}</code> {entry.result} · {entry.ms}ms
            </li>
          ))}
        </ul>
      )}

      <button
        className="secondary-button danger"
        onClick={() => {
          if (!window.confirm(t('us.wipeAsk'))) return;
          app.setTurns([]);
          app.setPhrases([]);
          app.setGlossary([]);
          app.setDaily(null);
        }}
      >
        <Icon name="trash" size={16} />
        {t('us.wipe')}
      </button>
      <p className="version">
        {t('us.version')} {APP_VERSION}
      </p>
    </section>
  );
}
