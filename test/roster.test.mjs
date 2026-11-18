import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  allowRequest,
  apply,
  bindWorkspace,
  createPersona,
  deletePersona,
  planAdoption,
  readIndexFrom,
  resolvePersonaForCwd,
  unbindWorkspace,
  updatePersona,
} from '../lib/roster.js'
import { parseEntries } from '../lib/store.js'
import { SLOT_COUNT } from '../lib/slots.js'

const empty = () => ({ version: 1, personas: [] })

test('garbage registry content falls back to an empty index', () => {
  assert.deepEqual(readIndexFrom('not json').personas, [])
  assert.deepEqual(readIndexFrom('').personas, [])
  assert.deepEqual(readIndexFrom('{"personas":"nope"}').personas, [])
})

test('a persona id is the name you gave it', () => {
  const first = createPersona(empty(), { name: '码趣项目' })
  assert.equal(first.ok, true)
  assert.equal(first.persona.id, '码趣项目')
  assert.equal(first.persona.presetId, 'persona-码趣项目')
  const second = createPersona(first.index, { name: 'Another' })
  assert.equal(second.persona.id, 'another')
})

test('a duplicate name gets a suffix instead of a slot number', () => {
  const first = createPersona(empty(), { name: '项目' })
  const second = createPersona(first.index, { name: '项目' })
  assert.equal(second.ok, true)
  assert.equal(second.persona.id, '项目-2')
})

test('personas run out at the declared count', () => {
  let index = empty()
  for (let n = 1; n <= SLOT_COUNT; n += 1) {
    const result = createPersona(index, { name: `角色${n}` })
    assert.equal(result.ok, true)
    index = result.index
  }
  const overflow = createPersona(index, { name: '多余' })
  assert.equal(overflow.ok, false)
  assert.match(overflow.error, /角色已满/)
})

test('deleting a persona through the api takes its memory to the trash', async () => {
  await withTempHome(async (home) => {
    const { ctx, call } = fakeHost()
    apply(ctx, {})
    const headers = { 'x-dsh-persona-kit': '1' }
    const created = await callApi(call, {
      method: 'POST',
      url: '/dsh-persona-kit/api/create',
      headers,
      body: { name: '待删除' },
    })
    const id = created.body.persona.id
    const memoryDir = path.join(home, 'personas', id, 'memory')
    await mkdir(memoryDir, { recursive: true })
    await writeFile(path.join(memoryDir, 'user.md'), '要被一起收走的记忆', 'utf8')

    const deleted = await callApi(call, { method: 'POST', url: '/dsh-persona-kit/api/delete', headers, body: { id } })
    assert.equal(deleted.status, 200)
    assert.ok(deleted.body.trashed, '响应里要给出回收站路径')
    assert.equal(existsSync(path.join(home, 'personas', id)), false, '记忆目录不能留在 personas/ 下')
    assert.equal(await readFile(path.join(deleted.body.trashed, 'memory', 'user.md'), 'utf8'), '要被一起收走的记忆')
  })
})

test('workspace binding resolves nested cwd, case and slash form', () => {
  let index = createPersona(empty(), { name: 'Work' }).index
  index = bindWorkspace(index, 'work', 'C:\\A\\work\\proj').index
  assert.equal(resolvePersonaForCwd(index, 'C:\\A\\work\\proj\\src')?.id, 'work')
  assert.equal(resolvePersonaForCwd(index, 'c:/a/WORK/proj/sub')?.id, 'work')
  assert.equal(resolvePersonaForCwd(index, 'C:\\A\\work\\other'), undefined)
})

test('the most specific workspace wins', () => {
  let index = createPersona(empty(), { name: 'Outer' }).index
  index = createPersona(index, { name: 'Inner' }).index
  index = bindWorkspace(index, 'outer', 'C:\\A\\work').index
  index = bindWorkspace(index, 'inner', 'C:\\A\\work\\deep').index
  assert.equal(resolvePersonaForCwd(index, 'C:\\A\\work\\deep\\plugins')?.id, 'inner')
  assert.equal(resolvePersonaForCwd(index, 'C:\\A\\work\\other')?.id, 'outer')
})

