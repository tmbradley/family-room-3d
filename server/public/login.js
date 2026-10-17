import { startRegistration, startAuthentication, browserSupportsWebAuthn } from 'https://esm.sh/@simplewebauthn/browser@13';

const $ = (id) => document.getElementById(id);
const show = (id) => ['signin', 'setup', 'recover', 'signedin'].forEach((s) => $(s).classList.toggle('hidden', s !== id));
const msg = (t, err = false) => { $('msg').textContent = t || ''; $('msg').className = 'msg' + (err ? ' err' : ''); };
const post = async (url, body) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}), credentials: 'same-origin' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
};

async function refresh() {
  const s = await fetch('/auth/status', { credentials: 'same-origin' }).then((r) => r.json());
  if (s.signedIn) { $('sub').textContent = 'Signed in.'; show('signedin'); }
  else if (!s.hasPasskeys) { $('sub').textContent = 'First-time setup: create your passkey.'; show('setup'); }
  else { $('sub').textContent = 'Sign in with your passkey.'; show('signin'); }
}

async function register(setupCode) {
  const options = await post('/auth/register/options', { setupCode });
  const response = await startRegistration({ optionsJSON: options });
  return post('/auth/register/verify', { response, deviceName: $('device').value || navigator.platform });
}

$('btn-setup').onclick = async () => {
  msg('');
  try {
    const r = await register($('setup-code').value);
    await refresh();
    if (r.recoveryCodes) {
      $('codes').innerHTML = r.recoveryCodes.map((c) => `<div>${c}</div>`).join('');
      $('codes-wrap').classList.remove('hidden');
    }
    msg('Passkey created.');
  } catch (e) { msg(e.message === 'invalid_setup_code' ? 'That setup code is not valid (or was already used).' : e.message, true); }
};

$('btn-signin').onclick = async () => {
  msg('');
  try {
    const options = await post('/auth/login/options');
    const response = await startAuthentication({ optionsJSON: options });
    await post('/auth/login/verify', { response });
    await refresh();
  } catch (e) { msg(e.message, true); }
};

$('btn-add').onclick = async () => {
  msg('');
  try { await register(); msg('Passkey added for this device.'); } catch (e) { msg(e.message, true); }
};
$('btn-recover').onclick = async () => {
  msg('');
  try { const r = await post('/auth/recover', { code: $('recovery-code').value }); await refresh(); msg(`Signed in. ${r.recoveryCodesLeft} recovery codes left. Add a new passkey now.`); }
  catch (e) { msg('That recovery code is not valid.', true); }
};
$('show-recover').onclick = () => show('recover');
$('hide-recover').onclick = () => refresh();
$('btn-open').onclick = () => (location.href = '/');
$('btn-logout').onclick = async () => { await post('/auth/logout'); $('codes-wrap').classList.add('hidden'); refresh(); };

if (!browserSupportsWebAuthn()) msg('This browser does not support passkeys.', true);
refresh().catch((e) => msg(e.message, true));
