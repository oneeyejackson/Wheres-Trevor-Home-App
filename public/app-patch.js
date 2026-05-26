(()=>{
  const css=document.createElement('style');
  css.textContent='.schedule-row-wrap{cursor:pointer}.schedule-row-wrap:focus{outline:2px solid #d8b56d}.guest-lock-button{background:#a9c79b!important;color:#071007!important}.guest-card{max-width:900px;margin:50px auto;text-align:center}.clock{font-size:clamp(70px,18vw,180px);letter-spacing:-.09em;line-height:.85;margin:7vh 0 8px}.home-subtitle{font-size:20px;color:#b8b7aa;margin:10px 0 0}.countdown{font-size:26px;color:#d8b56d;font-weight:850;margin:18px 0 0}.alert-status.active{color:#ff9d8e;font-weight:850}';
  document.head.appendChild(css);
  const root=document.getElementById('app');
  const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  async function homeWeather(){try{const u='https://api.open-meteo.com/v1/forecast?latitude=34.1683&longitude=-118.1190&current=temperature_2m,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FLos_Angeles&forecast_days=1';const r=await fetch(u),d=await r.json();let alerts=[];try{const ar=await fetch('https://api.weather.gov/alerts/active?point=34.1683,-118.1190'),ad=await ar.json();alerts=(ad.features||[]).slice(0,2).map(f=>f.properties?.event).filter(Boolean)}catch{}return{temperature:Math.round(d?.current?.temperature_2m??0),wind:Math.round(d?.current?.wind_speed_10m??0),high:Math.round(d?.daily?.temperature_2m_max?.[0]??0),low:Math.round(d?.daily?.temperature_2m_min?.[0]??0),precip:d?.daily?.precipitation_probability_max?.[0],alerts}}catch{return{unavailable:'Home weather unavailable',alerts:[]}}}
  function wtxt(w){if(!w)return'Loading';if(w.unavailable)return w.unavailable;return[`${w.temperature}°F`,w.high!=null?`${w.high}° / ${w.low}°`:'',w.wind!=null?`Wind ${w.wind} mph`:'',w.precip!=null?`${w.precip}% rain`:''].filter(Boolean).join(' · ')}
  async function showGuestLock(){localStorage.setItem('wt_guest_lock','1');const w=await homeWeather();root.innerHTML=`<main><section class="card guest-card"><div class="row between"><span class="pill sage">Guest mode</span><button class="secondary" onclick="document.getElementById('pinForm').classList.toggle('hidden')">Unlock full app</button></div><div id="clock" class="clock"></div><h2 id="dateLine"></h2><p class="muted">Pasadena</p><h2>${esc(w.temperature??'—')}°F</h2><p class="muted">${esc(wtxt(w))}</p><p class="muted">${esc((w.alerts||[]).length?'⚠ '+w.alerts.join(' · '):'No active advisories')}</p><form id="pinForm" class="hidden"><label>Unlock code</label><input name="pin" inputmode="numeric"><button>Unlock</button><p id="pinMsg" class="err"></p></form></section></main>`;const tick=()=>{const d=new Date;clock.textContent=d.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});dateLine.textContent=d.toLocaleDateString([],{weekday:'long',month:'long',day:'numeric'})};tick();setInterval(tick,1000);pinForm.onsubmit=async e=>{e.preventDefault();const body=JSON.stringify(Object.fromEntries(new FormData(pinForm)));try{const r=await fetch('/api/guest-pin',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body});const j=await r.json();if(j.ok){localStorage.removeItem('wt_guest_lock');location.reload()}else pinMsg.textContent='Wrong code'}catch{pinMsg.textContent='Unlock failed'}}}
  window.enterGuestLock=showGuestLock;
  if(localStorage.getItem('wt_guest_lock')==='1') setTimeout(showGuestLock,50);
  const old=window.toggleDay;
  window.toggleDay=async function(date){document.querySelectorAll('.expanded-day').forEach(el=>{if(el.id!=='day-'+date)el.classList.add('hidden')});if(old)return old(date)};
  document.addEventListener('click',e=>{const card=e.target.closest('.schedule-row-wrap');if(!card||e.target.closest('button,a,input,textarea'))return;const box=card.querySelector('.expanded-day');if(box&&box.id){e.preventDefault();window.toggleDay(box.id.replace('day-',''))}});
  const mo=new MutationObserver(()=>{const menu=document.querySelector('#userMenu .row');if(menu&&!menu.querySelector('.guest-lock-button')){const b=document.createElement('button');b.textContent='Guest mode';b.className='guest-lock-button';b.onclick=showGuestLock;menu.insertBefore(b,menu.lastElementChild)}});
  mo.observe(document.body,{childList:true,subtree:true});
  let lastRefresh=0;
  async function softRefresh(reason){
    if(localStorage.getItem('wt_guest_lock')==='1') return;
    if(document.hidden && reason!=='visible') return;
    if(typeof window.load!=='function') return;
    const now=Date.now();
    if(now-lastRefresh<45000 && reason!=='visible') return;
    lastRefresh=now;
    try{await window.load()}catch{}
  }
  setInterval(()=>softRefresh('timer'),60000);
  setInterval(()=>{if(localStorage.getItem('wt_guest_lock')==='1')showGuestLock()},900000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)softRefresh('visible')});
  window.addEventListener('focus',()=>softRefresh('visible'));
  const script=document.createElement('script');script.src='/home-final.js';script.defer=true;document.head.appendChild(script);
})();
