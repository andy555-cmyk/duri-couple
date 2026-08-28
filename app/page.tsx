'use client';
import { useEffect, useRef, useState } from 'react';

type Direction = 'ko-ja' | 'ja-ko';
type Result = { source:string; sourcePronunciation:string; translation:string; translationPronunciation:string; suggestion:string; suggestionPronunciation:string; suggestionMeaning:string; note:string };

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
  const recorderRef=useRef<MediaRecorder|null>(null);
  const chunksRef=useRef<Blob[]>([]);
  const tones=['다정하게','자연스럽게','장난스럽게','진지하게'];
  const sourceLanguage=direction==='ko-ja'?'한국어':'일본어';
  const targetLanguage=direction==='ko-ja'?'일본어':'한국어';

  useEffect(()=>{
    const savedKey=localStorage.getItem('duri-gemini-key')||'';
    const savedResult=localStorage.getItem('duri-last-result');
    setKey(savedKey); setDraftKey(savedKey);
    if(savedResult){ try{setResult(JSON.parse(savedResult));}catch{} }
  },[]);

  async function translateAudio(audio:string,mimeType:string){
    if(!key){setPanel('settings');throw new Error('먼저 번역 열쇠를 넣어 주세요.');}
    const model='gemini-3.7-flash';
    const prompt=`당신은 한국인과 일본인 연인을 돕는 통역가이자 언어 선생님이다. 첨부 음성을 정확히 받아쓴다. 입력 언어: ${sourceLanguage}. 번역 언어: ${targetLanguage}. 말투: ${tone}. 직역하지 말고 해당 나라 연인이 실제로 쓰는 자연스러운 정서로 번역한다. 원문과 번역문 모두 상대방이 읽을 수 있는 발음을 붙인다. 한국어 발음은 일본어 가타카나로, 일본어 발음은 한글로 쓴다. 더 자연스러운 추천 표현과 짧은 이유도 만든다. 다음 JSON 키만 반환: source, sourcePronunciation, translation, translationPronunciation, suggestion, suggestionPronunciation, suggestionMeaning, note`;
    const controller=new AbortController();
    const timer=window.setTimeout(()=>controller.abort(),20000);
    let response:Response;
    try{
      response=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,{method:'POST',headers:{'content-type':'application/json','x-goog-api-key':key},signal:controller.signal,body:JSON.stringify({contents:[{parts:[{text:prompt},{inlineData:{mimeType,data:audio}}]}],generationConfig:{responseMimeType:'application/json',temperature:.25,maxOutputTokens:600}})});
    }catch(caught){
      if(caught instanceof DOMException&&caught.name==='AbortError') throw new Error('20초 동안 답이 없어 멈췄습니다. 다시 말해 주세요.');
      throw new Error('구글 번역 서버에 연결하지 못했습니다. 잠시 뒤 다시 눌러 주세요.');
    }finally{window.clearTimeout(timer);}
    if(!response.ok){
      if(response.status===429) throw new Error('잠시 사용량이 몰렸습니다. 조금 뒤 다시 눌러 주세요.');
      if(response.status===401||response.status===403) throw new Error('구글이 이 열쇠의 사용을 거절했습니다. 새 열쇠가 저장됐는지 확인해 주세요.');
      throw new Error(`번역 연결에 실패했습니다. 오류 번호 ${response.status}`);
    }
    const data=await response.json(); const raw=data.candidates?.[0]?.content?.parts?.[0]?.text;
    if(!raw) throw new Error('번역 결과를 받지 못했습니다.');
    const parsed=JSON.parse(raw) as Result; setResult(parsed);setAdopted(false);localStorage.setItem('duri-last-result',JSON.stringify(parsed));
  }

  function blobToBase64(blob:Blob){return new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]||'');reader.onerror=()=>reject(new Error('음성을 읽지 못했습니다.'));reader.readAsDataURL(blob);});}

  async function toggleRecording(){
    setError('');
    if(!key){setPanel('settings');return;}
    if(listening){recorderRef.current?.stop();return;}
    if(!navigator.mediaDevices?.getUserMedia||typeof MediaRecorder==='undefined'){setError('이 화면에서는 마이크를 쓸 수 없습니다. 휴대폰 사파리에서 열어 주세요.');return;}
    try{
      const stream=await navigator.mediaDevices.getUserMedia({audio:true});
      const preferred=MediaRecorder.isTypeSupported('audio/mp4')?'audio/mp4':MediaRecorder.isTypeSupported('audio/webm')?'audio/webm':'';
      const recorder=new MediaRecorder(stream,preferred?{mimeType:preferred}:undefined); recorderRef.current=recorder;chunksRef.current=[];
      recorder.ondataavailable=event=>{if(event.data.size)chunksRef.current.push(event.data);};
      recorder.onstop=async()=>{setListening(false);setWorking(true);stream.getTracks().forEach(track=>track.stop());try{const blob=new Blob(chunksRef.current,{type:recorder.mimeType||'audio/webm'});if(blob.size<800)throw new Error('말이 녹음되지 않았습니다. 다시 눌러 말해 주세요.');const audio=await blobToBase64(blob);await translateAudio(audio,(blob.type||'audio/webm').split(';')[0]);}catch(caught){setError(caught instanceof Error?caught.message:'번역에 실패했습니다.');}finally{setWorking(false);}};
      recorder.start();setListening(true);
    }catch{setError('마이크 사용이 꺼져 있습니다. 주소창의 마이크 권한을 허용해 주세요.');}
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
    <section className="composer"><div className="mode-row"><button className="language" onClick={()=>setDirection(direction==='ko-ja'?'ja-ko':'ko-ja')}>{sourceLanguage} <span>⇄</span> {targetLanguage}</button><button className="tone" onClick={()=>setTone(tones[(tones.indexOf(tone)+1)%tones.length])}>{tone}⌄</button></div><button className={`mic ${listening?'active':''}`} onClick={toggleRecording} disabled={working}><span className="mic-icon">●</span><b>{working?'자연스럽게 옮기는 중…':listening?'말이 끝나면 다시 누르기':'눌러서 말하기'}</b><small>{listening?'지금 말하고, 끝나면 한 번 더 누르세요':`${sourceLanguage}로 편하게 말하세요`}</small></button><nav className="quick-actions"><button onClick={()=>setPanel('study')}><span>あ</span>오늘의 공부</button><button onClick={()=>setPanel('words')}><span>♡</span>우리 단어장</button><button onClick={()=>setPanel('memory')}><span>▣</span>추억 남기기</button></nav></section>
    {panel&&<div className="sheet-backdrop" onClick={()=>setPanel(null)}><section className="sheet" onClick={event=>event.stopPropagation()}><div className="sheet-handle"/><button className="sheet-close" onClick={()=>setPanel(null)}>닫기</button>
      {panel==='settings'&&<><p className="sheet-kicker">처음 한 번만</p><h2>구글 번역 열쇠 넣기</h2><p className="sheet-meaning">구글 AI Studio에서 만든 새 인증 열쇠를 넣으면 이 휴대폰에만 저장됩니다.</p><input className="key-input" type="password" value={draftKey} onChange={event=>setDraftKey(event.target.value)} placeholder="AQ로 시작하는 새 열쇠"/><button className="sheet-main" onClick={saveKey}>저장하고 실제 통역 시작</button></>}
      {panel==='study'&&<><p className="sheet-kicker">오늘의 한 문장</p><h2>{result.suggestion}</h2><p className="sheet-reading">{result.suggestionPronunciation}</p><p className="sheet-meaning">{result.suggestionMeaning}</p><button className="sheet-main" onClick={()=>speak(result.suggestion,direction==='ko-ja'?'ja-JP':'ko-KR')}>천천히 들어보기</button></>}
      {panel==='words'&&<><p className="sheet-kicker">우리만 아는 말</p><h2>둘만의 단어장</h2><ul className="word-list"><li><b>시오리</b><span>しおり · 사람 이름</span></li><li><b>우리 라멘집</b><span>いつものラーメン屋 · 늘 가는 곳</span></li></ul><button className="sheet-main">새 단어 넣기</button></>}
      {panel==='memory'&&<><p className="sheet-kicker">오늘의 대화</p><h2>오늘 말을 추억으로</h2><p className="memory-copy">“{result.source}”<br/>마지막 대화는 이 휴대폰에 자동으로 남아 있습니다.</p><button className="sheet-main" onClick={()=>setPanel(null)}>확인</button></>}
    </section></div>}
  </main>;
}