test('rebinding a workspace moves it off the previous persona', () => {
  let index = createPersona(empty(), { name: 'A' }).index
  index = createPersona(index, { name: 'B' }).index
  index = bindWorkspace(index, 'a', 'C:\\proj').index
  index = bindWorkspace(index, 'b', 'C:\\proj').index
  assert.deepEqual(index.personas.find((entry) => entry.id === 'a').workspaces, [])
  assert.deepEqual(index.personas.find((entry) => entry.id === 'b').workspaces, ['C:\\proj'])
})

test('unbind, update and delete', () => {
  let index = createPersona(empty(), { name: 'A' }).index
  index = bindWorkspace(index, 'a', 'C:\\proj').index
  index = unbindWorkspace(index, 'a', 'c:/proj').index
  assert.deepEqual(index.personas[0].workspaces, [])
  index = updatePersona(index, 'a', { name: '改名后' }).index
  assert.equal(index.personas[0].name, '改名后')
  index = updatePersona(index, 'a', { homeSessionId: 'session-1' }).index
  assert.equal(index.personas[0].homeSessionId, 'session-1')
  index = deletePersona(index, 'a').index
  assert.equal(index.personas.length, 0)
})

function fakeHost() {
  let handler
  const ctx = {
    logger: { warn() {}, info() {} },
    get: () => undefined,
    effect(fn) {
      fn()
      return () => {}
    },
    webServer: {
      register(route) {
        handler = route.handler
        return () => {}
      },
    },
  }
  return { ctx, call: (req, res) => handler(req, res) }
}

function fakeRequest({ method = 'GET', url = '/', headers = {}, body }) {
  const listeners = new Map()
  const req = {
    method,
    url,
    headers,
    on(event, fn) {
      listeners.set(event, fn)
      return req
    },
    destroy() {},
  }
  if (body !== undefined) {
    queueMicrotask(() => {
      listeners.get('data')?.(Buffer.from(JSON.stringify(body), 'utf8'))
      listeners.get('end')?.()
    })
  }
  return req
}

function fakeResponse() {
  const res = {
    statusCode: 0,
    payload: '',
    writeHead(status) {
      res.statusCode = status
    },
    end(chunk) {
      res.payload += chunk ?? ''
    },
  }
  return res
}

async function callApi(call, request) {
  const res = fakeResponse()
  await call(fakeRequest(request), res)
  return { status: res.statusCode, body: res.payload ? JSON.parse(res.payload) : null }
}

async function withTempHome(fn) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-persona-kit-roster-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await fn(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
}

test('api rejects requests without the gate header', async () => {
  await withTempHome(async () => {
    const { ctx, call } = fakeHost()
    apply(ctx, {})
    const result = await callApi(call, { url: '/dsh-persona-kit/api/list' })
    assert.equal(result.status, 403)
  })
})

test('the gate refuses non-loopback hosts and cross-site origins', () => {
  const ok = { host: '127.0.0.1:52233', 'x-dsh-persona-kit': '1' }
  assert.equal(allowRequest(ok).ok, true)
  assert.equal(allowRequest({ ...ok, host: 'localhost:52233' }).ok, true)
  assert.equal(allowRequest({ ...ok, host: '[::1]:52233' }).ok, true)

  assert.equal(allowRequest({ ...ok, host: 'evil.example:80' }).ok, false)
  assert.equal(allowRequest({ ...ok, origin: 'https://evil.example' }).ok, false)
  assert.equal(allowRequest({ ...ok, origin: 'not a url' }).ok, false)
  assert.equal(allowRequest({ ...ok, origin: 'http://127.0.0.1:52233' }).ok, true)
  assert.equal(allowRequest({ ...ok, 'sec-fetch-site': 'cross-site' }).ok, false)
  assert.equal(allowRequest({ host: '127.0.0.1:52233' }).ok, false, '缺门禁头也要拒')
})

