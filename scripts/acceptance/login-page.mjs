import { writeFile } from 'node:fs/promises';
import { validateLocalTarget } from './target.mjs';

/** A secret-free, development-only Vite page. Never part of the production entrypoint. */
export async function prepareLoginPage(target) {
  if (!validateLocalTarget(target).ok) throw new Error('ACCEPTANCE_TARGET_UNSAFE');
  const page = new URL('../../apps/web/acceptance-login.html', import.meta.url);
  await writeFile(
    page,
    `<!doctype html><meta charset="utf-8"><title>036 local sign-in</title>
<h1>036 local beta sign-in</h1><p>Synthetic acceptance users only. Real Supabase Auth.</p>
<button id="current-session" type="button">Use current synthetic session</button>
<form><label>Email <input name="email" type="email" autocomplete="off" required></label><label>Password <input name="password" type="password" autocomplete="off" required></label><button>Sign in</button></form><p role="status"></p>
<script type="module">
import {getSupabaseClient} from '/src/lib/supabase.ts';
import {publicConfig} from '/src/lib/config.ts';
import {runAuthSessionMutation} from '/src/auth/session-mutations.ts';
import {acceptanceActorAllowed} from '/src/analytics/acceptance-capture.ts';
const status=document.querySelector('[role=status]');
const campaign=${JSON.stringify(target.namespace)};
function admit(user) {if(!user || !acceptanceActorAllowed(user,user.id,campaign)){status.textContent='Matching synthetic session required';return;}sessionStorage.setItem('soty.acceptance.capture.v1',campaign);location.replace('/');}
if (!import.meta.env.DEV || import.meta.env.VITE_APP_ENVIRONMENT !== 'beta' || location.origin !== 'http://127.0.0.1:5175' || import.meta.env.VITE_LOCAL_DEV_AUTH === 'true' || import.meta.env.VITE_MOCK_DATA === 'true' || !publicConfig.ok || publicConfig.value.supabaseUrl !== 'http://127.0.0.1:54321') {document.querySelector('form').remove();document.querySelector('#current-session').remove();status.textContent='Not available outside local beta';}
else {
document.querySelector('#current-session').addEventListener('click',async()=>{const client=getSupabaseClient();if(!client){status.textContent='Local configuration unavailable';return;}const {data,error}=await client.auth.getUser();if(error){status.textContent='Current session unavailable';return;}admit(data.user);});
document.querySelector('form').addEventListener('submit', async event => {
event.preventDefault();const form=new FormData(event.currentTarget);const client=getSupabaseClient();
if(!client){status.textContent='Local configuration unavailable';return;}
const email=String(form.get('email')).trim().toLowerCase();
const allowedEmails=new Set(['a','b','c','s','x','solo','pending'].map(alias=>campaign+'-'+alias+'@soty.invalid'));
if(!allowedEmails.has(email)){status.textContent='Matching synthetic address required';return;}
try {
const {data,error}=await runAuthSessionMutation(publicConfig.value.supabaseUrl,()=>client.auth.signInWithPassword({email,password:String(form.get('password'))}));
if(error){status.textContent='Sign-in failed';return;}admit(data.user);
}catch{status.textContent='Sign-in could not finish';}
});
}
</script>`,
    { mode: 0o600 }
  );
  return { url: 'http://127.0.0.1:5175/acceptance-login.html' };
}
