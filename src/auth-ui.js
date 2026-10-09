(() => {
  const api = window.EchoApi
  const screen = document.querySelector('#auth-screen')
  if (!screen || api.mode !== 'http') { window.EchoAuthReady = Promise.resolve(); return }
  const form = document.querySelector('#auth-form')
  const submit = document.querySelector('#auth-submit')
  const feedback = document.querySelector('#auth-feedback')
  const username = document.querySelector('#auth-username')
  const password = document.querySelector('#auth-password')
  const show = () => { screen.hidden = false; document.querySelector('.app-shell').inert = true; username.focus() }
  const hide = () => { screen.hidden = true; document.querySelector('.app-shell').inert = false }
  window.EchoAuthReady = (async () => {
    const token = api.currentToken()
    if (token) {
      try { await api.getMe(); hide(); return }
      catch { localStorage.removeItem('echo.auth.v1') }
    }
    show()
    await new Promise((resolve) => { window.addEventListener('echo:authenticated', resolve, { once: true }) })
    hide()
  })()
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); submit.disabled = true; feedback.textContent = '正在登录…'
    try { await api.login(username.value, password.value); password.value = ''; window.dispatchEvent(new Event('echo:authenticated')) }
    catch (error) { feedback.textContent = error.status === 429 ? error.message : '用户名或密码不正确'; password.select() }
    finally { submit.disabled = false }
  })
  document.querySelector('#logout-button')?.addEventListener('click', async () => { await api.logout(); show() })
  window.addEventListener('echo:signed-out', show)
  api.subscribe('auth.expired', () => { feedback.textContent = '登录已过期，请重新登录'; show() })
})()