test('health reports the last recall record for one persona', async () => {
  await withTempHome(async (home) => {
    const { ctx, call } = fakeHost()
    apply(ctx, {})
    const dir = path.join(home, 'personas', 'slot-1', 'review')
    await mkdir(dir, { recursive: true })
    await writeFile(
      path.join(dir, 'metrics.jsonl'),
      `${JSON.stringify({
        at: new Date().toISOString(),
        turn: 3,
        status: 'written',
        recall: { outcome: 'injected', chars: 171, topics: ['磁盘与清理'], ms: 4, turn: 3 },
        tokens: { in: 100, out: 5, cacheRead: 0 },
        usageMissing: false,
      })}\n`,
      'utf8',
    )
    const result = await callApi(call, { url: '/dsh-persona-kit/api/health?id=slot-1', headers: { 'x-dsh-persona-kit': '1' } })
    assert.equal(result.status, 200)
    assert.equal(result.body.verdict, 'ok')
    assert.equal(result.body.injected, 1)
    assert.equal(result.body.last.recall.outcome, 'injected')
    assert.equal(result.body.last.recall.chars, 171)
    // The panel renders this read model instead of re-deriving the wording.
    assert.equal(result.body.readout.label, '召回 1 篇 / 171 字符')
  })
})

test('policy is readable and writable through the panel api, with an audit line', async () => {
  await withTempHome(async (home) => {
    const { ctx, call } = fakeHost()
    apply(ctx, {})
    const headers = { 'x-dsh-persona-kit': '1' }

    const before = await callApi(call, { url: '/dsh-persona-kit/api/policy?id=default', headers })
    assert.equal(before.status, 200)
    assert.deepEqual(before.body.policy.readOnly, [])
    assert.equal(before.body.present, false)

    const saved = await callApi(call, {
      url: '/dsh-persona-kit/api/policy?id=default',
      method: 'POST',
      headers,
      body: { id: 'default', readOnly: ['user'] },
    })
    assert.equal(saved.status, 200)
    assert.deepEqual(saved.body.policy.readOnly, ['user'])

    const after = await callApi(call, { url: '/dsh-persona-kit/api/policy?id=default', headers })
    assert.deepEqual(after.body.policy.readOnly, ['user'])
    assert.equal(after.body.present, true)

    const log = await readFile(path.join(home, 'personas', 'default', 'review', 'log.jsonl'), 'utf8')
    assert.match(log, /"actor":"human"/)
    assert.match(log, /"action":"policy"/)
  })
})

test('api creates, lists and resolves personas', async () => {
  await withTempHome(async (home) => {
    const workspace = path.join(home, 'proj')
    await mkdir(workspace, { recursive: true })
    const { ctx, call } = fakeHost()
    apply(ctx, {})
    const headers = { 'x-dsh-persona-kit': '1' }

    const created = await callApi(call, {
      method: 'POST',
      url: '/dsh-persona-kit/api/create',
      headers,
      body: { name: '码趣项目' },
    })
    assert.equal(created.status, 200)
    const id = created.body.persona.id
    assert.equal(id, '码趣项目')

    await callApi(call, {
      method: 'POST',
      url: '/dsh-persona-kit/api/bind',
      headers,
      body: { id, workspace },
    })

    const listed = await callApi(call, { url: '/dsh-persona-kit/api/list', headers })
    assert.equal(listed.body.personas.length, 1)
    assert.equal(listed.body.slotCount, SLOT_COUNT)
    assert.match(listed.body.personas[0].memoryDir, /personas/)
    assert.match(listed.body.personas[0].skillsDir, /skills$/)

    const resolved = await callApi(call, {
      url: `/dsh-persona-kit/api/resolve?cwd=${encodeURIComponent(path.join(workspace, 'src'))}`,
      headers,
    })
    assert.equal(resolved.body.persona.id, id)
  })
})

test('binding refuses a path that is not a directory', async () => {
  await withTempHome(async (home) => {
    const { ctx, call } = fakeHost()
    apply(ctx, {})
    const headers = { 'x-dsh-persona-kit': '1' }
    await callApi(call, { method: 'POST', url: '/dsh-persona-kit/api/create', headers, body: { name: '甲' } })
    const refused = await callApi(call, {
      method: 'POST',
      url: '/dsh-persona-kit/api/bind',
      headers,
      body: { id: '甲', workspace: path.join(home, 'nope') },
    })
    assert.equal(refused.status, 400)
    assert.match(refused.body.error, /目录不存在/)
  })
})

