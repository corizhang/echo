(() => {
  const accepted = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
  const labels = { 'image/png': 'PNG', 'image/jpeg': 'JPG', 'image/gif': 'GIF', 'image/webp': 'WebP' }

  function open(options) {
    const files = []
    const overlay = document.createElement('div'); overlay.className = 'sticker-upload-overlay'; overlay.setAttribute('role', 'presentation')
    const dialog = document.createElement('section'); dialog.className = 'sticker-upload-dialog'; dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-labelledby', 'sticker-upload-title')
    const header = document.createElement('header'); header.className = 'sticker-upload-header'
    const heading = document.createElement('div'); const title = document.createElement('h2'); title.id = 'sticker-upload-title'; title.textContent = options.title || '上传表情包'; const subtitle = document.createElement('p'); subtitle.textContent = options.subtitle || '可一次选择多张图片，并逐张维护信息。'; heading.append(title, subtitle)
    const close = document.createElement('button'); close.type = 'button'; close.className = 'icon-button'; close.setAttribute('aria-label', '关闭'); close.innerHTML = '<svg class="icon"><use href="#i-close"/></svg>'; header.append(heading, close)
    const body = document.createElement('div'); body.className = 'sticker-upload-body'
    const toolbar = document.createElement('div'); toolbar.className = 'sticker-upload-toolbar'
    const add = document.createElement('button'); add.type = 'button'; add.className = 'sticker-upload-add'; add.textContent = '添加图片'
    const fileInput = document.createElement('input'); fileInput.type = 'file'; fileInput.accept = [...accepted].join(','); fileInput.multiple = true; fileInput.hidden = true
    const count = document.createElement('span'); count.className = 'sticker-upload-count'
    toolbar.append(add, fileInput, count)
    const groupCreate = document.createElement('div'); groupCreate.className = 'sticker-upload-group-create'
    let groupNameInput = null
    if (options.onCreateGroup) {
      groupNameInput = document.createElement('input'); groupNameInput.type = 'text'; groupNameInput.maxLength = 32; groupNameInput.placeholder = '新建分组名称'
      const createGroup = document.createElement('button'); createGroup.type = 'button'; createGroup.textContent = '创建分组'
      createGroup.addEventListener('click', async () => {
        const name = groupNameInput.value.trim(); if (!name) { groupNameInput.focus(); return }
        createGroup.disabled = true
        try { await options.onCreateGroup(name); groupNameInput.value = ''; drawRows() }
        catch (error) { announce(error.message || '创建分组失败', true) }
        finally { createGroup.disabled = false }
      })
      groupCreate.append(groupNameInput, createGroup)
    }
    const rows = document.createElement('div'); rows.className = 'sticker-upload-rows'
    const feedback = document.createElement('div'); feedback.className = 'sticker-upload-feedback'; feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite')
    const footer = document.createElement('footer'); footer.className = 'sticker-upload-footer'
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'sticker-upload-cancel'; cancel.textContent = '取消'
    const submit = document.createElement('button'); submit.type = 'button'; submit.className = 'sticker-upload-submit'; submit.textContent = '上传全部'
    footer.append(cancel, submit); body.append(toolbar); if (groupNameInput) body.append(groupCreate); body.append(rows, feedback, footer); dialog.append(header, body); overlay.append(dialog); document.body.append(overlay)

    let busy = false
    const revoke = (row) => { if (row.preview) URL.revokeObjectURL(row.preview) }
    const announce = (message, error = false) => { feedback.textContent = message; feedback.classList.toggle('is-error', error) }
    const dispose = () => { files.forEach(revoke); overlay.remove(); document.removeEventListener('keydown', onKey) }
    const closeIfIdle = () => { if (!busy) dispose() }
    const safeFilename = (file) => file.name.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 40) || '表情'
    const groupOptions = () => typeof options.groups === 'function' ? options.groups() : (options.groups || [])
    const drawRows = () => {
      rows.replaceChildren(); count.textContent = `${files.length} 张图片 · ${files.reduce((sum, row) => sum + row.file.size, 0) > 0 ? `${(files.reduce((sum, row) => sum + row.file.size, 0) / 1024 / 1024).toFixed(1)} MB` : '0 MB'}`
      submit.disabled = busy || !files.some((row) => row.status !== 'done'); submit.textContent = busy ? '上传中…' : files.some((row) => row.status === 'error') ? '重试失败项' : '上传全部'
      if (!files.length) { const empty = document.createElement('div'); empty.className = 'sticker-upload-empty'; empty.textContent = '选择一张或多张 PNG、JPG、GIF、WebP 图片'; rows.append(empty); return }
      for (const row of files) {
        const card = document.createElement('article'); card.className = 'sticker-upload-row'; card.classList.toggle('has-error', row.status === 'error')
        const image = document.createElement('img'); image.src = row.preview; image.alt = ''; image.className = 'sticker-upload-preview'
        const fields = document.createElement('div'); fields.className = 'sticker-upload-fields'
        const name = document.createElement('label'); name.className = 'sticker-upload-field'; const nameText = document.createElement('span'); nameText.textContent = options.nameLabel || '名称'; const nameInput = document.createElement('input'); nameInput.type = 'text'; nameInput.maxLength = options.nameMax || 40; nameInput.value = row.name; nameInput.placeholder = '输入名称'; nameInput.addEventListener('input', () => { row.name = nameInput.value }); name.append(nameText, nameInput); fields.append(name)
        const meta = document.createElement('label'); meta.className = 'sticker-upload-field'; const metaText = document.createElement('span'); metaText.textContent = options.metaLabel || '分组'; meta.append(metaText)
        if (options.metaMode === 'text') { const input = document.createElement('input'); input.type = 'text'; input.maxLength = 32; input.setAttribute('list', 'sticker-upload-emotions'); input.value = row.meta || options.defaultMeta || ''; input.placeholder = '例如：卖萌、开心'; input.addEventListener('input', () => { row.meta = input.value }); meta.append(input) }
        else {
          const select = document.createElement('select'); const none = document.createElement('option'); none.value = ''; none.textContent = '未分组'; select.append(none)
          for (const group of groupOptions()) { const option = document.createElement('option'); option.value = group.id; option.textContent = group.name; select.append(option) }
          select.value = row.groupId || ''; select.addEventListener('change', () => { row.groupId = select.value }); meta.append(select)
        }
        fields.append(meta)
        if (options.description) { const desc = document.createElement('label'); desc.className = 'sticker-upload-field sticker-upload-description'; const descText = document.createElement('span'); descText.textContent = '选图说明'; const descInput = document.createElement('input'); descInput.type = 'text'; descInput.maxLength = 240; descInput.value = row.description || ''; descInput.placeholder = '描述图片内容和适用情绪，帮助机器人选图'; descInput.addEventListener('input', () => { row.description = descInput.value }); desc.append(descText, descInput); fields.append(desc) }
        const status = document.createElement('div'); status.className = `sticker-upload-row-status ${row.status}`; status.textContent = row.status === 'done' ? '已上传' : row.status === 'uploading' ? '正在上传…' : row.status === 'error' ? row.error || '上传失败' : `${labels[row.file.type] || '图片'} · ${(row.file.size / 1024).toFixed(0)} KB`
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'sticker-upload-remove'; remove.textContent = '移除'; remove.disabled = busy; remove.addEventListener('click', () => { revoke(row); files.splice(files.indexOf(row), 1); drawRows() })
        card.append(image, fields, status, remove); rows.append(card)
      }
    }
    const addFiles = (list) => {
      let rejected = 0
      for (const file of list) {
        if (!accepted.has(file.type) || (options.maxSize && file.size > options.maxSize)) { rejected++; continue }
        if (files.some((row) => row.file.name === file.name && row.file.size === file.size && row.file.lastModified === file.lastModified)) continue
        files.push({ file, name: options.nameFromFile ? options.nameFromFile(file) : safeFilename(file), groupId: options.defaultGroupId || '', meta: options.defaultMeta || '', description: '', preview: URL.createObjectURL(file), status: 'ready', error: '' })
      }
      drawRows(); if (rejected) announce(`${rejected} 个文件格式或大小不符合要求；支持 PNG、JPG、GIF、WebP${options.maxSize ? `，单张不超过 ${(options.maxSize / 1024 / 1024).toFixed(options.maxSize < 1024 * 1024 ? 2 : 0)} MB` : ''}。`, true)
    }
    const onKey = (event) => { if (event.key === 'Escape') closeIfIdle() }
    add.addEventListener('click', () => fileInput.click()); fileInput.addEventListener('change', () => { addFiles([...fileInput.files]); fileInput.value = '' })
    close.addEventListener('click', closeIfIdle); cancel.addEventListener('click', closeIfIdle); overlay.addEventListener('click', (event) => { if (event.target === overlay) closeIfIdle() }); document.addEventListener('keydown', onKey)
    submit.addEventListener('click', async () => {
      if (busy) return
      const pending = files.filter((row) => row.status !== 'done')
      const invalid = pending.find((row) => !row.name.trim() || (options.metaRequired && !row.meta.trim()) || (options.namePattern && !options.namePattern.test(row.name.trim())))
      if (invalid) { announce(options.metaRequired && !invalid.meta.trim() ? `请为“${invalid.name || invalid.file.name}”填写${options.metaLabel || '分组'}。` : options.namePattern && !options.namePattern.test(invalid.name.trim()) ? 'Emoji 短码需为 2–32 位英文字母、数字或下划线。' : '请填写每张图片的名称。', true); rows.querySelector('.sticker-upload-field input:invalid')?.focus(); return }
      busy = true; submit.disabled = true; cancel.disabled = true; close.disabled = true; add.disabled = true
      let succeeded = 0; let failed = 0
      try {
        for (const row of pending) {
          row.status = 'uploading'; row.error = ''; drawRows()
          try { await options.onUpload({ file: row.file, name: row.name.trim(), groupId: row.groupId, meta: row.meta.trim(), description: (row.description || '').trim() }); row.status = 'done'; succeeded++ }
          catch (error) { row.status = 'error'; row.error = error.message || '上传失败'; failed++ }
          drawRows()
        }
        if (options.onComplete) { try { await options.onComplete({ succeeded, failed }) } catch (error) { announce(`图片已上传，但图库刷新失败：${error.message || '请重新打开图库'}`, true) } }
        if (!failed) dispose()
        else announce(`已上传 ${succeeded} 张，${failed} 张失败。修改后可重试失败项。`, true)
      } finally { busy = false; cancel.disabled = false; close.disabled = false; add.disabled = false; drawRows() }
    })
    addFiles(options.files || []); drawRows(); close.focus()
  }

  window.EchoStickerUpload = { open }
})()
