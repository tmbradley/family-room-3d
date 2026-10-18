const code = new URLSearchParams(location.search).get('token');
if (code && /^[A-Z0-9-]{6,40}$/i.test(code)) document.getElementById('code').textContent = code.toUpperCase();