test('the app workspace list is offered for binding, with owners marked', async () => {
  await withTempHome(async (home) => {
    const alpha = path.join(home, 'alpha')
    const beta = path.join(home, 'beta')
    await mkdir(alpha, { recursive: true })
    await mkdir(beta, { recursive: true })
    await mkdir(path.join(home, 'storages'), { recursive: true })
    await writeFile(
      path.join(home, 'storages', 'workspace.json'),
      JSON.stringify({
        unit: { name: 'workspace', version: 2 },
        global: { initialized: true, workspaceIds: ['w1', 'w2'] },
        tables: {
          workspaces: {
            w1: { path: alpha, title: '甲项目', sessionIds: ['s1', 's2'] },
            w2: { path: beta, title: '乙项目', sessionIds: [] },
          },
        },
      }),
      'utf8',
    )

    const { ctx, call } = fakeHost()
    apply(ctx, {})
    const headers = { 'x-dsh-persona-kit': '1' }
    await callApi(call, { method: 'POST', url: '/dsh-persona-kit/api/create', headers, body: { name: '甲角色' } })

    const before = await callApi(call, { url: '/dsh-persona-kit/api/workspaces', headers })
    assert.equal(before.status, 200)
    assert.equal(before.body.source, 'storage')
    assert.deepEqual(before.body.workspaces.map((item) => item.title), ['甲项目', '乙项目'])
    assert.equal(before.body.workspaces[0].sessions, 2)
    assert.equal(before.body.workspaces[0].boundTo, null)

    const bound = await callApi(call, {
      method: 'POST',
      url: '/dsh-persona-kit/api/bind',
      headers,
      body: { id: '甲角色', workspaceId: 'w1' },
    })
    assert.equal(bound.status, 200)

    const after = await callApi(call, { url: '/dsh-persona-kit/api/workspaces', headers })
    assert.equal(after.body.workspaces.find((item) => item.id === 'w1').boundTo, '甲角色')
    assert.equal(after.body.workspaces.find((item) => item.id === 'w1').boundName, '甲角色')

    const unknown = await callApi(call, {
      method: 'POST',
      url: '/dsh-persona-kit/api/bind',
      headers,
      body: { id: '甲角色', workspaceId: 'nope' },
    })
    assert.equal(unknown.status, 400)
  })
})

test('beyond the persona limit, adoption is refused without touching either side', async () => {
  await withTempHome(async (home) => {
    const { ctx, call } = fakeHost()
    apply(ctx, {})
    const headers = { 'x-dsh-persona-kit': '1' }
    await callApi(call, { method: 'POST', url: '/dsh-persona-kit/api/create', headers, body: { name: '甲' } })
    await callApi(call, {
      method: 'POST',
      url: '/dsh-persona-kit/api/limits',
      headers,
      body: { id: '甲', target: 'memory', limit: 200 },
    })
    const poolFile = path.join(home, 'personas', 'default', 'memory', 'memory.md')
    await mkdir(path.dirname(poolFile), { recursive: true })
    await writeFile(poolFile, `<!-- dsh-persona-kit v1 target=memory -->\n${'长'.repeat(260)}\n`, 'utf8')
    const targetFile = path.join(home, 'personas', '甲', 'memory', 'memory.md')
    await mkdir(path.dirname(targetFile), { recursive: true })
    await writeFile(targetFile, '<!-- dsh-persona-kit v1 target=memory -->\n', 'utf8')

    const refused = await callApi(call, {
      method: 'POST',
      url: '/dsh-persona-kit/api/adopt',
      headers,
      body: { id: '甲' },
    })
    assert.equal(refused.status, 400)
    assert.equal(refused.body.tier, 'memory')
    assert.match(refused.body.error, /超出上限/)

    assert.equal(parseEntries(await readFile(poolFile, 'utf8')).length, 1)
    assert.deepEqual(parseEntries(await readFile(targetFile, 'utf8')), [])
  })
})

