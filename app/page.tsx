'use client';
import { useEffect, useState } from 'react';

type Direction = 'ko-ja' | 'ja-ko';
type Result = { source:string; sourcePronunciation:string; translation:string; translationPronunciation:string; suggestion:string; suggestionPronunciation:string; suggestionMeaning:string; note:string };
type BrowserRecognition = { lang:string; interimResults:boolean; continuous:boolean; start:()=>void; onresult:((event:{results:ArrayLike<{0:{transcript:string};isFinal:boolean}>})=>void)|null; onerror:(()=>void)|null; onend:(()=>void)|null };
declare global { interface Window { webkitSpeechRecognition?:new()=>BrowserRecognition; SpeechRecognition?:new()=>BrowserRecognition } }

const sample:Result = {
  source:'나도. 오늘 시간이 너무 빨리 갔어.', sourcePronunciation:'ナド。オヌル シガニ ノム パルリ ガッソ。',
  translation:'私も。今日は時間があっという間だった。', translationPronunciation:'와타시모. 쿄오와 지칸가 앗토이우마닷타.',
  suggestion:'私も。君といると時間が経つのが早すぎる。', suggestionPronunciation:'와타시모. 키미토 이루토 지칸가 타츠노가 하야스기루.',
  suggestionMeaning:'나도. 너와 있으면 시간이 너무 빨리 가.', note:'연인에게는 함께한 시간을 넣으면 더 다정하게 들려요.'
};

