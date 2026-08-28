'use client';

import { useState } from 'react';

export default function Home() {
  const [listening, setListening] = useState(false);
  const [tone, setTone] = useState('다정하게');
  const [adopted, setAdopted] = useState(false);
  const [panel, setPanel] = useState<'study' | 'words' | 'memory' | null>(null);

  const tones = ['다정하게', '자연스럽게', '장난스럽게', '진지하게'];
  const changeTone = () => setTone(tones[(tones.indexOf(tone) + 1) % tones.length]);
  const speakJapanese = () => {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const voice = new SpeechSynthesisUtterance('今日も一緒にいられて嬉しい');
    voice.lang = 'ja-JP';
    voice.rate = 0.72;
    window.speechSynthesis.speak(voice);
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <button className="avatar" aria-label="우리 정보">승</button>
        <div className="brand"><span className="brand-mark">ふたり</span><b>둘의 말</b></div>
        <button className="history-button">추억함 <span>12</span></button>
      </header>

      <section className="conversation" aria-label="오늘 대화">
        <div className="day-label"><span /> 오늘, 우리 대화 <span /></div>
        <article className="message japanese">
          <div className="speaker">시오리</div>
          <div className="bubble">
            <p className="main-copy">今日も一緒にいられて嬉しい。</p>
            <p className="pronunciation">쿄오모 잇쇼니 이라레테 우레시이</p>
            <p className="meaning">오늘도 같이 있을 수 있어서 기뻐.</p>
            <button className="listen" onClick={speakJapanese}>▶ 천천히 듣기</button>
          </div>
        </article>

        <article className="message korean mine">
          <div className="speaker">Andy</div>
          <div className="bubble">
            <p className="main-copy">{adopted ? '나도. 너와 있으면 시간이 너무 빨리 가.' : '나도. 오늘 시간이 너무 빨리 갔어.'}</p>
            <p className="pronunciation japanese-reading">ナド。オヌル シガニ ノム パルリ ガッソ。</p>
            <p className="meaning">私も。今日は時間があっという間だった。</p>
          </div>
          <aside className="ai-tip">
            <div><span>✦</span><b>더 자연스러운 연인 표현</b></div>
            <p>私も。君といると時間が経つのが早すぎる。</p>
            <small>나도. 너와 있으면 시간이 너무 빨리 가.</small>
            <button onClick={() => setAdopted(!adopted)}>{adopted ? '원래 표현 보기' : '이 표현으로 바꾸기'}</button>
          </aside>
        </article>
      </section>

      <section className="composer">
        <div className="mode-row">
          <button className="language">한국어 <span>→</span> 日本語</button>
          <button className="tone" onClick={changeTone}>{tone}⌄</button>
        </div>
        <button className={`mic ${listening ? 'active' : ''}`} onClick={() => setListening(!listening)} aria-pressed={listening}>
          <span className="mic-icon">●</span>
          <b>{listening ? '듣고 있어요' : '눌러서 말하기'}</b>
          <small>{listening ? '말이 끝나면 다시 눌러주세요' : '한국어로 편하게 말하세요'}</small>
        </button>
        <nav className="quick-actions" aria-label="빠른 메뉴">
          <button onClick={() => setPanel('study')}><span>あ</span>오늘의 공부</button>
          <button onClick={() => setPanel('words')}><span>♡</span>우리 단어장</button>
          <button onClick={() => setPanel('memory')}><span>▣</span>추억 남기기</button>
        </nav>
      </section>

      {panel && (
        <div className="sheet-backdrop" onClick={() => setPanel(null)}>
          <section className="sheet" onClick={(event) => event.stopPropagation()}>
            <div className="sheet-handle" />
            <button className="sheet-close" onClick={() => setPanel(null)}>닫기</button>
            {panel === 'study' && <><p className="sheet-kicker">오늘의 한 문장</p><h2>君といると時間が経つのが早い。</h2><p className="sheet-reading">키미토 이루토 지칸가 타츠노가 하야이</p><p className="sheet-meaning">너와 있으면 시간이 빨리 가.</p><button className="sheet-main" onClick={speakJapanese}>천천히 들어보기</button></>}
            {panel === 'words' && <><p className="sheet-kicker">우리만 아는 말</p><h2>둘만의 단어장</h2><ul className="word-list"><li><b>시오리</b><span>しおり · 사람 이름</span></li><li><b>호진행님</b><span>ホジン兄さん · 친한 형</span></li><li><b>우리 라멘집</b><span>いつものラーメン屋 · 늘 가는 곳</span></li></ul><button className="sheet-main">새 단어 넣기</button></>}
            {panel === 'memory' && <><p className="sheet-kicker">2026년 8월 29일</p><h2>오늘 대화를 추억으로</h2><p className="memory-copy">“오늘도 같이 있을 수 있어서 기뻐.”<br/>사진과 장소를 더하면 둘만의 추억 카드가 됩니다.</p><button className="sheet-main" onClick={() => setPanel(null)}>오늘의 추억 저장</button></>}
          </section>
        </div>
      )}
    </main>
  );
}