test('adoption merges the pool into a persona, dedupes, and empties it', async () => {
  await withTempHome(async (home) => {
    const { ctx, call } = fakeHost()
    apply(ctx, {})
    const headers = { 'x-dsh-persona-kit': '1' }
    await callApi(call, { method: 'POST', url: '/dsh-persona-kit/api/create', headers, body: { name: '甲' } })

    const poolDir = path.join(home, 'personas', 'default', 'memory')
    await mkdir(poolDir, { recursive: true })
    await writeFile(
      path.join(poolDir, 'memory.md'),
      '<!-- dsh-persona-kit v1 target=memory -->\n沙箱里的 venv 是 Low 完整性\n§\n旧 venv 在工作区外\n',
      'utf8',
    )
    await writeFile(
      path.join(poolDir, 'user.md'),
      '<!-- dsh-persona-kit v1 target=user -->\n用户用中文交流\n',
      'utf8',
    )

    const ownDir = path.join(home, 'personas', '甲', 'memory')
    await mkdir(ownDir, { recursive: true })
    await writeFile(
      path.join(ownDir, 'memory.md'),
      '<!-- dsh-persona-kit v1 target=memory -->\n沙箱里的 venv 是 Low 完整性\n',
      'utf8',
    )

    const pool = await callApi(call, { url: '/dsh-persona-kit/api/unclaimed', headers })
    assert.equal(pool.status, 200)
    assert.equal(pool.body.empty, false)
    assert.equal(pool.body.memory.entries.length, 2)
    assert.equal(pool.body.user.entries.length, 1)

    const adopted = await callApi(call, {
      method: 'POST',
      url: '/dsh-persona-kit/api/adopt',
      headers,
      body: { id: '甲' },
    })
    assert.equal(adopted.status, 200)
    assert.deepEqual(adopted.body.added, { user: 1, memory: 1 })

    assert.deepEqual(parseEntries(await readFile(path.join(ownDir, 'memory.md'), 'utf8')), [
      '沙箱里的 venv 是 Low 完整性',
      '旧 venv 在工作区外',
    ])
    assert.deepEqual(parseEntries(await readFile(path.join(ownDir, 'user.md'), 'utf8')), ['用户用中文交流'])

    const after = await callApi(call, { url: '/dsh-persona-kit/api/unclaimed', headers })
    assert.equal(after.body.empty, true)
    assert.deepEqual(parseEntries(await readFile(path.join(poolDir, 'memory.md'), 'utf8')), [])
  })
})

test('planAdoption keeps order, drops duplicates and refuses overflow', () => {
  const merged = planAdoption(['a', 'b'], ['b', 'c', 'a', '  '], 1000)
  assert.equal(merged.ok, true)
  assert.deepEqual(merged.entries, ['a', 'b', 'c'])
  assert.equal(merged.added, 1)

  const refused = planAdoption(['x'.repeat(150)], ['y'.repeat(100)], 200)
  assert.equal(refused.ok, false)
  assert.match(refused.error, /超出上限/)
  assert.equal(refused.overflow, 53)
})

test('the unclaimed bucket is editable through the panel api', async () => {
  await withTempHome(async (home) => {
    const { ctx, call } = fakeHost()
    apply(ctx, {})
    const headers = { 'x-dsh-persona-kit': '1' }

    const saved = await callApi(call, {
      method: 'POST',
      url: '/dsh-persona-kit/api/memory',
      headers,
      body: { id: 'default', target: 'memory', content: '池子条目一\n\n§\n\n池子条目二' },
    })
    assert.equal(saved.status, 200)
    assert.equal(saved.body.id, 'default')

    const file = path.join(home, 'personas', 'default', 'memory', 'memory.md')
    assert.deepEqual(parseEntries(await readFile(file, 'utf8')), ['池子条目一', '池子条目二'])

    const read = await callApi(call, { url: '/dsh-persona-kit/api/memory?id=default&target=memory', headers })
    assert.equal(read.status, 200)
    assert.equal(read.body.content, '池子条目一\n\n§\n\n池子条目二')

    const refused = await callApi(call, {
      method: 'POST',
      url: '/dsh-persona-kit/api/memory',
      headers,
      body: { id: 'nobody', target: 'memory', content: 'x' },
    })
    assert.equal(refused.status, 400)
    assert.match(refused.body.error, /没有这个角色/)
  })
})

