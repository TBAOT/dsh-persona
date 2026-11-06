window.__ModuleLoader__.load({
  id: 'dsh-persona',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    const API = '/dsh-persona/api'

    const T = {
      panel: '角色',
      untitled: '未命名角色',
      subtitle: '每个角色一份记忆，按工作区自动认领。',
      tabMemory: '角色记忆',
      tabUser: '用户画像',
      tabReview: '复盘记录',
      tabProjects: '工作区',
      rename: '改名',
      remove: '删除',
      newPersona: '新建',
      nameHint: '角色名',
      pathHint: '工作区绝对路径',
      bind: '绑定',
      unbind: '解绑',
      revert: '撤销',
      save: '保存',
      saved: '已保存',
      dirty: '未保存',
      chars: '字符',
      remaining: '剩余',
      loading: '读取中…',
      noPersonas: '还没有角色。在左侧输入名字新建一个。',
      noReview: '还没有复盘记录。聊一轮就会产生。',
      noWorkspace: '还没有绑定工作区。',
      confirmDelete: '删除这个角色？记忆文件会留在磁盘上。',
      statusWritten: '已写入',
      statusPartial: '部分写入',
      statusRejected: '全部被拒',
      statusNoChange: '无改动',
      statusSkipped: '跳过',
      statusFailed: '失败',
      statusDryRun: '试运行',
      statusOk: '完成',
      noteNoOps: '模型判断本轮没有值得记的内容',
      noteNoUser: '本轮没有可复盘的对话',
      noteNoModel: '未配置复盘模型，已跳过',
      noteParse: '模型输出不是合法 JSON，已丢弃',
    }

    async function api(pathname, init) {
      const response = await fetch(API + pathname, {
        ...init,
        headers: { 'x-dsh-persona': '1', 'content-type': 'application/json', ...(init && init.headers) },
      })
      let body = null
      try {
        body = await response.json()
      } catch {
        body = null
      }
      if (!response.ok) throw new Error((body && body.error) || `HTTP ${response.status}`)
      return body
    }

    function localTime(value) {
      if (!value) return ''
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(value)
      const pad = (n) => String(n).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function statusOf(record) {
      if (record && record.status) return record.status
      if (record && record.reason === 'no-model') return 'skipped'
      if (record && (record.reason === 'parse-failed' || record.reason === 'error')) return 'failed'
      if (record && record.note === 'no-user-message') return 'skipped'
      if (record && record.note === 'no-ops') return 'no-change'
      if (record && record.dryRun) return 'dry-run'
      const applied = record && Array.isArray(record.applied) ? record.applied.length : 0
      const rejected = record && Array.isArray(record.rejected) ? record.rejected.length : 0
      if (applied && rejected) return 'partial'
      if (applied) return 'written'
      if (rejected) return 'rejected'
      return 'ok'
    }

    function statusLabel(record) {
      switch (statusOf(record)) {
        case 'written':
          return T.statusWritten
        case 'partial':
          return T.statusPartial
        case 'rejected':
          return T.statusRejected
        case 'no-change':
          return T.statusNoChange
        case 'skipped':
          return T.statusSkipped
        case 'failed':
          return T.statusFailed
        case 'dry-run':
          return T.statusDryRun
        default:
          return T.statusOk
      }
    }

    function statusTone(record) {
      switch (statusOf(record)) {
        case 'written':
          return 'ok'
        case 'partial':
          return 'warn'
        case 'rejected':
          return 'bad'
        case 'failed':
          return 'bad'
        case 'dry-run':
          return 'warn'
        default:
          return 'quiet'
      }
    }

    /** One-line description of a memory operation, for the collapsed ledger row. */
    function opText(op) {
      const target = op && op.target === 'user' ? T.tabUser : T.tabMemory
      const verb = op && op.action === 'add' ? '新增' : op && op.action === 'patch' ? '修改' : '删除'
      const value = String((op && (op.action === 'remove' ? op.old_text : op.content)) ?? '').replace(/\s+/g, ' ')
      const short = value.length > 48 ? `${value.slice(0, 48)}…` : value
      return `${verb}${target}：${short}`
    }

    function Icon(props) {
      const size = (props && props.size) || 20
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: {
            display: 'block',
            color: props && props.active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
          },
        },
        h('path', { d: 'M7 4.5h10a2 2 0 0 1 2 2v13l-7-4.2-7 4.2v-13a2 2 0 0 1 2-2Z' }),
      )
    }

    /** The one loud element: a real ruler for a hard character budget. */
    function Gauge(props) {
      const used = props.used
      const limit = props.limit
      const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0
      const danger = percent >= 90
      const ticks = [0, 25, 50, 75, 100]
      return h(
        'div',
        { className: 'dp-gauge', 'data-danger': danger ? '1' : '0' },
        h(
          'div',
          { className: 'dp-gauge-track', role: 'img', 'aria-label': `记忆容量 ${percent}%` },
          h('div', { className: 'dp-gauge-fill', style: { width: `${percent}%` } }),
          ticks.map((tick) =>
            h('span', { key: tick, className: 'dp-gauge-tick', style: { left: `${tick}%` }, 'data-edge': tick === 0 || tick === 100 ? '1' : '0' }),
          ),
        ),
        h(
          'span',
          { className: 'dp-gauge-readout' },
          `${used} / ${limit} ${T.chars}　${percent}%`,
        ),
      )
    }

    function Panel() {
      const [state, setState] = useState(null)
      const [selected, setSelected] = useState(null)
      const [tab, setTab] = useState('memory')
      const [user, setUser] = useState({ text: '', loaded: '', usage: null, file: '' })
      const [notes, setNotes] = useState({ text: '', loaded: '', usage: null, file: '' })
      const [review, setReview] = useState([])
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const [draftName, setDraftName] = useState('')
      const [draftPath, setDraftPath] = useState('')
      const [renaming, setRenaming] = useState(false)
      const [limitDraft, setLimitDraft] = useState('')
      const [filter, setFilter] = useState('all')
      const [expanded, setExpanded] = useState({})

      const personas = state?.personas ?? []
      const current = personas.find((entry) => entry.id === selected)
      const activeDraft = tab === 'user' ? user : notes
      const editing = tab === 'memory' || tab === 'user'
      const dirty = editing && activeDraft.text !== activeDraft.loaded

      const refresh = useCallback(
        async (keep) => {
          const next = await api('/list')
          setState(next)
          const wanted = keep ?? selected
          if (!next.personas.length) setSelected(null)
          else if (!next.personas.some((entry) => entry.id === wanted)) setSelected(next.personas[0].id)
          return next
        },
        [selected],
      )

      const loadMemory = useCallback(async (id) => {
        const [u, m] = await Promise.all([
          api(`/memory?id=${encodeURIComponent(id)}&target=user`),
          api(`/memory?id=${encodeURIComponent(id)}&target=memory`),
        ])
        setUser({ text: u.content, loaded: u.content, usage: u.usage, file: u.file ?? '' })
        setNotes({ text: m.content, loaded: m.content, usage: m.usage, file: m.file ?? '' })
      }, [])

      const loadReview = useCallback(async (id) => {
        const data = await api(`/review?id=${encodeURIComponent(id)}&limit=40`)
        setReview(data.records ?? [])
      }, [])

      /** Keep the editable limit in step with whichever tier is on screen. */
      useEffect(() => {
        const usage = (tab === 'user' ? user : notes).usage
        setLimitDraft(usage ? String(usage.limit) : '')
      }, [tab, user.usage, notes.usage])

      const applyLimit = useCallback(async () => {
        if (!selected) return
        const target = tab === 'user' ? 'user' : 'memory'
        const value = Number(limitDraft)
        if (!Number.isFinite(value)) {
          setError('上限需要是数字')
          return
        }
        setBusy(true)
        try {
          setError('')
          await api('/limits', { method: 'POST', body: JSON.stringify({ id: selected, target, limit: value }) })
          await loadMemory(selected)
        } catch (problem) {
          setError(problem.message)
        } finally {
          setBusy(false)
        }
      }, [selected, tab, limitDraft, loadMemory])

      useEffect(() => {
        let alive = true
        ;(async () => {
          try {
            const next = await api('/list')
            if (!alive) return
            setState(next)
            const first = next.personas[0]?.id ?? null
            setSelected(first)
            if (first) await loadMemory(first)
          } catch (problem) {
            if (alive) setError(problem.message)
          }
        })()
        return () => {
          alive = false
        }
      }, [loadMemory])

      useEffect(() => {
        if (!selected) return
        let alive = true
        ;(async () => {
          try {
            setError('')
            if (tab === 'memory' || tab === 'user') await loadMemory(selected)
            if (tab === 'review') await loadReview(selected)
          } catch (problem) {
            if (alive) setError(problem.message)
          }
        })()
        return () => {
          alive = false
        }
      }, [selected, tab, loadMemory, loadReview])

      const save = useCallback(async () => {
        const target = tab === 'user' ? 'user' : 'memory'
        const draft = target === 'user' ? user : notes
        if (!selected || draft.text === draft.loaded) return
        setBusy(true)
        try {
          setError('')
          const result = await api('/memory', {
            method: 'POST',
            body: JSON.stringify({ id: selected, target, content: draft.text }),
          })
          const next = { ...draft, loaded: draft.text, usage: result.usage, file: result.file ?? draft.file }
          if (target === 'user') setUser(next)
          else setNotes(next)
          await refresh(selected)
        } catch (problem) {
          setError(problem.message)
        } finally {
          setBusy(false)
        }
      }, [tab, user, notes, selected, refresh])

      const revert = useCallback(() => {
        if (tab === 'user') setUser({ ...user, text: user.loaded })
        else setNotes({ ...notes, text: notes.loaded })
      }, [tab, user, notes])

      const create = useCallback(async () => {
        const name = draftName.trim()
        if (!name) {
          setError('先输入角色名')
          return
        }
        setBusy(true)
        try {
          setError('')
          const result = await api('/create', { method: 'POST', body: JSON.stringify({ name }) })
          setDraftName('')
          await refresh(result.persona.id)
          setSelected(result.persona.id)
          setTab('memory')
        } catch (problem) {
          setError(problem.message)
        } finally {
          setBusy(false)
        }
      }, [draftName, refresh])

      const saveRename = useCallback(async () => {
        const name = draftName.trim()
        if (!name || !selected) return
        setBusy(true)
        try {
          setError('')
          await api('/update', { method: 'POST', body: JSON.stringify({ id: selected, name }) })
          setRenaming(false)
          setDraftName('')
          await refresh(selected)
        } catch (problem) {
          setError(problem.message)
        } finally {
          setBusy(false)
        }
      }, [draftName, selected, refresh])

      const remove = useCallback(async () => {
        if (!window.confirm(T.confirmDelete)) return
        setBusy(true)
        try {
          await api('/delete', { method: 'POST', body: JSON.stringify({ id: selected }) })
          setSelected(null)
          await refresh(null)
        } catch (problem) {
          setError(problem.message)
        } finally {
          setBusy(false)
        }
      }, [selected, refresh])

      const bind = useCallback(async () => {
        const workspace = draftPath.trim()
        if (!workspace) {
          setError('先输入工作区绝对路径')
          return
        }
        setBusy(true)
        try {
          setError('')
          await api('/bind', { method: 'POST', body: JSON.stringify({ id: selected, workspace }) })
          setDraftPath('')
          await refresh(selected)
        } catch (problem) {
          setError(problem.message)
        } finally {
          setBusy(false)
        }
      }, [draftPath, selected, refresh])

      const unbind = useCallback(
        async (workspace) => {
          setBusy(true)
          try {
            await api('/unbind', { method: 'POST', body: JSON.stringify({ id: selected, workspace }) })
            await refresh(selected)
          } catch (problem) {
            setError(problem.message)
          } finally {
            setBusy(false)
          }
        },
        [selected, refresh],
      )

      const slotNumber = (persona) => {
        const match = String(persona.id).match(/(\d+)$/)
        return match ? String(Number(match[1])).padStart(2, '0') : '--'
      }

      const header = h(
        'header',
        { className: 'dp-head' },
        h(
          'div',
          { className: 'dp-head-text' },
          renaming
            ? h(
                'div',
                { className: 'dp-rename' },
                h('input', {
                  className: 'dp-field',
                  value: draftName,
                  placeholder: T.nameHint,
                  autoFocus: true,
                  onChange: (event) => setDraftName(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') saveRename()
                    if (event.key === 'Escape') setRenaming(false)
                  },
                }),
                h('button', { className: 'dp-btn', 'data-tone': 'primary', onClick: saveRename, disabled: busy }, T.save),
                h('button', { className: 'dp-btn', onClick: () => setRenaming(false) }, '取消'),
              )
            : h('h1', { className: 'dp-title' }, current ? current.name : T.untitled),
          h('p', { className: 'dp-sub' }, T.subtitle),
        ),
        h(
          'div',
          { className: 'dp-head-actions' },
          current
            ? h(
                'button',
                {
                  className: 'dp-btn',
                  onClick: () => {
                    setDraftName(current.name)
                    setRenaming(true)
                  },
                  disabled: busy,
                },
                T.rename,
              )
            : null,
          current ? h('button', { className: 'dp-btn', 'data-tone': 'danger', onClick: remove, disabled: busy }, T.remove) : null,
        ),
      )

      const tabs = h(
        'nav',
        { className: 'dp-tabs' },
        [
          ['memory', T.tabMemory],
          ['user', T.tabUser],
          ['review', T.tabReview],
          ['projects', T.tabProjects],
        ].map(([key, label]) =>
          h(
            'button',
            {
              key,
              type: 'button',
              className: 'dp-tab',
              'data-active': tab === key ? '1' : '0',
              'aria-current': tab === key ? 'page' : undefined,
              onClick: () => setTab(key),
            },
            label,
          ),
        ),
        h('span', { className: 'dp-grow' }),
        editing
          ? h(
              React.Fragment,
              null,
              h('button', { className: 'dp-btn', onClick: revert, disabled: busy || !dirty }, T.revert),
              h('button', { className: 'dp-btn', 'data-tone': 'primary', onClick: save, disabled: busy || !dirty }, T.save),
            )
          : null,
      )

      const spine = h(
        'aside',
        { className: 'dp-spine' },
        h(
          'ol',
          { className: 'dp-index' },
          personas.map((persona) =>
            h(
              'li',
              { key: persona.id },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dp-index-item',
                  'data-active': persona.id === selected ? '1' : '0',
                  onClick: () => setSelected(persona.id),
                },
                h('span', { className: 'dp-index-no' }, slotNumber(persona)),
                h('span', { className: 'dp-index-body' }, h('span', { className: 'dp-index-name' }, persona.name), h('span', { className: 'dp-index-meta' }, `${persona.workspaces.length} 个工作区`)),
              ),
            ),
          ),
        ),
        h(
          'div',
          { className: 'dp-new' },
          h('input', {
            className: 'dp-field',
            value: draftName,
            placeholder: T.nameHint,
            onChange: (event) => setDraftName(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') create()
            },
          }),
          h('button', { className: 'dp-btn', onClick: create, disabled: busy }, T.newPersona),
        ),
      )

      let body
      if (!personas.length) {
        body = h('div', { className: 'dp-empty' }, state ? T.noPersonas : T.loading)
      } else if (editing) {
        const draft = tab === 'user' ? user : notes
        body = h('textarea', {
          className: 'dp-manuscript',
          value: draft.text,
          spellCheck: false,
          'aria-label': tab === 'user' ? T.tabUser : T.tabMemory,
          onChange: (event) => {
            const next = { ...draft, text: event.target.value }
            if (tab === 'user') setUser(next)
            else setNotes(next)
          },
        })
      } else if (tab === 'review') {
        const rows = review
          .slice()
          .reverse()
          .filter((record) => filter === 'all' || statusOf(record) === filter)

        body = h(
          'div',
          { className: 'dp-review' },
          h(
            'div',
            { className: 'dp-filters', role: 'tablist', 'aria-label': '按结果筛选' },
            [
              ['all', '全部'],
              ['written', '已写入'],
              ['partial', '部分写入'],
              ['rejected', '被拒'],
              ['no-change', '无改动'],
              ['skipped', '跳过'],
              ['failed', '失败'],
            ].map(([key, label]) =>
              h(
                'button',
                {
                  key,
                  type: 'button',
                  className: 'dp-filter',
                  'data-active': filter === key ? '1' : '0',
                  onClick: () => setFilter(key),
                },
                label,
              ),
            ),
            h('span', { className: 'dp-grow' }),
            h('span', { className: 'dp-filter-count' }, `共 ${review.length} 条`),
          ),
          h(
            'div',
            { className: 'dp-ledger' },
            rows.length
              ? rows.map((record, index) => {
                  const key = `${record.at ?? index}`
                  const open = expanded[key] === true
                  const ops = Array.isArray(record.ops) ? record.ops : []
                  return h(
                    'article',
                    { className: 'dp-entry', key, 'data-open': open ? '1' : '0' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dp-entry-head',
                        'aria-expanded': open ? 'true' : 'false',
                        onClick: () => setExpanded({ ...expanded, [key]: !open }),
                      },
                      h('span', { className: 'dp-stamp', 'data-tone': statusTone(record) }, statusLabel(record)),
                      h('time', { className: 'dp-entry-time' }, localTime(record.at)),
                      record.ms ? h('span', { className: 'dp-entry-time' }, `${Math.round(record.ms / 100) / 10}s`) : null,
                      h('span', { className: 'dp-entry-summary' }, ops.length ? ops.map((op) => opText(op)).join('；') : record.note === 'no-ops' ? T.noteNoOps : record.note === 'no-user-message' ? T.noteNoUser : record.reason === 'no-model' ? T.noteNoModel : ''),
                      h('span', { className: 'dp-grow' }),
                      Array.isArray(record.applied) && record.applied.length
                        ? h('span', { className: 'dp-entry-meta' }, record.applied.map((entry) => `${entry.target} × ${entry.count}`).join('，'))
                        : null,
                      h('span', { className: 'dp-caret', 'data-open': open ? '1' : '0' }, '›'),
                    ),
                    open
                      ? h(
                          'div',
                          { className: 'dp-entry-body' },
                          ops.length
                            ? ops.map((op, opIndex) =>
                                h(
                                  'div',
                                  { className: 'dp-op', key: opIndex },
                                  h('span', { className: 'dp-op-sym', 'data-action': op.action }, op.action === 'add' ? '+' : op.action === 'patch' ? '~' : '−'),
                                  h('span', { className: 'dp-op-target' }, op.target === 'user' ? T.tabUser : T.tabMemory),
                                  h(
                                    'span',
                                    { className: 'dp-op-text' },
                                    op.action === 'remove' ? op.old_text ?? '' : op.content ?? '',
                                  ),
                                  h(
                                    'button',
                                    {
                                      type: 'button',
                                      className: 'dp-op-copy',
                                      onClick: () => {
                                        const text = op.action === 'remove' ? op.old_text ?? '' : op.content ?? ''
                                        if (navigator.clipboard) navigator.clipboard.writeText(text)
                                      },
                                    },
                                    '复制',
                                  ),
                                ),
                              )
                            : h('p', { className: 'dp-entry-note' }, '这一轮没有留下可查看的改动。'),
                          Array.isArray(record.rejected) && record.rejected.length
                            ? h('p', { className: 'dp-entry-note', 'data-tone': 'bad' }, record.rejected.map((entry) => `${entry.target}: ${entry.error}`).join('；'))
                            : null,
                          record.model ? h('p', { className: 'dp-entry-note' }, `模型 ${record.model.provider}/${record.model.model}`) : null,
                        )
                      : null,
                  )
                })
              : h('div', { className: 'dp-empty' }, T.noReview),
          ),
        )
      } else {
        body = h(
          'div',
          { className: 'dp-shelf' },
          h(
            'div',
            { className: 'dp-bind' },
            h('input', {
              className: 'dp-field',
              style: { flex: 1 },
              placeholder: T.pathHint,
              value: draftPath,
              onChange: (event) => setDraftPath(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') bind()
              },
            }),
            h('button', { className: 'dp-btn', 'data-tone': 'primary', onClick: bind, disabled: busy }, T.bind),
          ),
          current && current.workspaces.length
            ? h(
                'ul',
                { className: 'dp-paths' },
                current.workspaces.map((workspace) =>
                  h(
                    'li',
                    { key: workspace, className: 'dp-path' },
                    h('code', null, workspace),
                    h('span', { className: 'dp-grow' }),
                    h('button', { className: 'dp-btn', 'data-tone': 'danger', onClick: () => unbind(workspace), disabled: busy }, T.unbind),
                  ),
                ),
              )
            : h('div', { className: 'dp-empty' }, T.noWorkspace),
        )
      }

      const footer = h(
        'footer',
        { className: 'dp-foot' },
        editing
          ? h(
              React.Fragment,
              null,
              h(Gauge, { used: activeDraft.usage ? activeDraft.usage.used : 0, limit: activeDraft.usage ? activeDraft.usage.limit : 0 }),
              h(
                'label',
                { className: 'dp-limit' },
                '上限',
                h('input', {
                  className: 'dp-field dp-limit-field',
                  type: 'number',
                  min: 200,
                  max: 20000,
                  step: 100,
                  value: limitDraft,
                  disabled: busy,
                  onChange: (event) => setLimitDraft(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') applyLimit()
                  },
                }),
                h('button', { className: 'dp-btn', onClick: applyLimit, disabled: busy }, '应用'),
              ),
              h('span', { className: 'dp-foot-state', 'data-dirty': dirty ? '1' : '0' }, dirty ? T.dirty : T.saved),
              h('code', { className: 'dp-foot-path', title: activeDraft.file }, activeDraft.file || ''),
            )
          : h('span', { className: 'dp-foot-state' }, tab === 'review' ? `${review.length} 条记录` : `${current ? current.workspaces.length : 0} 个工作区`),
      )

      return h(
        React.Fragment,
        null,
        h('style', null, styles),
        h(
          'div',
          { className: 'dp-root' },
          header,
          tabs,
          error ? h('p', { className: 'dp-error', role: 'alert' }, error) : null,
          h('div', { className: 'dp-main' }, h('section', { className: 'dp-doc' }, body), spine),
          footer,
        ),
      )
    }

    const styles = [
      '.dp-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px}',
      '.dp-head{display:flex;align-items:flex-start;gap:16px;padding:22px 28px 12px}',
      '.dp-head-text{flex:1;min-width:0}',
      '.dp-title{margin:0;font-family:Georgia,"Source Han Serif SC","Songti SC",serif;font-size:21px;font-weight:600;line-height:1.25;letter-spacing:.01em}',
      '.dp-sub{margin:4px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dp-head-actions{display:flex;gap:8px;align-items:center}',
      '.dp-rename{display:flex;gap:8px;align-items:center}',
      '.dp-field{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:inherit;border-radius:4px;padding:5px 8px;font-size:12.5px;font-family:inherit;outline:none;min-width:0}',
      '.dp-field:focus-visible{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px var(--dsw-alias-bg-layer-2)}',
      '.dp-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);border-radius:4px;padding:5px 11px;font-size:12.5px;font-family:inherit;cursor:pointer;transition:background-color .12s ease,border-color .12s ease}',
      '.dp-btn:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}',
      '.dp-btn[data-tone="primary"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}',
      '.dp-btn[data-tone="danger"]{color:var(--dsw-alias-state-error-primary)}',
      '.dp-btn:disabled{opacity:.4;cursor:default}',
      '.dp-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dp-tabs{display:flex;align-items:center;gap:2px;padding:0 28px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.dp-tab{position:relative;border:0;background:none;color:var(--dsw-alias-label-secondary);padding:9px 14px 10px;font:inherit;cursor:pointer}',
      '.dp-tab:hover{color:var(--dsw-alias-label-primary)}',
      '.dp-tab[data-active="1"]{color:var(--dsw-alias-label-primary)}',
      '.dp-tab[data-active="1"]::after{content:"";position:absolute;left:12px;right:12px;bottom:-1px;height:2px;background:var(--dsw-alias-brand-primary)}',
      '.dp-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
      '.dp-grow{flex:1}',
      '.dp-main{display:flex;flex:1;min-height:0}',
      '.dp-spine{width:212px;flex:0 0 212px;display:flex;flex-direction:column;min-height:0;border-left:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
      '.dp-index{list-style:none;margin:0;padding:10px 0;overflow:auto;flex:1;min-height:0}',
      '.dp-index-item{display:flex;gap:10px;width:100%;text-align:left;padding:9px 13px 9px 16px;border:0;border-right:3px solid transparent;background:none;color:inherit;font:inherit;cursor:pointer}',
      '.dp-index-item:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dp-index-item[data-active="1"]{border-right-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}',
      '.dp-index-item:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
      '.dp-index-no{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary);min-width:16px}',
      '.dp-index-body{min-width:0;display:flex;flex-direction:column;gap:1px}',
      '.dp-index-name{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dp-index-meta{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dp-new{display:flex;gap:6px;padding:10px 12px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.dp-new .dp-field{flex:1}',
      '.dp-doc{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;padding:22px 48px 16px}',
      '.dp-manuscript{flex:1;min-height:0;width:100%;max-width:none;resize:none;border:0;background:transparent;color:var(--dsw-alias-label-primary);padding:0;outline:none;font-family:Georgia,"Source Han Serif SC","Songti SC",serif;font-size:14px;line-height:1.9}',
      '.dp-manuscript:focus-visible{outline:none}',
      '.dp-ledger{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;max-width:none}',
      '.dp-entry{padding:0;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.dp-entry:first-child{border-top:1px solid var(--dsw-alias-border-l1)}',
      '.dp-entry-head{display:flex;align-items:baseline;gap:10px;width:100%;text-align:left;border:0;background:none;color:inherit;font:inherit;cursor:pointer;padding:11px 0}',
      '.dp-entry-head:hover .dp-entry-summary{color:var(--dsw-alias-label-primary)}',
      '.dp-entry-summary{font-size:12px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:56ch}',
      '.dp-caret{color:var(--dsw-alias-label-secondary);transition:transform .12s ease;display:inline-block}',
      '.dp-caret[data-open="1"]{transform:rotate(90deg)}',
      '.dp-entry-body{display:flex;flex-direction:column;gap:2px;padding:4px 0 12px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.dp-op{display:flex;align-items:flex-start;gap:8px;font-size:12px;padding:5px 0}',
      '.dp-op-sym{width:12px;text-align:center;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-state-success-primary)}',
      '.dp-op-sym[data-action="patch"]{color:var(--dsw-alias-state-warn-primary)}',
      '.dp-op-sym[data-action="remove"]{color:var(--dsw-alias-state-error-primary)}',
      '.dp-op-target{min-width:60px;color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:18px}',
      '.dp-op-text{flex:1;white-space:pre-wrap;line-height:1.55;word-break:break-word}',
      '.dp-op-copy{border:1px solid var(--dsw-alias-border-l1);background:none;color:var(--dsw-alias-label-secondary);border-radius:3px;font-size:11px;padding:1px 6px;cursor:pointer}',
      '.dp-op-copy:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}',
      '.dp-review{flex:1;min-height:0;display:flex;flex-direction:column}',
      '.dp-filters{display:flex;align-items:center;gap:4px;padding-bottom:8px}',
      '.dp-filter{border:1px solid transparent;background:none;color:var(--dsw-alias-label-secondary);padding:3px 9px;border-radius:3px;font:inherit;font-size:11.5px;cursor:pointer}',
      '.dp-filter:hover{color:var(--dsw-alias-label-primary)}',
      '.dp-filter[data-active="1"]{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
      '.dp-filter-count{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dp-stamp{font-size:11.5px;padding:1px 7px;border:1px solid currentColor;border-radius:3px;letter-spacing:.02em}',
      '.dp-stamp[data-tone="ok"]{color:var(--dsw-alias-state-success-primary)}',
      '.dp-stamp[data-tone="bad"]{color:var(--dsw-alias-state-error-primary)}',
      '.dp-stamp[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary)}',
      '.dp-stamp[data-tone="quiet"]{color:var(--dsw-alias-label-secondary)}',
      '.dp-entry-time{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.dp-entry-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.dp-entry-note{margin:6px 0 0;font-size:12.5px;color:var(--dsw-alias-label-secondary)}',
      '.dp-entry-note[data-tone="bad"]{color:var(--dsw-alias-state-error-primary)}',
      '.dp-shelf{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:10px;max-width:none}',
      '.dp-bind{display:flex;gap:8px}',
      '.dp-paths{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}',
      '.dp-path{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:4px}',
      '.dp-path code{font-size:12px;color:var(--dsw-alias-label-primary)}',
      '.dp-empty{flex:1;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);font-size:12.5px;text-align:center;padding:28px}',
      '.dp-error{margin:0;padding:8px 28px 0;color:var(--dsw-alias-state-error-primary);font-size:12.5px}',
      '.dp-foot{display:flex;align-items:center;gap:14px;padding:10px 28px 14px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.dp-gauge{display:flex;align-items:center;gap:12px;flex:1;min-width:0}',
      '.dp-gauge-track{position:relative;flex:1;height:10px;min-width:120px;border:1px solid var(--dsw-alias-border-l2);border-radius:2px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}',
      '.dp-gauge-fill{position:absolute;left:0;top:0;bottom:0;background:var(--dsw-alias-brand-primary);transition:width .18s ease}',
      '.dp-gauge[data-danger="1"] .dp-gauge-fill{background:var(--dsw-alias-state-error-primary)}',
      '.dp-gauge-tick{position:absolute;top:0;bottom:0;width:1px;background:var(--dsw-alias-border-l2);opacity:.7}',
      '.dp-gauge-tick[data-edge="1"]{opacity:0}',
      '.dp-gauge-readout{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.dp-gauge[data-danger="1"] .dp-gauge-readout{color:var(--dsw-alias-state-error-primary)}',
      '.dp-foot-state{font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.dp-foot-state[data-dirty="1"]{color:var(--dsw-alias-state-warn-primary)}',
      '.dp-foot-path{font-size:11px;color:var(--dsw-alias-label-secondary);max-width:40ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dp-limit{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.dp-limit-field{width:84px;padding:3px 6px;font-size:11.5px}',
      '@media (max-width:720px){.dp-spine{width:132px;flex-basis:132px}.dp-head,.dp-tabs,.dp-doc,.dp-foot{padding-left:16px;padding-right:16px}.dp-index-meta{display:none}}',
      '@media (prefers-reduced-motion:reduce){.dp-btn,.dp-tab,.dp-gauge-fill{transition:none}}',
    ].join('\n')

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: 'personas', order: 40, label: T.panel }, Icon),
        )
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'personas' }, Panel))
      },
    }
  },
})