export default function Home() {
  const [direction,setDirection]=useState<Direction>('ko-ja');
  const [tone,setTone]=useState('다정하게');
  const [listening,setListening]=useState(false);
  const [working,setWorking]=useState(false);
  const [result,setResult]=useState<Result>(sample);
  const [adopted,setAdopted]=useState(false);
  const [panel,setPanel]=useState<'study'|'words'|'memory'|'settings'|null>(null);
  const [key,setKey]=useState('');
  const [draftKey,setDraftKey]=useState('');
  const [error,setError]=useState('');
  const tones=['다정하게','자연스럽게','장난스럽게','진지하게'];
  const sourceLanguage=direction==='ko-ja'?'한국어':'일본어';
  const targetLanguage=direction==='ko-ja'?'일본어':'한국어';

  useEffect(()=>{
    const savedKey=localStorage.getItem('duri-gemini-key')||'';
    const savedResult=localStorage.getItem('duri-last-result');
    setKey(savedKey); setDraftKey(savedKey);
    if(savedResult){ try{setResult(JSON.parse(savedResult));}catch{} }
  },[]);

  async function findModel(apiKey:string){
    const response=await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=100`);
    if(!response.ok) throw new Error('번역 열쇠를 확인해 주세요.');
    const data=await response.json();
    const models:string[]=(data.models||[]).filter((item:{supportedGenerationMethods?:string[];name:string})=>item.supportedGenerationMethods?.includes('generateContent')&&/flash/.test(item.name)).map((item:{name:string})=>item.name.replace('models/',''));
    const preferred=models.find(name=>/2\.5-flash$/.test(name))||models.find(name=>/flash-latest/.test(name))||models[0];
    if(!preferred) throw new Error('사용할 수 있는 번역 모델이 없습니다.');
    return preferred;
  }

  async function translate(text:string){
    if(!key){setPanel('settings');throw new Error('먼저 번역 열쇠를 넣어 주세요.');}
    const model=await findModel(key);
    const prompt=`당신은 한국인과 일본인 연인을 돕는 통역가이자 언어 선생님이다. 입력 언어: ${sourceLanguage}. 번역 언어: ${targetLanguage}. 말투: ${tone}. 입력: ${text}. 직역하지 말고 해당 나라 연인이 실제로 쓰는 자연스러운 정서로 번역한다. 원문과 번역문 모두 상대방이 읽을 수 있는 발음을 붙인다. 한국어 발음은 일본어 가타카나로, 일본어 발음은 한글로 쓴다. 더 자연스러운 추천 표현과 짧은 이유도 만든다. 다음 JSON 키만 반환: source, sourcePronunciation, translation, translationPronunciation, suggestion, suggestionPronunciation, suggestionMeaning, note`;
    const response=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{responseMimeType:'application/json',temperature:.35}})});
    if(!response.ok) throw new Error(response.status===429?'잠시 사용량이 몰렸습니다. 조금 뒤 다시 눌러 주세요.':'번역에 실패했습니다. 설정의 열쇠를 확인해 주세요.');
    const data=await response.json(); const raw=data.candidates?.[0]?.content?.parts?.[0]?.text;
    if(!raw) throw new Error('번역 결과를 받지 못했습니다.');
    const parsed=JSON.parse(raw) as Result; setResult(parsed);setAdopted(false);localStorage.setItem('duri-last-result',JSON.stringify(parsed));
  }

  function startListening(){
    setError(''); const Recognition=window.SpeechRecognition||window.webkitSpeechRecognition;
    if(!Recognition){setError('이 휴대폰에서는 음성 인식을 열 수 없습니다. 사파리나 크롬으로 열어 주세요.');return;}
    if(!key){setPanel('settings');return;}
    const recognition=new Recognition(); recognition.lang=direction==='ko-ja'?'ko-KR':'ja-JP'; recognition.interimResults=false; recognition.continuous=false;
    recognition.onresult=async event=>{const text=event.results[0]?.[0]?.transcript;if(!text)return;setWorking(true);try{await translate(text);}catch(caught){setError(caught instanceof Error?caught.message:'번역에 실패했습니다.');}finally{setWorking(false);}};
    recognition.onerror=()=>{setListening(false);setError('말을 알아듣지 못했습니다. 다시 눌러 천천히 말해 주세요.');}; recognition.onend=()=>setListening(false); recognition.start();setListening(true);
  }

  function speak(text:string,lang:string){if(!('speechSynthesis'in window))return;window.speechSynthesis.cancel();const voice=new SpeechSynthesisUtterance(text);voice.lang=lang;voice.rate=.7;window.speechSynthesis.speak(voice);}
  function saveKey(){const clean=draftKey.replace(/\s/g,'');localStorage.setItem('duri-gemini-key',clean);setKey(clean);setPanel(null);setError(clean?'':'번역 열쇠가 필요합니다.');}

  return <main className="app-shell">
    <header className="topbar"><button className="avatar" onClick={()=>setPanel('settings')} aria-label="설정">⚙</button><div className="brand"><span className="brand-mark">ふたり</span><b>둘의 말</b></div><button className="history-button" onClick={()=>setPanel('memory')}>추억함 <span>12</span></button></header>
    <section className="conversation" aria-label="오늘 대화">
      <div className="day-label"><span/> 오늘, 우리 대화 <span/></div>
      <article className="message japanese"><div className="speaker">{targetLanguage} 번역</div><div className="bubble"><p className="main-copy">{adopted?result.suggestion:result.translation}</p><p className="pronunciation">{adopted?result.suggestionPronunciation:result.translationPronunciation}</p><p className="meaning">{adopted?result.suggestionMeaning:result.source}</p><button className="listen" onClick={()=>speak(adopted?result.suggestion:result.translation,direction==='ko-ja'?'ja-JP':'ko-KR')}>▶ 천천히 듣기</button></div></article>
      <article className="message korean mine"><div className="speaker">내가 한 말</div><div className="bubble"><p className="main-copy">{result.source}</p><p className="pronunciation japanese-reading">{result.sourcePronunciation}</p></div><aside className="ai-tip"><div><span>✦</span><b>더 자연스러운 연인 표현</b></div><p>{result.suggestion}</p><small>{result.suggestionPronunciation}<br/>{result.note}</small><button onClick={()=>setAdopted(!adopted)}>{adopted?'원래 번역 보기':'이 표현으로 바꾸기'}</button></aside></article>
      {error&&<p className="error-message">{error}</p>}
    </section>
    <section className="composer"><div className="mode-row"><button className="language" onClick={()=>setDirection(direction==='ko-ja'?'ja-ko':'ko-ja')}>{sourceLanguage} <span>⇄</span> {targetLanguage}</button><button className="tone" onClick={()=>setTone(tones[(tones.indexOf(tone)+1)%tones.length])}>{tone}⌄</button></div><button className={`mic ${listening?'active':''}`} onClick={startListening} disabled={working}><span className="mic-icon">●</span><b>{working?'자연스럽게 옮기는 중…':listening?'듣고 있어요':'눌러서 말하기'}</b><small>{listening?'말을 마치면 자동으로 번역해요':`${sourceLanguage}로 편하게 말하세요`}</small></button><nav className="quick-actions"><button onClick={()=>setPanel('study')}><span>あ</span>오늘의 공부</button><button onClick={()=>setPanel('words')}><span>♡</span>우리 단어장</button><button onClick={()=>setPanel('memory')}><span>▣</span>추억 남기기</button></nav></section>
    {panel&&<div className="sheet-backdrop" onClick={()=>setPanel(null)}><section className="sheet" onClick={event=>event.stopPropagation()}><div className="sheet-handle"/><button className="sheet-close" onClick={()=>setPanel(null)}>닫기</button>
      {panel==='settings'&&<><p className="sheet-kicker">처음 한 번만</p><h2>구글 번역 열쇠 넣기</h2><p className="sheet-meaning">기존 ‘둘의 말’에서 쓰던 구글 AI 열쇠를 넣으면 이 휴대폰에만 저장됩니다.</p><input className="key-input" type="password" value={draftKey} onChange={event=>setDraftKey(event.target.value)} placeholder="AIza로 시작하는 열쇠"/><button className="sheet-main" onClick={saveKey}>저장하고 실제 통역 시작</button></>}
      {panel==='study'&&<><p className="sheet-kicker">오늘의 한 문장</p><h2>{result.suggestion}</h2><p className="sheet-reading">{result.suggestionPronunciation}</p><p className="sheet-meaning">{result.suggestionMeaning}</p><button className="sheet-main" onClick={()=>speak(result.suggestion,direction==='ko-ja'?'ja-JP':'ko-KR')}>천천히 들어보기</button></>}
      {panel==='words'&&<><p className="sheet-kicker">우리만 아는 말</p><h2>둘만의 단어장</h2><ul className="word-list"><li><b>시오리</b><span>しおり · 사람 이름</span></li><li><b>우리 라멘집</b><span>いつものラーメン屋 · 늘 가는 곳</span></li></ul><button className="sheet-main">새 단어 넣기</button></>}
      {panel==='memory'&&<><p className="sheet-kicker">오늘의 대화</p><h2>오늘 말을 추억으로</h2><p className="memory-copy">“{result.source}”<br/>마지막 대화는 이 휴대폰에 자동으로 남아 있습니다.</p><button className="sheet-main" onClick={()=>setPanel(null)}>확인</button></>}
    </section></div>}
  </main>;
}
