import type { Gender, Lang, Profile } from '../lib/types';
import { useApp } from './AppContext';

/** Tapping the chosen option again clears it. */
function GenderRow({ label, value, onPick }: { label: string; value: Gender; onPick: (g: Gender) => void }) {
  const { t } = useApp();
  return (
    <div className="field-row">
      <span>{label}</span>
      <div className="segmented small" role="group" aria-label={label}>
        {(['m', 'f'] as const).map((g) => (
          <button key={g} className={value === g ? 'on' : ''} aria-pressed={value === g} onClick={() => onPick(value === g ? '' : g)}>
            {t(g === 'm' ? 'p.male' : 'p.female')}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ProfileFields({ value, onChange, showLang = true }: { value: Profile; onChange: (p: Profile) => void; showLang?: boolean }) {
  const { t } = useApp();
  const set = (patch: Partial<Profile>) => onChange({ ...value, ...patch });
  return (
    <div className="form">
      {showLang && (
        <div className="field-row">
          <span>{t('us.myLang')}</span>
          <div className="segmented small">
            {(['ko', 'ja'] as Lang[]).map((lang) => (
              <button key={lang} className={value.myLang === lang ? 'on' : ''} onClick={() => set({ myLang: lang })}>
                {lang === 'ko' ? '한국어' : '日本語'}
              </button>
            ))}
          </div>
        </div>
      )}
      <label>
        <span>{t('p.myName')}</span>
        <input className="field" value={value.myName} onChange={(event) => set({ myName: event.target.value })} autoComplete="given-name" />
      </label>
      <label>
        <span>{t('p.partnerName')}</span>
        <input className="field" value={value.partnerName} onChange={(event) => set({ partnerName: event.target.value })} autoComplete="off" />
      </label>
      <label>
        <span>{t('p.start')}</span>
        <input className="field" type="date" value={value.startDate} onChange={(event) => set({ startDate: event.target.value })} />
      </label>
      <label>
        <span>{t('p.meCalls')}</span>
        <input className="field" value={value.meCalls} placeholder={t('p.callsPh')} onChange={(event) => set({ meCalls: event.target.value })} />
      </label>
      <label>
        <span>{t('p.partnerCalls')}</span>
        <input className="field" value={value.partnerCalls} placeholder={t('p.calledPh')} onChange={(event) => set({ partnerCalls: event.target.value })} />
      </label>
      <GenderRow label={t('p.meGender')} value={value.meGender} onPick={(meGender) => set({ meGender })} />
      <GenderRow label={t('p.partnerGender')} value={value.partnerGender} onPick={(partnerGender) => set({ partnerGender })} />
      <p className="field-help">{t('p.genderHelp')}</p>
      <div className="field-row">
        <span>{t('p.style')}</span>
        <div className="segmented small">
          <button className={value.style === 'casual' ? 'on' : ''} onClick={() => set({ style: 'casual' })}>
            {t('p.casual')}
          </button>
          <button className={value.style === 'polite' ? 'on' : ''} onClick={() => set({ style: 'polite' })}>
            {t('p.polite')}
          </button>
        </div>
      </div>
    </div>
  );
}