test('the turn endpoint matches by turn number, and by seq within one step', async () => {
  await withTempHome(async (home) => {
    const { ctx, call } = fakeHost()
    apply(ctx, {})
    const headers = { 'x-dsh-persona-kit': '1' }
    await callApi(call, { method: 'POST', url: '/dsh-persona-kit/api/create', headers, body: { name: '甲' } })

    const dir = path.join(home, 'personas', '甲', 'review')
    await mkdir(dir, { recursive: true })
    const records = [
      { at: 't1', sessionId: 's1', persona: '甲', status: 'written', turn: 2, seq: 10, applied: [{ target: 'memory', count: 1 }] },
      { at: 't2', sessionId: 's1', persona: '甲', status: 'written', turn: 3, seq: 20, applied: [{ target: 'memory', count: 2 }] },
    ]
    await writeFile(dir + path.sep + 'log.jsonl', records.map((item) => JSON.stringify(item)).join('\n') + '\n', 'utf8')

    const byTurn = await callApi(call, { url: '/dsh-persona-kit/api/turn?session=s1&turn=3', headers })
    assert.equal(byTurn.status, 200)
    assert.equal(byTurn.body.turn.applied[0].count, 2)

    const bySeq = await callApi(call, { url: '/dsh-persona-kit/api/turn?session=s1&after=21', headers })
    assert.equal(bySeq.body.turn.turn, 3)

    const missing = await callApi(call, { url: '/dsh-persona-kit/api/turn?session=s1&turn=9', headers })
    assert.equal(missing.body.turn, null)

    const noSession = await callApi(call, { url: '/dsh-persona-kit/api/turn', headers })
    assert.equal(noSession.status, 400)
  })
})

test('skills can be listed and moved between personas', async () => {
  await withTempHome(async (home) => {
    const { ctx, call } = fakeHost()
    apply(ctx, {})
    const headers = { 'x-dsh-persona-kit': '1' }
    await callApi(call, { method: 'POST', url: '/dsh-persona-kit/api/create', headers, body: { name: '甲' } })
    await callApi(call, { method: 'POST', url: '/dsh-persona-kit/api/create', headers, body: { name: '乙' } })

    const dirSkill = path.join(home, 'personas', '甲', 'skills', 'alpha', 'SKILL.md')
    await mkdir(path.dirname(dirSkill), { recursive: true })
    await writeFile(dirSkill, '---\nname: alpha\ndescription: 目录式技能\n---\n\nbody\n', 'utf8')
    const flatSkill = path.join(home, 'personas', '甲', 'skills', 'beta.md')
    await writeFile(flatSkill, '---\nname: beta\ndescription: 平铺技能\n---\n', 'utf8')

    const listed = await callApi(call, { url: '/dsh-persona-kit/api/skills?id=甲', headers })
    assert.equal(listed.status, 200)
    assert.deepEqual(listed.body.skills.map((item) => item.name), ['alpha', 'beta'])
    assert.equal(listed.body.skills[0].kind, 'dir')
    assert.equal(listed.body.skills[0].description, '目录式技能')
    assert.equal(listed.body.skills[1].kind, 'flat')

    const moved = await callApi(call, {
      method: 'POST',
      url: '/dsh-persona-kit/api/skills/move',
      headers,
      body: { from: '甲', to: '乙', path: flatSkill },
    })
    assert.equal(moved.status, 200)
    assert.match(moved.body.path, /[\\/]乙[\\/]/)

    const after = await callApi(call, { url: '/dsh-persona-kit/api/skills?id=乙', headers })
    assert.deepEqual(after.body.skills.map((item) => item.name), ['beta'])

    const escape = await callApi(call, {
      method: 'POST',
      url: '/dsh-persona-kit/api/skills/move',
      headers,
      body: { from: '甲', to: '乙', path: path.join(home, 'personas', 'index.json') },
    })
    assert.equal(escape.status, 400)
    assert.match(escape.body.error, /技能目录/)

    const unknown = await callApi(call, { url: '/dsh-persona-kit/api/skills?id=nobody', headers })
    assert.equal(unknown.status, 400)
  })
})

