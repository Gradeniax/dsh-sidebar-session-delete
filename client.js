/**
 * dsh-sidebar-session-delete — Client half.
 *
 * Two surfaces over one Host route family:
 *
 *   1. a `Delete conversation` row in each Session's "..." menu
 *      (`sidebar.workspaces.session.menu.item`, the same additive slot the
 *      shipped pin / rename / fork / archive rows use), whose confirmation moves
 *      the conversation to the trash;
 *   2. a Trash panel (`sidebar.panellist` icon + `main` page) that lists what
 *      was deleted and offers Restore, Delete forever, and Empty trash.
 *
 * No DOM injection, no MutationObserver, no React-fiber reading: the slot owner
 * supplies the row's `sessionId` and `displayTitle` and injects the menu's
 * open-state hook, so the command dismisses the menu exactly like a shipped row.
 */
window.__ModuleLoader__.load({
  id: 'dsh-sidebar-session-delete',
  factory(require) {
    const React = require('react')

    const NS = 'sidebar-session-delete'
    const PANEL_ID = 'sidebar-session-delete.trash'
    const ROUTE = '/dsh-sidebar-session-delete'

    /** Trash entries fetched from the Host, refreshed after every mutation. */
    let trashState = { status: 'idle', entries: [], error: null }
    const trashListeners = new Set()
    const trashStore = {
      getSnapshot: () => trashState,
      subscribe: (listener) => {
        trashListeners.add(listener)
        return () => trashListeners.delete(listener)
      },
    }
    const publishTrash = (next) => {
      trashState = next
      for (const listener of [...trashListeners]) listener()
    }
    const loadTrash = async () => {
      publishTrash({ ...trashState, status: trashState.entries.length === 0 ? 'loading' : 'ready', error: null })
      try {
        const response = await fetch(`${ROUTE}/trash`)
        const body = await response.json()
        if (body?.ok === true) publishTrash({ status: 'ready', entries: body.entries ?? [], error: null })
        else publishTrash({ status: 'error', entries: trashState.entries, error: body?.code ?? 'unknown' })
      } catch {
        publishTrash({ status: 'error', entries: trashState.entries, error: 'network' })
      }
    }

    /** Display strings; English is the baseline, Chinese follows the GUI locale. */
    const DICTS = {
      en: {
        delete: 'Delete conversation',
        title: 'Move conversation to trash?',
        body: 'The conversation “{name}” moves to the trash. You can restore it from there until you delete it forever.',
        untitled: 'Untitled conversation',
        cancel: 'Cancel',
        confirm: 'Move to trash',
        busy: 'Moving…',
        restore: 'Restore',
        restoreBusy: 'Restoring…',
        purge: 'Delete forever',
        purgeTitle: 'Delete forever?',
        purgeBody: 'The conversation “{name}” and its log are removed permanently. This cannot be undone.',
        purgeConfirm: 'Delete forever',
        purgeBusy: 'Deleting…',
        emptyTrash: 'Empty trash',
        emptyTitle: 'Empty the trash?',
        emptyBody: 'All {count} conversations in the trash are removed permanently. This cannot be undone.',
        emptyConfirm: 'Empty trash',
        emptyBusy: 'Emptying…',
        trashTitle: 'Trash',
        trashSubtitle: 'Deleted conversations stay here until you delete them forever.',
        trashEmpty: 'The trash is empty.',
        trashCount: '{count} conversations',
        trashCountOne: '1 conversation',
        restored: 'Restored “{name}”.',
        panel: 'Trash',
        deletedAt: 'Deleted {when}',
        running: 'This conversation is still running. Stop it first.',
        missing: 'No stored record was found for this conversation.',
        'already-trashed': 'This conversation is already in the trash.',
        'not-trashed': 'That conversation is not in the trash.',
        'archive-refused': 'This conversation still has running work, so it was not moved.',
        'move-failed': 'The conversation could not be moved to the trash.',
        'remove-failed': 'The conversation could not be removed from disk.',
        'stat-failed': 'This conversation’s log could not be read, so it was left untouched.',
        'bad-path': 'The stored path is outside the session root, so it was left untouched.',
        internal: 'The Host hit an unexpected error.',
        network: 'The Host could not be reached.',
        unknown: 'The operation failed.',
        retry: 'Retry',
      },
      zh: {
        delete: '删除对话',
        title: '将对话移入回收站？',
        body: '对话“{name}”将被移入回收站。你可以随时从回收站恢复，直到永久删除。',
        untitled: '未命名对话',
        cancel: '取消',
        confirm: '移入回收站',
        busy: '正在移入…',
        restore: '恢复',
        restoreBusy: '正在恢复…',
        purge: '永久删除',
        purgeTitle: '永久删除？',
        purgeBody: '对话“{name}”及其日志将被永久删除，无法恢复。',
        purgeConfirm: '永久删除',
        purgeBusy: '正在删除…',
        emptyTrash: '清空回收站',
        emptyTitle: '清空回收站？',
        emptyBody: '回收站中的 {count} 个对话将被永久删除，无法恢复。',
        emptyConfirm: '清空回收站',
        emptyBusy: '正在清空…',
        trashTitle: '回收站',
        trashSubtitle: '已删除的对话会保留在这里，直到你永久删除。',
        trashEmpty: '回收站是空的。',
        trashCount: '{count} 个对话',
        trashCountOne: '1 个对话',
        restored: '已恢复“{name}”。',
        panel: '回收站',
        deletedAt: '删除于 {when}',
        running: '该对话仍在运行，请先停止。',
        missing: '未找到该对话的本地记录。',
        'already-trashed': '该对话已在回收站中。',
        'not-trashed': '该对话不在回收站中。',
        'archive-refused': '该对话仍有运行中的任务，未移入回收站。',
        'move-failed': '无法将该对话移入回收站。',
        'remove-failed': '无法从磁盘移除该对话。',
        'stat-failed': '无法读取该对话的日志，已保持原样未删除。',
        'bad-path': '存储路径不在会话根目录内，已保持原样未删除。',
        internal: 'Host 发生未预期的错误。',
        network: '无法连接 Host 服务。',
        unknown: '操作失败。',
        retry: '重试',
      },
    }

    /**
     * Build a translate function bound to the live locale.
     * @param ctx - restricted Client context.
     * @returns translate(key, params?) reading the active language at call time.
     */
    function createTranslator(ctx) {
      const locale = ctx.get('locale')
      if (locale !== undefined && typeof locale.register === 'function') {
        for (const lang of Object.keys(DICTS)) {
          try {
            ctx.effect(() => locale.register(NS, lang, DICTS[lang]), `${NS} locale ${lang}`)
          } catch (error) {
            console.warn(`[${NS}] locale registration failed for ${lang}`, error)
          }
        }
        try {
          const bound = locale.bind(NS)
          if (typeof bound === 'function') {
            return (key, params) => {
              const text = bound(key, params)
              return typeof text === 'string' && text !== '' && text !== key ? text : fallback(key, params)
            }
          }
        } catch {
          /* Fall through to the local reader. */
        }
      }
      const readActive = () => {
        try {
          const snapshot = typeof locale?.getLocale === 'function' ? locale.getLocale() : undefined
          const id = typeof snapshot === 'string' ? snapshot : String(snapshot?.active ?? '')
          return id.toLowerCase().startsWith('zh') ? DICTS.zh : DICTS.en
        } catch {
          return DICTS.en
        }
      }
      function fallback(key, params) {
        const dict = readActive()
        const template = dict[key] ?? DICTS.en[key] ?? key
        if (params === undefined || typeof params !== 'object') return template
        return template.replace(/\{(\w+)\}/g, (match, name) =>
          typeof params[name] === 'string' || typeof params[name] === 'number' ? String(params[name]) : match,
        )
      }
      return fallback
    }

    /** Menu row, dialog, and trash-page styles — theme tokens only. */
    const CSS = `
.dssd-wrap{position:relative}
.dssd-item{display:flex;align-items:center;gap:6px;width:100%;min-height:34px;padding:6px 8px;border:none;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px;text-align:left;cursor:pointer}
.dssd-item:hover,.dssd-item:focus-visible{background:var(--dsw-alias-interactive-bg-hover-danger);outline:none}
.dssd-icon{display:inline-flex;flex:none;width:14px;height:14px;align-items:center;justify-content:center;color:inherit}
.dssd-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dssd-mask{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;padding:24px;pointer-events:auto;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur)}
.dssd-dialog{box-sizing:border-box;display:flex;flex-direction:column;gap:20px;width:min(440px,100%);max-height:calc(100dvh - 48px);padding:22px 24px 24px;overflow:auto;border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent)}
.dssd-title{margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary)}
.dssd-body{display:flex;align-items:flex-start;gap:10px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary)}
.dssd-body p{margin:0;overflow-wrap:anywhere}
.dssd-warn{flex:none;margin-top:2px;color:var(--dsw-alias-state-error-primary)}
.dssd-error{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.dssd-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px}
.dssd-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;height:36px;padding:0 14px;border:none;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px;cursor:pointer}
.dssd-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dssd-btn:disabled{cursor:not-allowed;opacity:.4}
.dssd-danger{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground)}
.dssd-danger:hover:not(:disabled){opacity:.9;background:var(--dsw-alias-state-error-primary)}
.dssd-page{box-sizing:border-box;display:flex;flex-direction:column;height:100%;min-height:0;padding:24px 24px 0;color:var(--dsw-alias-label-primary)}
.dssd-pageHead{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding-bottom:16px;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.dssd-pageTitle{margin:0;font-size:18px;line-height:26px;font-weight:500}
.dssd-pageSub{margin:4px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dssd-pageBody{flex:1;min-height:0;overflow-y:auto;padding:8px 0 24px}
.dssd-row{display:flex;align-items:center;gap:12px;padding:12px 4px;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.dssd-row:last-child{border-bottom:none}
.dssd-rowMain{flex:1;min-width:0}
.dssd-rowTitle{font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dssd-rowMeta{margin-top:2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dssd-rowActions{display:flex;align-items:center;gap:6px;flex:none}
.dssd-small{height:30px;padding:0 10px;font-size:12px;line-height:18px;border-radius:var(--dsw-radius-sm)}
.dssd-ghost{color:var(--dsw-alias-label-secondary)}
.dssd-ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dssd-dangerText{color:var(--dsw-alias-state-error-primary)}
.dssd-dangerText:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}
.dssd-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:64px 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.dssd-note{margin:0 0 12px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dssd-alert{margin:0 0 12px;padding:8px 10px;border:.5px solid var(--dsw-alias-state-error-primary);border-radius:var(--dsw-radius-md);font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.dssd-ok{margin:0 0 12px;padding:8px 10px;border:.5px solid var(--dsw-alias-state-success-primary);border-radius:var(--dsw-radius-md);font-size:12px;line-height:18px;color:var(--dsw-alias-state-success-primary)}
`

    /** Trash glyph in the shipped row-icon size and ink. */
    function IconTrash({ size = 14 }) {
      return React.createElement(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        React.createElement('path', {
          d: 'M2.6 4.4h10.8M6.4 2.2h3.2M4.3 4.4l.6 8.4c0 .7.6 1.2 1.3 1.2h3.6c.7 0 1.3-.5 1.3-1.2l.6-8.4M6.6 7v4.2M9.4 7v4.2',
        }),
      )
    }

    /** Warning glyph for confirmation bodies. */
    function IconWarning() {
      return React.createElement(
        'svg',
        { viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none', 'aria-hidden': true },
        React.createElement('path', {
          d: 'M8 2 14.6 13.6H1.4L8 2Z',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinejoin: 'round',
        }),
        React.createElement('path', { d: 'M8 6.1v3.2', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
        React.createElement('circle', { cx: 8, cy: 11.5, r: 0.85, fill: 'currentColor' }),
      )
    }

    /** Restore glyph: an arrow curving back. */
    function IconRestore({ size = 14 }) {
      return React.createElement(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        React.createElement('path', { d: 'M3 7.2A5.2 5.2 0 1 1 4.2 11.2' }),
        React.createElement('path', { d: 'M2.6 3.2v4.2h4.2' }),
      )
    }

    /**
     * Send one mutation to the Host.
     * @param endpoint - route suffix after the plugin prefix.
     * @param payload - JSON body.
     * @returns the parsed outcome, or a synthetic failure.
     */
    async function call(endpoint, payload) {
      try {
        const response = await fetch(`${ROUTE}${endpoint}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload ?? {}),
        })
        const body = await response.json().catch(() => null)
        if (body === null) return { ok: false, code: 'unknown' }
        return body
      } catch {
        return { ok: false, code: 'network' }
      }
    }

    /**
     * One pending confirmation, shared by the menu row and the overlay.
     * @param props - the request, its settlement, and the translate function.
     */
    function ConfirmDialog({ request, settle, t }) {
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const confirmRef = React.useRef(null)

      React.useEffect(() => {
        setBusy(false)
        setError(null)
        confirmRef.current?.focus()
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          if (!busy) settle()
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [request, settle, busy])

      const run = async () => {
        setBusy(true)
        setError(null)
        const outcome = await call(request.endpoint, request.payload)
        setBusy(false)
        if (outcome.ok === true) {
          settle()
          request.onDone?.(outcome)
          return
        }
        setError(t(typeof outcome.code === 'string' ? outcome.code : 'unknown'))
      }

      return React.createElement(
        'div',
        {
          className: 'dssd-mask',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget && !busy) settle()
          },
        },
        React.createElement(
          'div',
          { className: 'dssd-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dssd-title' },
          React.createElement('h2', { className: 'dssd-title', id: 'dssd-title' }, t(request.titleKey)),
          React.createElement(
            'div',
            { className: 'dssd-body' },
            React.createElement('span', { className: 'dssd-warn' }, React.createElement(IconWarning, null)),
            React.createElement('p', null, t(request.bodyKey, request.bodyParams)),
          ),
          error === null ? null : React.createElement('p', { className: 'dssd-error', role: 'alert' }, error),
          React.createElement(
            'div',
            { className: 'dssd-footer' },
            React.createElement(
              'button',
              { type: 'button', className: 'dssd-btn', disabled: busy, onClick: settle },
              t('cancel'),
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                ref: confirmRef,
                className: request.mild ? 'dssd-btn' : 'dssd-btn dssd-danger',
                disabled: busy,
                onClick: run,
              },
              busy ? t(request.busyKey) : t(request.confirmKey),
            ),
          ),
        ),
      )
    }

    /**
     * Format a deletion time for the row meta line.
     * @param value - epoch milliseconds.
     * @returns a locale-formatted date-time, or an empty string.
     */
    function formatWhen(value) {
      if (typeof value !== 'number' || value <= 0) return ''
      try {
        return new Date(value).toLocaleString()
      } catch {
        return new Date(value).toISOString()
      }
    }

    /**
     * Format a byte count for the row meta line.
     * @param bytes - size in bytes.
     * @returns human-readable size, or an empty string.
     */
    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || bytes <= 0) return ''
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    }

    /**
     * The Trash page rendered in the main column.
     * @param props - the shared trash store and the confirmation opener.
     */
    function TrashPage({ useTrash, openConfirm, t }) {
      const state = useTrash((snapshot) => snapshot)
      const [busyId, setBusyId] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [error, setError] = React.useState(null)

      React.useEffect(() => {
        loadTrash()
      }, [])

      const entries = state.entries
      const count = entries.length

      const restore = async (entry) => {
        setBusyId(entry.sessionId)
        setError(null)
        setNotice(null)
        const outcome = await call('/trash/restore', { sessionId: entry.sessionId })
        setBusyId(null)
        if (outcome.ok === true) {
          setNotice(t('restored', { name: entry.title === '' ? t('untitled') : entry.title }))
          loadTrash()
          return
        }
        setError(t(typeof outcome.code === 'string' ? outcome.code : 'unknown'))
      }

      const purge = (entry) => {
        openConfirm({
          titleKey: 'purgeTitle',
          bodyKey: 'purgeBody',
          bodyParams: { name: entry.title === '' ? t('untitled') : entry.title },
          confirmKey: 'purgeConfirm',
          busyKey: 'purgeBusy',
          endpoint: '/trash/purge',
          payload: { sessionId: entry.sessionId },
          onDone: () => {
            setError(null)
            setNotice(null)
            loadTrash()
          },
        })
      }

      const empty = () => {
        openConfirm({
          titleKey: 'emptyTitle',
          bodyKey: 'emptyBody',
          bodyParams: { count },
          confirmKey: 'emptyConfirm',
          busyKey: 'emptyBusy',
          endpoint: '/trash/empty',
          payload: {},
          onDone: () => {
            setError(null)
            setNotice(null)
            loadTrash()
          },
        })
      }

      return React.createElement(
        'div',
        { className: 'dssd-page' },
        React.createElement(
          'div',
          { className: 'dssd-pageHead' },
          React.createElement(
            'div',
            null,
            React.createElement('h1', { className: 'dssd-pageTitle' }, t('trashTitle')),
            React.createElement('p', { className: 'dssd-pageSub' }, t('trashSubtitle')),
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'dssd-btn dssd-small dssd-danger',
              disabled: count === 0 || state.status === 'loading',
              onClick: empty,
            },
            t('emptyTrash'),
          ),
        ),
        React.createElement(
          'div',
          { className: 'dssd-pageBody' },
          notice === null ? null : React.createElement('p', { className: 'dssd-ok', role: 'status' }, notice),
          error === null ? null : React.createElement('p', { className: 'dssd-alert', role: 'alert' }, error),
          state.error === null || state.error === undefined
            ? null
            : React.createElement(
                'p',
                { className: 'dssd-alert', role: 'alert' },
                `${t(String(state.error))} `,
                React.createElement(
                  'button',
                  {
                    type: 'button',
                    className: 'dssd-btn dssd-small dssd-ghost',
                    onClick: () => loadTrash(),
                  },
                  t('retry'),
                ),
              ),
          state.status === 'loading'
            ? React.createElement('div', { className: 'dssd-empty' }, t('trashEmpty'))
            : count === 0
              ? React.createElement(
                  'div',
                  { className: 'dssd-empty' },
                  React.createElement(IconTrash, { size: 22 }),
                  React.createElement('span', null, t('trashEmpty')),
                )
              : React.createElement(
                  'div',
                  null,
                  React.createElement(
                    'p',
                    { className: 'dssd-note' },
                    count === 1 ? t('trashCountOne') : t('trashCount', { count }),
                  ),
                  entries.map((entry) => {
                    const name = entry.title === '' ? t('untitled') : entry.title
                    const metaParts = []
                    if (entry.deletedAt > 0) metaParts.push(t('deletedAt', { when: formatWhen(entry.deletedAt) }))
                    const size = formatBytes(entry.bytes)
                    if (size !== '') metaParts.push(size)
                    return React.createElement(
                      'div',
                      { className: 'dssd-row', key: entry.sessionId },
                      React.createElement(
                        'div',
                        { className: 'dssd-rowMain' },
                        React.createElement('div', { className: 'dssd-rowTitle', title: name }, name),
                        metaParts.length === 0
                          ? null
                          : React.createElement('div', { className: 'dssd-rowMeta' }, metaParts.join(' · ')),
                      ),
                      React.createElement(
                        'div',
                        { className: 'dssd-rowActions' },
                        React.createElement(
                          'button',
                          {
                            type: 'button',
                            className: 'dssd-btn dssd-small dssd-ghost',
                            disabled: busyId === entry.sessionId,
                            onClick: () => restore(entry),
                          },
                          React.createElement('span', { className: 'dssd-icon' }, React.createElement(IconRestore, null)),
                          React.createElement('span', null, busyId === entry.sessionId ? t('restoreBusy') : t('restore')),
                        ),
                        React.createElement(
                          'button',
                          {
                            type: 'button',
                            className: 'dssd-btn dssd-small dssd-dangerText',
                            disabled: busyId === entry.sessionId,
                            onClick: () => purge(entry),
                          },
                          React.createElement('span', { className: 'dssd-icon' }, React.createElement(IconTrash, null)),
                          React.createElement('span', null, t('purge')),
                        ),
                      ),
                    )
                  }),
                ),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const t = createTranslator(ctx)

        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-plugin', 'dsh-sidebar-session-delete')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, `${NS} styles`)

        /* One pending confirmation at a time, raised by any surface. */
        let pending = null
        const dialogListeners = new Set()
        const dialogRequest = {
          getSnapshot: () => pending,
          subscribe: (listener) => {
            dialogListeners.add(listener)
            return () => dialogListeners.delete(listener)
          },
        }
        const publishDialog = () => {
          for (const listener of [...dialogListeners]) listener()
        }
        const openConfirm = (request) => {
          pending = request
          publishDialog()
        }
        const settleDialog = () => {
          pending = null
          publishDialog()
        }

        /* The row command, placed after the shipped archive row (400) and before
         * the Session-id row (450). */
        ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
          ctx.slots.register(
            {
              name: 'sidebar.workspaces.session.menu.item',
              id: `${NS}.delete`,
              order: 420,
              label: () => t('delete'),
              inject: () => ({ t }),
            },
            function DeleteSessionMenuItem(props) {
              const { sessionId, displayTitle, useMenuOpenState, t: tr } = props
              const [, setMenuOpen] = useMenuOpenState()
              return React.createElement(
                'div',
                { className: 'dssd-wrap' },
                React.createElement(
                  'button',
                  {
                    type: 'button',
                    role: 'menuitem',
                    className: 'dssd-item',
                    onClick: () => {
                      setMenuOpen(false)
                      openConfirm({
                        titleKey: 'title',
                        bodyKey: 'body',
                        bodyParams: { name: displayTitle === '' ? tr('untitled') : displayTitle },
                        confirmKey: 'confirm',
                        busyKey: 'busy',
                        mild: true,
                        endpoint: '/trash',
                        payload: { sessionId, displayTitle: displayTitle ?? '' },
                        onDone: () => loadTrash(),
                      })
                    },
                  },
                  React.createElement('span', { className: 'dssd-icon' }, React.createElement(IconTrash, null)),
                  React.createElement('span', { className: 'dssd-label' }, tr('delete')),
                ),
              )
            },
          ),
        )

        /* The confirmation lives in the frame-wide overlay so the sidebar's
         * scroll container cannot clip it. */
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: `${NS}.confirm`,
              order: 20,
              label: () => t('title'),
              inject: () => ({ hooks: { dialogRequest }, t }),
            },
            function DeleteSessionConfirm(props) {
              const current = props.useDialogRequest((value) => value)
              if (current === null || current === undefined) return null
              return React.createElement(ConfirmDialog, {
                request: current,
                settle: settleDialog,
                t: props.t,
              })
            },
          ),
        )

        /* The panel icon; its id is the main-panel key selected on click. */
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 30,
              label: () => t('panel'),
            },
            function TrashPanelIcon(props) {
              return React.createElement(IconTrash, { size: props.size ?? 16 })
            },
          ),
        )

        /* The Trash page itself. */
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
              inject: () => ({ hooks: { trash: trashStore }, openConfirm, t }),
            },
            function TrashPanel(props) {
              return React.createElement(TrashPage, {
                useTrash: props.useTrash,
                openConfirm: props.openConfirm,
                t: props.t,
              })
            },
          ),
        )
      },
    }
  },
})
