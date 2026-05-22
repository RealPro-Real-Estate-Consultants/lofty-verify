(function () {
const head = document.getElementsByTagName('head')[0];
const script = document.createElement('script');
script.src = 'https://r2.leadsy.ai/tag.js';
script.setAttribute('async',  true);
script.setAttribute('data-pid',  '1fAaJN39H3FwvwRmG');
script.setAttribute('data-version',  '062024');
script.setAttribute('id', 'vtag-ai-js');
head.appendChild(script);
})();
/* AM-466105  Kenneth Ibea end */

(function(){
var B='https://lofty-verify-production-3aee.up.railway.app',Z='',p=null,done=!1,h=new WeakSet();
function n(r){var d=(r||'').replace(/\D/g,'');return d.length===10?'1'+d:d}
function send(ph){return fetch(B+'/send-verification',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phoneNumber:ph})})}
function build(ph){
var o=document.createElement('div');o.id='otpO';
o.innerHTML='<div class=otpB></div><div class=otpC><h3>Verify your phone</h3><p>We texted a 6-digit code to <b>+'+ph+'</b>.</p><input id=otpI type=tel inputmode=numeric maxlength=6 placeholder=123456><button id=otpG>Verify</button><button id=otpR type=button>Resend code</button><p id=otpM></p></div>';
document.body.appendChild(o);document.documentElement.style.overflow='hidden';
var m=o.querySelector('#otpM'),rb=o.querySelector('#otpR');
function cool(s){rb.disabled=!0;rb.textContent='Resend in '+s+'s';if(s<=0){rb.disabled=!1;rb.textContent='Resend code';return}setTimeout(function(){cool(s-1)},1000)}
rb.onclick=function(){m.style.color='#0a0';m.textContent='New code sent.';send(ph).catch(function(){m.style.color='#c33';m.textContent='Could not resend. Try again.'});cool(30)};
o.querySelector('#otpG').onclick=async function(){
var c=o.querySelector('#otpI').value.trim();
if(c.length!==6){m.style.color='#c33';m.textContent='Enter the 6-digit code.';return}
m.style.color='#c33';m.textContent='Checking...';
try{var r=await fetch(B+'/verify-otp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phoneNumber:ph,otp:c})});
var d=await r.json();
if(d&&d.status==='approved'){m.style.color='#0a0';m.textContent='Verified! Thank you.';done=!0;
if(Z)fetch(Z,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phoneNumber:ph,status:'approved'})}).catch(function(){});
setTimeout(function(){o.remove();document.documentElement.style.overflow=''},1200)}
else m.textContent='Incorrect or expired code. Tap Resend for a new one.'
}catch(e){m.textContent='Network error. Try again.'}};
}
function fire(){if(!p||done||document.getElementById('otpO'))return;send(p).catch(function(){});build(p)}
function scan(){
document.querySelectorAll('.pop-sign-log.register input[type=submit]').forEach(function(b){
if(h.has(b))return;h.add(b);
b.addEventListener('click',function(){
var w=b.closest('.submit');if(w&&w.classList.contains('disabled'))return;
var pop=b.closest('.pop-sign-log.register'),pe=pop&&pop.querySelector('input[name=phone]');
if(!pe)return;var ph=n(pe.value);if(ph.length>=11)p=ph;
},!0);});
document.querySelectorAll('button,input[type=submit],input[type=button],.submit,.confirm-btn').forEach(function(b){
if(h.has(b))return;var t=(b.innerText||b.value||'').trim().toLowerCase();
if(t!=='confirm')return;h.add(b);
b.addEventListener('click',function(){setTimeout(fire,800)},!0);
});
}
setInterval(scan,700);scan();
var s=document.createElement('style');
s.textContent='#otpO{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;font-family:sans-serif}#otpO .otpB{position:absolute;inset:0;background:rgba(0,0,0,.75)}#otpO .otpC{position:relative;background:#fff;padding:28px;border-radius:10px;max-width:380px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,.5)}#otpO h3{margin:0 0 10px;font-size:20px;color:#3e5da4}#otpO p{margin:8px 0;font-size:14px;color:#444}#otpO input{width:100%;padding:11px;font-size:20px;letter-spacing:6px;text-align:center;border:1px solid #ccc;border-radius:6px;margin:10px 0;box-sizing:border-box}#otpO button{width:100%;padding:12px;background:#3e5da4;color:#fff;border:0;border-radius:6px;font-size:15px;cursor:pointer;margin-top:6px}#otpO #otpR{background:#eee;color:#3e5da4}#otpO #otpR:disabled{background:#f5f5f5;color:#999;cursor:not-allowed}#otpO #otpM{min-height:18px;text-align:center;font-size:13px;margin:8px 0 0}';
document.head.appendChild(s);
})();