test('memory can be read and written through the panel api', async () => {
  await withTempHome(async (home) => {
    const { ctx, call } = fakeHost()
    apply(ctx, {})
    const headers = { 'x-dsh-persona-kit': '1' }

    await callApi(call, { method: 'POST', url: '/dsh-persona-kit/api/create', headers, body: { name: '角色一' } })

    const written = await callApi(call, {
      method: 'POST',
      url: '/dsh-persona-kit/api/memory',
      headers,
      body: { id: '角色一', target: 'memory', content: '第一条\n\n§\n\n第二条' },
    })
    assert.equal(written.status, 200)
    assert.equal(written.body.usage.used > 0, true)

    const read = await callApi(call, { url: '/dsh-persona-kit/api/memory?id=角色一&target=memory', headers })
    assert.deepEqual(read.body.entries, ['第一条', '第二条'])
    assert.equal(read.body.usage.limit, 2200)

    const file = path.join(home, 'personas', '角色一', 'memory', 'memory.md')
    const text = await readFile(file, 'utf8')
    assert.match(text, /^<!-- dsh-persona-kit v1 target=memory -->/)
  })
})

test('panel api refuses an over-limit memory write', async () => {
  await withTempHome(async () => {
    const { ctx, call } = fakeHost()
    apply(ctx, {})
    const headers = { 'x-dsh-persona-kit': '1' }
    await callApi(call, { method: 'POST', url: '/dsh-persona-kit/api/create', headers, body: { name: '角色一' } })

    const result = await callApi(call, {
      method: 'POST',
      url: '/dsh-persona-kit/api/memory',
      headers,
      body: { id: '角色一', target: 'user', content: 'x'.repeat(2000) },
    })
    assert.equal(result.status, 400)
    assert.match(result.body.error, /超出上限/)
  })
})

test('review log is returned newest-last', async () => {
  await withTempHome(async (home) => {
    const { ctx, call } = fakeHost()
    apply(ctx, {})
    const headers = { 'x-dsh-persona-kit': '1' }
    await callApi(call, { method: 'POST', url: '/dsh-persona-kit/api/create', headers, body: { name: '角色一' } })

    const dir = path.join(home, 'personas', '角色一', 'review')
    await mkdir(dir, { recursive: true })
    await writeFile(
      path.join(dir, 'log.jsonl'),
      `${JSON.stringify({ at: '2026-01-01T00:00:00Z', ok: true, note: 'no-ops' })}\n`,
      'utf8',
    )

    const listed = await callApi(call, { url: '/dsh-persona-kit/api/review?id=角色一&limit=10', headers })
    assert.equal(listed.body.records.length, 1)
    assert.equal(listed.body.records[0].note, 'no-ops')
  })
})

test('each persona can carry its own memory limit', async () => {
  await withTempHome(async () => {
    const { ctx, call } = fakeHost()
    apply(ctx, {})
    const headers = { 'x-dsh-persona-kit': '1' }
    await callApi(call, { method: 'POST', url: '/dsh-persona-kit/api/create', headers, body: { name: '角色一' } })

    const before = await callApi(call, { url: '/dsh-persona-kit/api/memory?id=角色一&target=user', headers })
    assert.equal(before.body.usage.limit, 1375)

    const changed = await callApi(call, {
      method: 'POST',
      url: '/dsh-persona-kit/api/limits',
      headers,
      body: { id: '角色一', target: 'user', limit: 300 },
    })
    assert.equal(changed.status, 200)
    assert.equal(changed.body.limits.user, 300)

    const after = await callApi(call, { url: '/dsh-persona-kit/api/memory?id=角色一&target=user', headers })
    assert.equal(after.body.usage.limit, 300)

    const tooBig = await callApi(call, {
      method: 'POST',
      url: '/dsh-persona-kit/api/memory',
      headers,
      body: { id: '角色一', target: 'user', content: 'x'.repeat(400) },
    })
    assert.equal(tooBig.status, 400)
    assert.match(tooBig.body.error, /超出上限：400\/300/)
  })
})

test('a limit outside the sane range is refused', async () => {
  await withTempHome(async () => {
    const { ctx, call } = fakeHost()
    apply(ctx, {})
    const headers = { 'x-dsh-persona-kit': '1' }
    await callApi(call, { method: 'POST', url: '/dsh-persona-kit/api/create', headers, body: { name: '角色一' } })
    const bad = await callApi(call, {
      method: 'POST',
      url: '/dsh-persona-kit/api/limits',
      headers,
      body: { id: '角色一', target: 'user', limit: 50 },
    })
    assert.equal(bad.status, 400)
    assert.match(bad.body.error, /200–20000/)
  })
})

