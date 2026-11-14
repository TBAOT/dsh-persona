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
      tabSkills: '技能',
      tabProjects: '工作区',
      rename: '改名',
      remove: '删除',
      newPersona: '新建',
      nameHint: '角色名',
      pathHint: '工作区绝对路径，例如 C:\\A\\work\\proj\\packages\\ui',
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

    /** Turn-number → review record, so scrolling the transcript does not refetch. */
    const noteCache = new Map()

    function turnIndexOf(turn) {
      if (!turn || typeof turn !== 'object') return undefined
      for (const value of [turn.index, turn.turn, turn.number, turn.id]) {
        if (typeof value === 'number' && Number.isFinite(value)) return value
      }
      return undefined
    }

    function noteKeyOf(props) {
      const sessionId = props && props.sessionId
      if (!sessionId) return ''
      const turn = turnIndexOf(props && props.turn)
      const seq = props && props.seq
      const anchor = typeof turn === 'number' ? `t${turn}` : typeof seq === 'number' ? `s${seq}` : ''
      return anchor ? `${sessionId}:${anchor}` : ''
    }

    /**
     * The turn-tail note lives in the conversation, not in this panel, so its
     * styles cannot come from the panel's own <style> tag (that only exists
     * once someone opens the sidebar). Inject one head-level rule set at module
     * load, sized to sit beside the shipped "已完成，用时 …" status line.
     */
    const NOTE_CSS = [
    ].join('\n')

    function ensureNoteStyles() {
      if (typeof document === 'undefined' || !document.head) return
      if (document.getElementById('dsh-persona-note-styles')) return
      const tag = document.createElement('style')
      tag.id = 'dsh-persona-note-styles'
      tag.textContent = NOTE_CSS
      document.head.appendChild(tag)
    }

    /**
     * One quiet line under a finished turn: what the automatic review just filed.
     * Nothing is shown for turns that wrote nothing — a footnote, not a badge.
     */
    function MemoryNote(props) {
      const [record, setRecord] = useState(() => noteCache.get(noteKeyOf(props)) ?? null)
      const sessionId = props && props.sessionId
      const turnNumber = turnIndexOf(props && props.turn)
      const seq = props && props.seq
      const key = noteKeyOf(props)

      useEffect(() => {
        if (!sessionId || !key) return undefined
        const cached = noteCache.get(key)
        if (cached !== undefined) {
          setRecord(cached)
          return undefined
        }
        const query = new URLSearchParams({ session: String(sessionId) })
        if (typeof turnNumber === 'number') query.set('turn', String(turnNumber))
        if (typeof seq === 'number') query.set('after', String(seq))

        let alive = true
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
        ;(async () => {
          // The review runs after the turn closes and talks to a model, so poll for a while.
          const delays = [4000, 8000, 12000, 20000, 30000, 30000, 30000]
          for (let attempt = 0; attempt <= delays.length; attempt += 1) {
            if (!alive) return
            try {
              const response = await fetch(`${API}/turn?${query.toString()}`, { headers: { 'x-dsh-persona': '1' } })
              const body = await response.json()
              const value = (body && body.turn) || null
              if (value) {
                noteCache.set(key, value)
                if (alive) setRecord(value)
                return
              }
            } catch {
              /* stay silent and retry */
            }
            if (attempt === delays.length) break
            await wait(delays[attempt])
          }
          if (alive) noteCache.set(key, null)
        })()
        return () => {
          alive = false
        }
      }, [sessionId, key, turnNumber, seq])

      if (!record) return null
      const applied = Array.isArray(record.applied) ? record.applied : []
      const rejected = Array.isArray(record.rejected) ? record.rejected : []
      const count = applied.reduce((sum, item) => sum + (Number(item && item.count) || 0), 0)
      const when = record.at ? `复盘于 ${record.at}` : undefined

      if (record.status === 'written' && count > 0) {
        const parts = applied
          .filter((item) => Number(item && item.count) > 0)
          .map((item) => `${item.target === 'user' ? '画像' : '笔记'} ${item.count}`)
        const detail = parts.length > 1 ? `（${parts.join('、')}）` : ''
        return h(
          'p',
          { className: 'dp-note', title: when },
          h('span', { className: 'dp-note-mark', 'aria-hidden': true }, '—'),
          h('span', null, `记下 ${count} 条记忆`, detail),
        )
      }

      if (record.status === 'partial' || record.status === 'rejected') {
        const reason = rejected[0] && rejected[0].error ? String(rejected[0].error) : '超出上限'
        return h(
          'p',
          { className: 'dp-note', 'data-tone': 'warn', title: reason },
          h('span', { className: 'dp-note-mark', 'aria-hidden': true }, '—'),
          h('span', null, `${rejected.length} 条写入被拒`),
        )
      }

      return null
    }

    /**
     * The 角色 View: the same dossier, opened on the persona this conversation
     * actually belongs to. The binding line answers "why this persona" with the
     * workspace path, so nobody has to go hunting in the sidebar.
     */
    function PersonaView(props) {
      const sessionId = props && props.sessionId
      const [binding, setBinding] = useState({ personaId: null, cwd: '', tail: '' })

      useEffect(() => {
        if (!sessionId) return undefined
        let alive = true
        ;(async () => {
          try {
            const data = await api(`/resolve?session=${encodeURIComponent(sessionId)}`)
            if (!alive) return
            const cwd = data.cwd || ''
            setBinding({
              personaId: data.persona ? data.persona.id : null,
              cwd,
              tail: cwd ? cwd.split(/[\\/]/).filter(Boolean).slice(-1)[0] || cwd : '',
            })
          } catch {
            if (alive) setBinding({ personaId: null, cwd: '', tail: '' })
          }
        })()
        return () => {
          alive = false
        }
      }, [sessionId])

      const line = binding.cwd
        ? `会话工作区 ${binding.cwd}`
        : binding.personaId === null
          ? '这个会话的工作区没有绑定角色，记忆落在未认领池'
          : ''
      return h(Panel, { personaId: binding.personaId, binding: line })
    }

    function Panel(props) {
      const presetId = (props && props.personaId) || null
      const binding = (props && props.binding) || ''
      const [state, setState] = useState(null)
      const [selected, setSelected] = useState(null)
      const [tab, setTab] = useState('memory')
      const [user, setUser] = useState({ text: '', loaded: '', usage: null, file: '' })
      const [notes, setNotes] = useState({ text: '', loaded: '', usage: null, file: '' })
      const [topicCount, setTopicCount] = useState(0)
      const [topics, setTopics] = useState([])
      const [topicsOpen, setTopicsOpen] = useState(false)
      const [topicView, setTopicView] = useState(null)
      const [history, setHistory] = useState([])
      const [historyOpen, setHistoryOpen] = useState(false)
      const [historyView, setHistoryView] = useState(null)
      const [archiving, setArchiving] = useState(null)
      const [review, setReview] = useState([])
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState(false)
      const [draftName, setDraftName] = useState('')
      const [draftPath, setDraftPath] = useState('')
      const [picks, setPicks] = useState([])
      const [pickSource, setPickSource] = useState('none')
      const [pickId, setPickId] = useState('')
      const [pool, setPool] = useState(null)
      const [skills, setSkills] = useState([])
      const [moveTarget, setMoveTarget] = useState({})
      const [poolDraft, setPoolDraft] = useState(null)
      const [manual, setManual] = useState(false)
      const [renaming, setRenaming] = useState(false)
      const [limitDraft, setLimitDraft] = useState('')
      const [filter, setFilter] = useState('all')
      const [expanded, setExpanded] = useState({})

      const personas = state?.personas ?? []
      const current = personas.find((entry) => entry.id === selected)
      const activeDraft = tab === 'user' ? user : notes
      const editing = tab === 'memory' || tab === 'user'
      const dirty = editing && activeDraft.text !== activeDraft.loaded
      /** Resident entries (the two markdown files), for the footer readout. */
      const residentCount = notes.text ? notes.text.split(/\n\s*§\s*\n/).filter((entry) => entry.trim()).length : 0
      /** Past 90% of a tier's budget the writer refuses new entries. */
      const nearFull = Boolean(notes.usage && notes.usage.limit > 0 && notes.usage.used >= notes.usage.limit * 0.9)

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
        try {
          const list = await api(`/topics?id=${encodeURIComponent(id)}`)
          setTopics(Array.isArray(list.topics) ? list.topics : [])
          setTopicCount(Array.isArray(list.topics) ? list.topics.length : 0)
          const past = await api(`/memory/history?id=${encodeURIComponent(id)}`)
          setHistory(Array.isArray(past.entries) ? past.entries : [])
        } catch {
          setTopicCount(0)
        }
      }, [])

      /** A preset persona (the 角色 View) wins over the default first-persona pick. */
      useEffect(() => {
        if (!presetId) return
        if (!personas.some((entry) => entry.id === presetId)) return
        if (selected === presetId) return
        setSelected(presetId)
        setTab('memory')
        loadMemory(presetId).catch(() => {})
      }, [presetId, personas, selected, loadMemory])
      /** Retire a topic: the file moves into topics/archive/ instead of disappearing. */
      const archive = useCallback(async (slug) => {
        if (!selected) return
        try {
          await api('/topics/archive', { method: 'POST', body: JSON.stringify({ id: selected, slug }) })
          setArchiving(null)
          const list = await api(`/topics?id=${encodeURIComponent(selected)}`)
          setTopics(Array.isArray(list.topics) ? list.topics : [])
          setTopicCount(Array.isArray(list.topics) ? list.topics.length : 0)
          if (topicView && topicView.slug === slug) setTopicView(null)
        } catch { /* leave the row as is */ }
      }, [selected, topicView])
      /** Read one topic file: the strip lists pointers, this opens the body. */
      const openTopic = useCallback(async (slug) => {
        if (!selected) return
        try {
          setError('')
          const data = await api(`/topics?id=${encodeURIComponent(selected)}&slug=${encodeURIComponent(slug)}`)
          setTopicView(data.topic ?? null)
        } catch (problem) {
          setError(problem.message)
        }
      }, [selected])
      const loadReview = useCallback(async (id) => {
        const data = await api(`/review?id=${encodeURIComponent(id)}&limit=40`)
        setReview(data.records ?? [])
      }, [])

      /** The app's own workspace list, so binding never requires typing a path. */
      const loadPicks = useCallback(async () => {
        const [data, poolData] = await Promise.all([
          api('/workspaces'),
          api('/unclaimed').catch(() => null),
        ])
        const items = Array.isArray(data.workspaces) ? data.workspaces : []
        setPicks(items)
        setPool(poolData ?? null)
        setPickSource(data.source ?? 'none')
        setPickId((current) => (items.some((item) => item.id === current) ? current : ''))
      }, [])

      /** Private skills of the selected persona. */
      const loadSkills = useCallback(async (id) => {
        const data = await api(`/skills?id=${encodeURIComponent(id)}`)
        setSkills(Array.isArray(data.skills) ? data.skills : [])
      }, [])

      const moveSkillTo = useCallback(
        async (skill) => {
          const to = moveTarget[skill.path]
          if (!to) return
          setBusy(true)
          try {
            setError('')
            await api('/skills/move', {
              method: 'POST',
              body: JSON.stringify({ from: selected, to, path: skill.path }),
            })
            setMoveTarget((current) => ({ ...current, [skill.path]: '' }))
            await loadSkills(selected)
            const name = personas.find((entry) => entry.id === to)?.name ?? to
            setNotice(`「${skill.name}」已移到「${name}」，下一个会话生效。`)
          } catch (problem) {
            setError(problem.message)
          } finally {
            setBusy(false)
          }
        },
        [moveTarget, selected, personas, loadSkills],
      )

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
            if (tab === 'projects') await loadPicks()
            if (tab === 'skills') await loadSkills(selected)
          } catch (problem) {
            if (alive) setError(problem.message)
          }
        })()
        return () => {
          alive = false
        }
      }, [selected, tab, loadMemory, loadReview, loadPicks])

      useEffect(() => {
        if (!notice) return undefined
        const timer = setTimeout(() => setNotice(''), 6000)
        return () => clearTimeout(timer)
      }, [notice])

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

      /** Bind one workspace the app already knows about, by its registry id. */
      const bindPicked = useCallback(async () => {
        if (!selected) return
        const item = picks.find((entry) => entry.id === pickId)
        if (!item) {
          setError('先在下拉里选一个工作区')
          return
        }
        setBusy(true)
        try {
          setError('')
          await api('/bind', { method: 'POST', body: JSON.stringify({ id: selected, workspaceId: item.id }) })
          setPickId('')
          await loadPicks()
          await refresh(selected)
        } catch (problem) {
          setError(problem.message)
        } finally {
          setBusy(false)
        }
      }, [picks, pickId, selected, refresh, loadPicks])

      /** Manual path, for a subdirectory that has no workspace record of its own. */
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
          await loadPicks()
          await refresh(selected)
        } catch (problem) {
          setError(problem.message)
        } finally {
          setBusy(false)
        }
      }, [draftPath, selected, refresh, loadPicks])

      const unbind = useCallback(
        async (workspace) => {
          setBusy(true)
          try {
            await api('/unbind', { method: 'POST', body: JSON.stringify({ id: selected, workspace }) })
            await loadPicks()
            await refresh(selected)
          } catch (problem) {
            setError(problem.message)
          } finally {
            setBusy(false)
          }
        },
        [selected, refresh, loadPicks],
      )

      /** Merge the unclaimed pool into this persona, then empty the pool. */
      const adoptPool = useCallback(async () => {
        if (!selected) return
        const name = personas.find((entry) => entry.id === selected)?.name ?? selected
        const total = (pool?.user?.entries?.length ?? 0) + (pool?.memory?.entries?.length ?? 0)
        const ok = window.confirm(
          `把未认领池的 ${total} 条并进「${name}」？\n\n并进后池子清空，default 目录里不再保留这些条目；超过上限会整批拒绝、两个文件都不动。`,
        )
        if (!ok) return
        setBusy(true)
        try {
          setError('')
          const result = await api('/adopt', { method: 'POST', body: JSON.stringify({ id: selected }) })
          await loadPicks()
          await loadMemory(selected)
          await refresh(selected)
          setNotice(`已并入 ${result.added.user} 条用户画像、${result.added.memory} 条角色笔记。`)
        } catch (problem) {
          setError(problem.message)
        } finally {
          setBusy(false)
        }
      }, [selected, personas, pool, loadPicks, loadMemory, refresh])

      /** The unclaimed bucket is editable too: it is a normal memory file, just unnamed. */
      const openPoolEditor = useCallback(async (tier) => {
        setBusy(true)
        try {
          setError('')
          const data = await api(`/memory?id=default&target=${tier}`)
          setPoolDraft({ tier, text: data.content, limit: data.usage.limit })
        } catch (problem) {
          setError(problem.message)
        } finally {
          setBusy(false)
        }
      }, [])

      const savePoolDraft = useCallback(async () => {
        if (!poolDraft) return
        setBusy(true)
        try {
          setError('')
          await api('/memory', {
            method: 'POST',
            body: JSON.stringify({ id: 'default', target: poolDraft.tier, content: poolDraft.text }),
          })
          setPoolDraft(null)
          await loadPicks()
          setNotice('未认领池已保存。')
        } catch (problem) {
          setError(problem.message)
        } finally {
          setBusy(false)
        }
      }, [poolDraft, loadPicks])

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
          binding ? h('p', { className: 'dp-binding' }, binding) : null,
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
          ['skills', T.tabSkills],
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
      } else if (tab === 'skills') {
        body = h(
          'div',
          { className: 'dp-skills' },
          current
            ? h(
                'div',
                { className: 'dp-sec-head' },
                h('h2', { className: 'dp-sec-title' }, '私有技能'),
                h('span', { className: 'dp-sec-meta' }, `${skills.length} 个 · 只对本角色可见`),
              )
            : null,
          skills.length
            ? h(
                'ul',
                { className: 'dp-skill-list' },
                skills.map((skill) =>
                  h(
                    'li',
                    { key: skill.path, className: 'dp-skill' },
                    h(
                      'div',
                      { className: 'dp-skill-text' },
                      h('span', { className: 'dp-skill-name' }, skill.name),
                      skill.description ? h('span', { className: 'dp-skill-desc' }, skill.description) : null,
                      h('code', { className: 'dp-skill-path' }, skill.path),
                    ),
                    h(
                      'div',
                      { className: 'dp-skill-act' },
                      h(
                        'select',
                        {
                          className: 'dp-field dp-skill-select',
                          value: moveTarget[skill.path] ?? '',
                          disabled: busy,
                          onChange: (event) => setMoveTarget({ ...moveTarget, [skill.path]: event.target.value }),
                        },
                        h('option', { value: '' }, '移到…'),
                        personas
                          .filter((entry) => entry.id !== selected)
                          .map((entry) => h('option', { key: entry.id, value: entry.id }, entry.name)),
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dp-btn dp-btn-sm',
                          disabled: busy || !moveTarget[skill.path],
                          onClick: () => moveSkillTo(skill),
                        },
                        '移动',
                      ),
                    ),
                  ),
                ),
              )
            : h(
                'p',
                { className: 'dp-juris-empty' },
                '这个角色还没有私有技能。放进 personas/<角色>/skills/ 里即可，目录式（<名字>/SKILL.md）或平铺式（<名字>.md）都行。',
              ),
        )
      } else if (editing) {
        const draft = tab === 'user' ? user : notes
        body = h(
          'div',
          { className: 'dp-doc-col' },
          historyView
            ? h(
                'div',
                { className: 'dp-topic-read' },
                h(
                  'div',
                  { className: 'dp-topic-head' },
                  h(
                    'h2',
                    { className: 'dp-sec-title' },
                    historyView.status === 'superseded' ? '已被推翻' : historyView.status === 'removed' ? '已删除' : '已到期',
                  ),
                  h('button', { type: 'button', className: 'dp-link', onClick: () => setHistoryView(null) }, '返回'),
                ),
                h('pre', { className: 'dp-topic-body' }, historyView.preview || '(没有留下预览)'),
                h(
                  'p',
                  { className: 'dp-topic-meta' },
                  [
                    `记录 ${historyView.hash}`,
                    historyView.invalidAt ? `失效于 ${historyView.invalidAt}` : '',
                    historyView.expiresAt ? `有效期至 ${historyView.expiresAt}` : '',
                    historyView.supersededBy ? `被 ${historyView.supersededBy} 顶替` : '',
                  ]
                    .filter(Boolean)
                    .join(' · '),
                ),
              )
            : topicView
            ? h(
                'div',
                { className: 'dp-topic-read' },
                h(
                  'div',
                  { className: 'dp-topic-head' },
                  h('h2', { className: 'dp-sec-title' }, topicView.slug),
                  h('button', { type: 'button', className: 'dp-link', onClick: () => setTopicView(null) }, '返回编辑'),
                ),
                topicView.summary ? h('p', { className: 'dp-topic-summary' }, topicView.summary) : null,
                h('pre', { className: 'dp-topic-body' }, topicView.body),
                h('p', { className: 'dp-topic-meta' }, `${topicView.chars} 字符 · ${topicView.updated || '未记录时间'} · ${topicView.path}`),
              )
            : h(
                React.Fragment,
                null,
                topics.length
                  ? h(
                      'div',
                      { className: 'dp-topic-strip' },
                      h(
                        'button',
                        { type: 'button', className: 'dp-topic-toggle', onClick: () => setTopicsOpen(!topicsOpen) },
                        `主题 ${topics.length} 个`,
                        h('span', { className: 'dp-topic-caret', 'aria-hidden': true }, topicsOpen ? '−' : '+'),
                      ),
                      topicsOpen
                        ? h(
                            'ul',
                            { className: 'dp-topic-list' },
                            topics.map((topic) =>
                              h(
                                'li',
                                { key: topic.slug },
                                h(
                                  'button',
                                  { type: 'button', className: 'dp-topic-row', onClick: () => openTopic(topic.slug) },
                                  h('span', { className: 'dp-topic-slug' }, topic.slug),
                                  h('span', { className: 'dp-topic-sum' }, topic.summary || '(无摘要)'),
                                  archiving === topic.slug
                                    ? h(
                                        'span',
                                        { className: 'dp-topic-confirm' },
                                        h('button', { type: 'button', className: 'dp-link', onClick: () => archive(topic.slug) }, '确认归档'),
                                        h('button', { type: 'button', className: 'dp-link', onClick: () => setArchiving(null) }, '取消'),
                                      )
                                    : h('span', { className: 'dp-topic-chars' }, String(topic.chars)),
                                  archiving === topic.slug
                                    ? null
                                    : h(
                                        'button',
                                        {
                                          type: 'button',
                                          className: 'dp-topic-archive',
                                          onClick: (event) => {
                                            event.stopPropagation()
                                            setArchiving(topic.slug)
                                          },
                                        },
                                        '归档',
                                      ),
                                ),
                              ),
                            ),
                          )
                        : null,
                    )
                  : null,
                history.length
                  ? h(
                      'div',
                      { className: 'dp-topic-strip dp-history-strip' },
                      h(
                        'button',
                        { type: 'button', className: 'dp-topic-toggle', onClick: () => setHistoryOpen(!historyOpen) },
                        `已失效 ${history.length} 条`,
                        h('span', { className: 'dp-topic-caret', 'aria-hidden': true }, historyOpen ? '−' : '+'),
                      ),
                      historyOpen
                        ? h(
                            'ul',
                            { className: 'dp-topic-list' },
                            history.map((record) =>
                              h(
                                'li',
                                { key: record.hash },
                                h(
                                  'button',
                                  { type: 'button', className: 'dp-topic-row', onClick: () => setHistoryView(record) },
                                  h(
                                    'span',
                                    { className: 'dp-history-state', 'data-tone': record.expired && record.status === 'active' ? 'warn' : '' },
                                    record.status === 'superseded' ? '失效' : record.status === 'removed' ? '删除' : '到期',
                                  ),
                                  h('span', { className: 'dp-topic-sum' }, record.preview || record.hash),
                                  h('span', { className: 'dp-topic-chars' }, String(record.invalidAt || record.expiresAt || '').slice(0, 10)),
                                ),
                              ),
                            ),
                          )
                        : null,
                    )
                  : null,                h('textarea', {
                  className: 'dp-manuscript',
                  value: draft.text,
                  spellCheck: false,
                  'aria-label': tab === 'user' ? T.tabUser : T.tabMemory,
                  onChange: (event) => {
                    const next = { ...draft, text: event.target.value }
                    if (tab === 'user') setUser(next)
                    else setNotes(next)
                  },
                }),
              ),
        )
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
        const bound = current ? current.workspaces : []
        const pathKey = (value) => String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
        const boundKeys = new Set(bound.map(pathKey))
        const candidates = picks.filter((item) => !boundKeys.has(pathKey(item.path)))
        const picked = candidates.find((item) => item.id === pickId)
        const boundSessions = picks
          .filter((item) => boundKeys.has(pathKey(item.path)))
          .reduce((sum, item) => sum + (Number(item.sessions) || 0), 0)
        const owner = current ? current.name : ''
        /** Split the claim boundary: ancestry is context, the tail segment is the actual territory. */
        const splitTail = (value) => {
          const text = String(value ?? '')
          const cut = Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/'))
          return cut < 0 ? { head: '', tail: text } : { head: text.slice(0, cut + 1), tail: text.slice(cut + 1) }
        }
        const overlaps = (workspace) => bound.some((other) => other !== workspace && pathKey(workspace).startsWith(`${pathKey(other)}/`))
        const poolEntries = pool && !pool.empty
          ? [...(pool.user?.entries ?? []), ...(pool.memory?.entries ?? [])]
          : []
        const poolChars = (pool?.user?.usage?.used ?? 0) + (pool?.memory?.usage?.used ?? 0)

        body = h(
          'div',
          { className: 'dp-juris' },
          poolEntries.length
            ? h(
                'section',
                { className: 'dp-pool' },
                h(
                  'div',
                  { className: 'dp-sec-head dp-sec-head-unfiled' },
                  h('h2', { className: 'dp-sec-title' }, '未认领池'),
                  h('span', { className: 'dp-sec-meta dp-sec-meta-warn' }, `${poolEntries.length} 条 · ${poolChars} 字符`),
                  h(
                    'button',
                    { type: 'button', className: 'dp-btn dp-btn-sm', onClick: adoptPool, disabled: busy || !selected },
                    `并入「${owner}」`,
                  ),
                ),
                h(
                  'p',
                  { className: 'dp-pool-note' },
                  '工作区没绑角色时，那边的会话把记忆写进这里：所有未绑定的项目混在同一份，面板平时看不到它。',
                ),
                ...['user', 'memory'].map((tier) => {
                  const entries = pool?.[tier]?.entries ?? []
                  const editing = poolDraft && poolDraft.tier === tier
                  if (!entries.length && !editing) return null
                  return h(
                    'div',
                    { key: tier, className: 'dp-pool-tier' },
                    h(
                      'div',
                      { className: 'dp-pool-tier-head' },
                      h('span', { className: 'dp-pool-tier-name' }, tier === 'user' ? '用户画像' : '角色笔记'),
                      h('span', { className: 'dp-pool-tier-count' }, `${entries.length} 条`),
                      editing
                        ? null
                        : h(
                            'button',
                            { type: 'button', className: 'dp-link', onClick: () => openPoolEditor(tier), disabled: busy },
                            '编辑',
                          ),
                    ),
                    editing
                      ? h(
                          'div',
                          { className: 'dp-pool-edit' },
                          h('textarea', {
                            className: 'dp-pool-area',
                            value: poolDraft.text,
                            spellCheck: false,
                            onChange: (event) => setPoolDraft({ ...poolDraft, text: event.target.value }),
                          }),
                          h(
                            'div',
                            { className: 'dp-pool-edit-bar' },
                            h('span', { className: 'dp-pool-usage' }, `${poolDraft.text.length} / ${poolDraft.limit} 字符`),
                            h('button', { type: 'button', className: 'dp-btn dp-btn-sm', onClick: () => setPoolDraft(null) }, '撤销'),
                            h(
                              'button',
                              { type: 'button', className: 'dp-btn dp-btn-sm', 'data-tone': 'primary', onClick: savePoolDraft, disabled: busy },
                              '保存',
                            ),
                          ),
                        )
                      : h(
                          'ul',
                          { className: 'dp-pool-list' },
                          entries.slice(0, 2).map((entry, index) => h('li', { key: index }, entry)),
                        ),
                    !editing && entries.length > 2
                      ? h('p', { className: 'dp-pool-more' }, `还有 ${entries.length - 2} 条，点「编辑」看全文。`)
                      : null,
                  )
                }),
                pool.workspaces && pool.workspaces.length
                  ? h(
                      'p',
                      { className: 'dp-pool-note dp-pool-note-quiet' },
                      `还有 ${pool.workspaces.length} 个工作区没认领：${pool.workspaces.map((item) => item.title).join('、')}。`,
                    )
                  : null,
              )
            : null,
          h(
            'div',
            { className: 'dp-sec-head' },
            h('h2', { className: 'dp-sec-title' }, '管辖范围'),
            h('span', { className: 'dp-sec-meta' }, `${bound.length} 处 · ${boundSessions} 个会话`),
          ),
          bound.length
            ? h(
                'ul',
                { className: 'dp-deeds' },
                bound.map((workspace) => {
                  const hit = picks.find((item) => pathKey(item.path) === pathKey(workspace))
                  const parts = splitTail(workspace)
                  const nested = overlaps(workspace)
                  return h(
                    'li',
                    { key: workspace, className: 'dp-deed', 'data-nested': nested ? '1' : '0' },
                    h(
                      'div',
                      { className: 'dp-deed-line' },
                      nested ? h('span', { className: 'dp-deed-branch', 'aria-hidden': true }, '└') : null,
                      h('span', { className: 'dp-deed-name' }, hit ? hit.title : parts.tail),
                      hit && hit.sessions ? h('span', { className: 'dp-deed-count' }, `${hit.sessions} 个会话`) : null,
                      h('button', { type: 'button', className: 'dp-btn dp-deed-unbind', onClick: () => unbind(workspace), disabled: busy }, '解绑'),
                    ),
                    h(
                      'p',
                      { className: 'dp-deed-path' },
                      parts.head ? h('span', { className: 'dp-deed-head' }, parts.head) : null,
                      h('strong', null, parts.tail),
                    ),
                    nested ? h('p', { className: 'dp-deed-note' }, '落在上一处目录之内；两边都能命中时，这一处算。') : null,
                  )
                }),
              )
            : h(
                'p',
                { className: 'dp-juris-empty' },
                '还没有认领任何目录。这个角色的会话只在它管辖的目录里出现。',
              ),
          h(
            'div',
            { className: 'dp-sec-head dp-sec-head-claim' },
            h('h2', { className: 'dp-sec-title' }, '可以认领的工作区'),
            h('span', { className: 'dp-sec-meta' }, pickSource === 'storage' ? '读自 workspace.json' : '选一行，再确认'),
          ),
          candidates.length
            ? h(
                'ul',
                { className: 'dp-cands' },
                candidates.map((item) =>
                  h(
                    'li',
                    { key: item.id },
                    h(
                      'button',
                      {
                        type: 'button',
                        'aria-current': pickId === item.id ? 'true' : 'false',
                        className: 'dp-cand',
                        'data-picked': pickId === item.id ? '1' : '0',
                        onClick: () => setPickId(item.id),
                      },
                      h(
                        'span',
                        { className: 'dp-cand-text' },
                        h('span', { className: 'dp-cand-name' }, item.title),
                        h('span', { className: 'dp-cand-path' }, item.path),
                      ),
                      h(
                        'span',
                        { className: 'dp-cand-tags' },
                        item.boundTo && item.boundTo !== selected
                          ? h('span', { className: 'dp-cand-owner' }, item.boundName || item.boundTo)
                          : null,
                        item.sessions ? h('span', { className: 'dp-cand-count' }, `${item.sessions} 个会话`) : null,
                      ),
                    ),
                  ),
                ),
              )
            : h('p', { className: 'dp-juris-empty' }, '应用里的工作区都认领完了。要细分到子目录，用下面的手动路径。'),
          picked
            ? h(
                'div',
                { className: 'dp-juris-act' },
                h(
                  'p',
                  { className: 'dp-juris-act-hint' },
                  picked.boundTo && picked.boundTo !== selected
                    ? `会从「${picked.boundName || picked.boundTo}」名下移走，记忆留在原角色那里。`
                    : `认领后，这个目录和它下面的子目录都用「${owner}」的记忆。`,
                ),
                h(
                  'button',
                  { type: 'button', className: 'dp-btn', 'data-tone': 'primary', onClick: bindPicked, disabled: busy || !selected },
                  picked.boundTo && picked.boundTo !== selected ? '改绑' : '认领',
                ),
              )
            : null,
          h(
            'div',
            { className: 'dp-footnote' },
            h(
              'p',
              null,
              '匹配按最长前缀。认领了 ',
              h('code', null, 'deep'),
              ' 之后，',
              h('code', null, 'deep\\plugins'),
              ' 里的会话也归这个角色；若把 ',
              h('code', null, 'deep\\plugins'),
              ' 单独认领给另一个角色，那里就归后者。',
            ),
            manual
              ? h(
                  'div',
                  { className: 'dp-manual' },
                  h('input', {
                    className: 'dp-field',
                    placeholder: T.pathHint,
                    value: draftPath,
                    onChange: (event) => setDraftPath(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') bind()
                    },
                  }),
                  h('button', { type: 'button', className: 'dp-btn', onClick: bind, disabled: busy }, '认领'),
                  h('button', { type: 'button', className: 'dp-link', onClick: () => setManual(false) }, '收起'),
                )
              : h(
                  'button',
                  { type: 'button', className: 'dp-link', onClick: () => setManual(true) },
                  '手动指定子目录',
                ),
          ),
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
              h('span', { className: 'dp-foot-state', title: '常驻记忆条数 · 主题库文件数' }, `记 ${residentCount} 条 · 主题 ${topicCount}`),
              nearFull ? h('span', { className: 'dp-foot-state', 'data-tone': 'warn' }, '常驻已满 · 新增转存主题') : null,
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
          notice ? h('p', { className: 'dp-notice', role: 'status' }, notice) : null,
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
      '.dp-doc-col{flex:1;min-height:0;display:flex;flex-direction:column;gap:8px}',
      '.dp-topic-strip{border-bottom:1px solid var(--dsw-alias-border-l1);padding-bottom:6px}',
      '.dp-topic-toggle{display:flex;align-items:baseline;gap:8px;border:0;background:none;padding:0;font:inherit;font-size:11.5px;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.dp-topic-toggle:hover{color:var(--dsw-alias-brand-primary)}',
      '.dp-topic-caret{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}',
      '.dp-topic-list{list-style:none;margin:6px 0 0;padding:0;display:flex;flex-direction:column;max-height:168px;overflow:auto}',
      '.dp-topic-row{display:flex;align-items:baseline;gap:10px;width:100%;text-align:left;border:0;border-left:2px solid transparent;background:none;padding:4px 6px 4px 8px;font:inherit;cursor:pointer}',
      '.dp-topic-row:hover{background:var(--dsw-alias-bg-layer-1);border-left-color:var(--dsw-alias-border-l2)}',
      '.dp-topic-slug{font-family:Georgia,"Source Han Serif SC","Songti SC",serif;font-size:13px;flex:0 0 auto}',
      '.dp-topic-sum{flex:1;min-width:0;font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dp-topic-chars{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dp-topic-archive{border:0;background:none;padding:0 0 0 8px;font:inherit;font-size:11px;line-height:inherit;color:var(--dsw-alias-label-secondary);opacity:0;cursor:pointer}',
      '.dp-topic-row:hover .dp-topic-archive{opacity:1}',
      '.dp-topic-archive:hover{color:var(--dsw-alias-state-warn-primary)}',
      '.dp-topic-confirm{display:flex;gap:8px;flex:0 0 auto}',
      '.dp-topic-read{flex:1;min-height:0;display:flex;flex-direction:column;gap:8px;overflow:auto}',
      '.dp-topic-head{display:flex;align-items:baseline;gap:12px}',
      '.dp-topic-summary{margin:0;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary)}',
      '.dp-topic-body{margin:0;font-family:Georgia,"Source Han Serif SC","Songti SC",serif;font-size:12.5px;line-height:1.9;white-space:pre-wrap;word-break:break-word}',
      '.dp-topic-meta{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all}',      '.dp-binding{margin:3px 0 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary);opacity:.85;word-break:break-all}',
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
      '.dp-juris{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:14px;padding-bottom:8px}',
      '.dp-pool{display:flex;flex-direction:column}',
      '.dp-skills{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:12px}',
      '.dp-skill-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}',
      '.dp-skill{display:flex;align-items:flex-start;gap:16px;padding:12px 0 13px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.dp-skill-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}',
      '.dp-skill-name{font-family:Georgia,"Source Han Serif SC","Songti SC",serif;font-size:14px}',
      '.dp-skill-desc{font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary);max-width:60ch}',
      '.dp-skill-path{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all}',
      '.dp-skill-act{display:flex;align-items:center;gap:6px;flex:0 0 auto}',
      '.dp-skill-select{font-size:11.5px;padding:2px 6px}',
      '.dp-sec-head-unfiled{border-bottom-color:transparent;background-image:repeating-linear-gradient(to right,var(--dsw-alias-border-l2) 0 5px,transparent 5px 11px);background-size:100% 1px;background-position:0 100%;background-repeat:no-repeat}',
      '.dp-sec-meta-warn{color:var(--dsw-alias-state-warn-primary)}',
      '.dp-pool-note{margin:10px 0 0;font-size:12px;line-height:1.75;color:var(--dsw-alias-label-secondary);max-width:62ch}',
      '.dp-pool-note-quiet{margin-top:9px;font-size:11.5px}',
      '.dp-pool-tier{margin-top:12px;display:flex;flex-direction:column;gap:5px}',
      '.dp-pool-tier-head{display:flex;align-items:baseline;gap:8px}',
      '.dp-pool-tier-head .dp-link{margin-left:auto}',
      '.dp-pool-edit{display:flex;flex-direction:column;gap:7px;margin-top:6px}',
      '.dp-pool-area{width:100%;min-height:104px;resize:vertical;border:1px solid var(--dsw-alias-border-l1);border-radius:3px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);padding:8px 10px;font-family:Georgia,"Source Han Serif SC","Songti SC",serif;font-size:12.5px;line-height:1.8;outline:none}',
      '.dp-pool-area:focus-visible{border-color:var(--dsw-alias-brand-primary)}',
      '.dp-pool-edit-bar{display:flex;align-items:center;gap:8px}',
      '.dp-pool-usage{margin-right:auto;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dp-pool-tier-name{font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.dp-pool-tier-count{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dp-pool-list{list-style:none;margin:0;padding:0 0 0 1.6ch;display:flex;flex-direction:column;gap:5px}',
      '.dp-pool-list li{font-family:Georgia,"Source Han Serif SC","Songti SC",serif;font-size:12.5px;line-height:1.8;color:var(--dsw-alias-label-primary)}',
      '.dp-pool-more{margin:0;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dp-sec-head{display:flex;align-items:baseline;gap:12px;padding-bottom:7px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.dp-sec-head-claim{margin-top:26px}',
      '.dp-sec-title{margin:0;font-family:Georgia,"Source Han Serif SC","Songti SC",serif;font-size:14px;font-weight:600;letter-spacing:.01em}',
      '.dp-sec-meta{margin-left:auto;font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.dp-juris-empty{margin:0;padding:14px 0;font-size:12.5px;line-height:1.75;color:var(--dsw-alias-label-secondary);max-width:62ch}',
      '.dp-deeds{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}',
      '.dp-deed{padding:12px 0 13px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.dp-deed[data-nested="1"]{padding-left:16px;border-left:1px solid var(--dsw-alias-border-l2)}',
      '.dp-deed-line{display:flex;align-items:baseline;gap:10px}',
      '.dp-deed-branch{width:12px;margin-left:-16px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dp-deed-name{font-family:Georgia,"Source Han Serif SC","Songti SC",serif;font-size:15px;font-weight:600;line-height:1.4}',
      '.dp-deed-count{font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.dp-deed-unbind{margin-left:auto;padding:2px 6px;border-color:transparent;color:var(--dsw-alias-label-secondary)}',
      '.dp-deed-unbind:hover{background:none;border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-state-error-primary)}',
      '.dp-deed-path{margin:4px 0 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.7;color:var(--dsw-alias-label-secondary);word-break:break-all}',
      '.dp-deed-path strong{font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dp-deed-note{margin:5px 0 0;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary);max-width:60ch}',
      '.dp-cands{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}',
      '.dp-cand{display:flex;align-items:center;gap:14px;width:100%;padding:11px 10px 11px 12px;text-align:left;border:0;border-left:3px solid transparent;border-bottom:1px solid var(--dsw-alias-border-l1);background:none;color:inherit;font:inherit;cursor:pointer;transition:background-color .12s ease}',
      '.dp-cand:hover{background:var(--dsw-alias-bg-layer-1)}',
      '.dp-cand[data-picked="1"]{border-left-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}',
      '.dp-cand:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
      '.dp-cand-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}',
      '.dp-cand-name{font-family:Georgia,"Source Han Serif SC","Songti SC",serif;font-size:14px}',
      '.dp-cand-path{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:var(--dsw-alias-label-secondary);word-break:break-all}',
      '.dp-cand-tags{display:flex;align-items:center;gap:8px}',
      '.dp-cand-count{font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.dp-cand-owner{padding:0 5px;border:1px solid currentColor;border-radius:2px;font-size:11px;color:var(--dsw-alias-state-warn-primary);white-space:nowrap}',
      '.dp-juris-act{display:flex;align-items:center;gap:14px;padding:10px 0 2px}',
      '.dp-juris-act-hint{margin:0;font-size:12.5px;line-height:1.65;color:var(--dsw-alias-label-secondary);max-width:58ch}',
      '.dp-juris-act .dp-btn{margin-left:auto}',
      '.dp-footnote{margin-top:24px;padding-top:12px;border-top:1px dotted var(--dsw-alias-border-l1);display:flex;flex-direction:column;gap:8px}',
      '.dp-footnote p{margin:0;font-size:11.5px;line-height:1.8;color:var(--dsw-alias-label-secondary);max-width:62ch}',
      '.dp-footnote code{padding:0 4px;border-radius:2px;background:var(--dsw-alias-bg-layer-1);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-primary)}',
      '.dp-manual{display:flex;align-items:center;gap:8px}',
      '.dp-manual .dp-field{flex:1;min-width:0;max-width:560px}',
      '.dp-link{align-self:flex-start;border:0;border-bottom:1px solid var(--dsw-alias-border-l2);background:none;color:var(--dsw-alias-label-secondary);padding:0;font:inherit;font-size:11.5px;cursor:pointer}',
      '.dp-link:hover{color:var(--dsw-alias-brand-primary);border-bottom-color:var(--dsw-alias-brand-primary)}',
      '.dp-link:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dp-link:disabled{opacity:.45;cursor:default;color:var(--dsw-alias-label-secondary)}',
      '.dp-btn-sm{padding:2px 8px;font-size:11.5px;align-self:center}',
      '.dp-empty{flex:1;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);font-size:12.5px;text-align:center;padding:28px}',
      '.dp-error{margin:0;padding:8px 28px 0;color:var(--dsw-alias-state-error-primary);font-size:12.5px}',
      '.dp-notice{margin:0;padding:8px 28px 0;color:var(--dsw-alias-state-success-primary);font-size:12.5px}',
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
      '.dp-foot-state[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary)}',
      '.dp-foot-path{font-size:11px;color:var(--dsw-alias-label-secondary);max-width:40ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dp-limit{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.dp-limit-field{width:84px;padding:3px 6px;font-size:11.5px}',
      '@media (max-width:720px){.dp-spine{width:132px;flex-basis:132px}.dp-head,.dp-tabs,.dp-doc,.dp-foot{padding-left:16px;padding-right:16px}.dp-index-meta{display:none}.dp-cand-tags{flex-direction:column;align-items:flex-end;gap:3px}.dp-juris-act{flex-wrap:wrap}.dp-juris-act .dp-btn{margin-left:0}}',
      '@media (prefers-reduced-motion:reduce){.dp-btn,.dp-tab,.dp-gauge-fill{transition:none}}',
    ].join('\n')

    return {
      inject: ['slots'],
      apply(ctx) {
        ensureNoteStyles()
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: 'personas', order: 40, label: T.panel }, Icon),
        )
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'personas' }, Panel))
        ctx.slots.inject('conversation.view', () =>
          ctx.slots.register({ name: 'conversation.view', id: 'persona', order: 20, label: '角色' }, PersonaView),
        )
        ctx.slots.inject('conversation.chat.turnTail', () =>
          ctx.slots.register({ name: 'conversation.chat.turnTail', id: 'persona-memory-note', order: 10 }, MemoryNote),
        )
      },
    }
  },
})