test('a session id resolves its persona through the cached workspace path', async () => {
  await withTempHome(async (home) => {
    const { ctx, call } = fakeHost()
    apply(ctx, {})
    const headers = { 'x-dsh-persona-kit': '1' }
    await callApi(call, { method: 'POST', url: '/dsh-persona-kit/api/create', headers, body: { name: '甲' } })
    await callApi(call, { method: 'POST', url: '/dsh-persona-kit/api/bind', headers, body: { id: '甲', workspace: home } })

    const dir = path.join(home, 'storages', 'session_projcache', 'sessions')
    await mkdir(dir, { recursive: true })
    await writeFile(
      path.join(dir, 'session-abc.json'),
      JSON.stringify({ version: 1, record: { identity: { cwd: home }, rows: {} } }),
      'utf8',
    )

    const resolved = await callApi(call, { url: '/dsh-persona-kit/api/resolve?session=session-abc', headers })
    assert.equal(resolved.status, 200)
    assert.equal(resolved.body.cwd, home)
    assert.equal(resolved.body.persona.id, '甲')

    const missing = await callApi(call, { url: '/dsh-persona-kit/api/resolve?session=../evil', headers })
    assert.equal(missing.body.persona, null)
  })
})
test('topics can be written through the panel api, and stats reports them', async () => {
  await withTempHome(async (home) => {
    const { ctx, call } = fakeHost()
    apply(ctx, {})
    const headers = { 'x-dsh-persona-kit': '1' }
    await callApi(call, { method: 'POST', url: '/dsh-persona-kit/api/create', headers, body: { name: '甲' } })

    const written = await callApi(call, {
      method: 'POST',
      url: '/dsh-persona-kit/api/topics',
      headers,
      body: { id: '甲', slug: 'printer', summary: '打印机排查', content: '现象：队列为空' },
    })
    assert.equal(written.status, 200)
    assert.equal(written.body.slug, 'printer')

    const stats = await callApi(call, { url: '/dsh-persona-kit/api/memory/stats?id=甲', headers })
    assert.equal(stats.status, 200)
    assert.equal(stats.body.topics.count, 1)
    assert.equal(typeof stats.body.resident.memory.used, 'number')
    assert.equal(typeof stats.body.drift.rebuilt, 'boolean')

    const manifestPath = path.join(home, 'personas', '甲', 'memory', 'index', 'manifest.json')
    await rm(manifestPath, { force: true })
    const healed = await callApi(call, { url: '/dsh-persona-kit/api/memory/stats?id=甲', headers })
    assert.equal(healed.body.drift.rebuilt, true)

    const manifest = path.join(home, 'personas', '甲', 'memory', 'index', 'manifest.json')
    assert.match(await readFile(manifest, 'utf8'), /printer/)
  })
})
test('history lists what was invalidated or expired, and can show everything', async () => {
  await withTempHome(async (home) => {
    const { ctx, call } = fakeHost()
    apply(ctx, {})
    const headers = { 'x-dsh-persona-kit': '1' }
    await callApi(call, { method: 'POST', url: '/dsh-persona-kit/api/create', headers, body: { name: '甲' } })

    const dir = path.join(home, 'personas', '甲', 'memory')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'memory.md'), '<!-- dsh-persona-kit v1 target=memory -->\n仍然有效的条目\n', 'utf8')
    const { entryHash, refreshMeta } = await import('../lib/store.js')
    const oldHash = entryHash('被推翻的旧事实')
    await writeFile(
      path.join(dir, 'meta.json'),
      JSON.stringify({ version: 2, entries: { [oldHash]: { target: 'memory', status: 'active', preview: '被推翻的旧事实' } } }),
      'utf8',
    )
    await refreshMeta('甲', { at: new Date().toISOString(), superseded: { [oldHash]: entryHash('仍然有效的条目') } })

    const hidden = await callApi(call, { url: '/dsh-persona-kit/api/memory/history?id=甲', headers })
    assert.equal(hidden.status, 200)
    assert.equal(hidden.body.count, 1)
    assert.equal(hidden.body.entries[0].status, 'superseded')
    assert.ok(hidden.body.entries[0].supersededBy)

    const all = await callApi(call, { url: '/dsh-persona-kit/api/memory/history?id=甲&show=all', headers })
    assert.equal(all.body.count, 2)
  })
})