import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
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

test('creating a persona allocates the next free slot', () => {
  const first = createPersona(empty(), { name: '码趣项目' })
  assert.equal(first.ok, true)
  assert.equal(first.persona.id, 'slot-1')
  assert.equal(first.persona.presetId, 'persona-slot-1')
  const second = createPersona(first.index, { name: '另一个' })
  assert.equal(second.persona.id, 'slot-2')
})

test('slots run out at the declared count', () => {
  let index = empty()
  for (let slot = 1; slot <= SLOT_COUNT; slot += 1) {
    const result = createPersona(index, { name: `角色${slot}` })
    assert.equal(result.ok, true)
    index = result.index
  }
  const overflow = createPersona(index, { name: '多余' })
  assert.equal(overflow.ok, false)
  assert.match(overflow.error, /用满/)
})

test('an explicitly requested slot is honoured and cannot be taken twice', () => {
  const first = createPersona(empty(), { name: 'A', slot: 3 })
  assert.equal(first.persona.id, 'slot-3')
  const clash = createPersona(first.index, { name: 'B', slot: 3 })
  assert.equal(clash.ok, false)
  assert.match(clash.error, /已被占用/)
})

test('workspace binding resolves nested cwd, case and slash form', () => {
  let index = createPersona(empty(), { name: 'Work' }).index
  index = bindWorkspace(index, 'slot-1', 'C:\\A\\work\\proj').index
  assert.equal(resolvePersonaForCwd(index, 'C:\\A\\work\\proj\\src')?.id, 'slot-1')
  assert.equal(resolvePersonaForCwd(index, 'c:/a/WORK/proj/sub')?.id, 'slot-1')
  assert.equal(resolvePersonaForCwd(index, 'C:\\A\\work\\other'), undefined)
})

test('the most specific workspace wins', () => {
  let index = createPersona(empty(), { name: 'Outer' }).index
  index = createPersona(index, { name: 'Inner' }).index
  index = bindWorkspace(index, 'slot-1', 'C:\\A\\work').index
  index = bindWorkspace(index, 'slot-2', 'C:\\A\\work\\deep').index
  assert.equal(resolvePersonaForCwd(index, 'C:\\A\\work\\deep\\plugins')?.id, 'slot-2')
  assert.equal(resolvePersonaForCwd(index, 'C:\\A\\work\\other')?.id, 'slot-1')
})

test('rebinding a workspace moves it off the previous persona', () => {
  let index = createPersona(empty(), { name: 'A' }).index
  index = createPersona(index, { name: 'B' }).index
  index = bindWorkspace(index, 'slot-1', 'C:\\proj').index
  index = bindWorkspace(index, 'slot-2', 'C:\\proj').index
  assert.deepEqual(index.personas.find((entry) => entry.id === 'slot-1').workspaces, [])
  assert.deepEqual(index.personas.find((entry) => entry.id === 'slot-2').workspaces, ['C:\\proj'])
})

test('unbind, update and delete', () => {
  let index = createPersona(empty(), { name: 'A' }).index
  index = bindWorkspace(index, 'slot-1', 'C:\\proj').index
  index = unbindWorkspace(index, 'slot-1', 'c:/proj').index
  assert.deepEqual(index.personas[0].workspaces, [])
  index = updatePersona(index, 'slot-1', { name: '改名后' }).index
  assert.equal(index.personas[0].name, '改名后')
  index = updatePersona(index, 'slot-1', { homeSessionId: 'session-1' }).index
  assert.equal(index.personas[0].homeSessionId, 'session-1')
  index = deletePersona(index, 'slot-1').index
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
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-persona-roster-'))
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
    const result = await callApi(call, { url: '/dsh-persona/api/list' })
    assert.equal(result.status, 403)
  })
})

test('api creates, lists and resolves personas', async () => {
  await withTempHome(async (home) => {
    const workspace = path.join(home, 'proj')
    await mkdir(workspace, { recursive: true })
    const { ctx, call } = fakeHost()
    apply(ctx, {})
    const headers = { 'x-dsh-persona': '1' }

    const created = await callApi(call, {
      method: 'POST',
      url: '/dsh-persona/api/create',
      headers,
      body: { name: '码趣项目' },
    })
    assert.equal(created.status, 200)
    const id = created.body.persona.id
    assert.equal(id, 'slot-1')

    await callApi(call, {
      method: 'POST',
      url: '/dsh-persona/api/bind',
      headers,
      body: { id, workspace },
    })

    const listed = await callApi(call, { url: '/dsh-persona/api/list', headers })
    assert.equal(listed.body.personas.length, 1)
    assert.equal(listed.body.slotCount, SLOT_COUNT)
    assert.match(listed.body.personas[0].memoryDir, /personas/)
    assert.match(listed.body.personas[0].skillsDir, /skills$/)

    const resolved = await callApi(call, {
      url: `/dsh-persona/api/resolve?cwd=${encodeURIComponent(path.join(workspace, 'src'))}`,
      headers,
    })
    assert.equal(resolved.body.persona.id, id)
  })
})

test('binding refuses a path that is not a directory', async () => {
  await withTempHome(async (home) => {
    const { ctx, call } = fakeHost()
    apply(ctx, {})
    const headers = { 'x-dsh-persona': '1' }
    await callApi(call, { method: 'POST', url: '/dsh-persona/api/create', headers, body: { name: '甲' } })
    const refused = await callApi(call, {
      method: 'POST',
      url: '/dsh-persona/api/bind',
      headers,
      body: { id: 'slot-1', workspace: path.join(home, 'nope') },
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
    const headers = { 'x-dsh-persona': '1' }
    await callApi(call, { method: 'POST', url: '/dsh-persona/api/create', headers, body: { name: '甲角色' } })

    const before = await callApi(call, { url: '/dsh-persona/api/workspaces', headers })
    assert.equal(before.status, 200)
    assert.equal(before.body.source, 'storage')
    assert.deepEqual(before.body.workspaces.map((item) => item.title), ['甲项目', '乙项目'])
    assert.equal(before.body.workspaces[0].sessions, 2)
    assert.equal(before.body.workspaces[0].boundTo, null)

    const bound = await callApi(call, {
      method: 'POST',
      url: '/dsh-persona/api/bind',
      headers,
      body: { id: 'slot-1', workspaceId: 'w1' },
    })
    assert.equal(bound.status, 200)

    const after = await callApi(call, { url: '/dsh-persona/api/workspaces', headers })
    assert.equal(after.body.workspaces.find((item) => item.id === 'w1').boundTo, 'slot-1')
    assert.equal(after.body.workspaces.find((item) => item.id === 'w1').boundName, '甲角色')

    const unknown = await callApi(call, {
      method: 'POST',
      url: '/dsh-persona/api/bind',
      headers,
      body: { id: 'slot-1', workspaceId: 'nope' },
    })
    assert.equal(unknown.status, 400)
  })
})

test('beyond the persona limit, adoption is refused without touching either side', async () => {
  await withTempHome(async (home) => {
    const { ctx, call } = fakeHost()
    apply(ctx, {})
    const headers = { 'x-dsh-persona': '1' }
    await callApi(call, { method: 'POST', url: '/dsh-persona/api/create', headers, body: { name: '甲' } })
    await callApi(call, {
      method: 'POST',
      url: '/dsh-persona/api/limits',
      headers,
      body: { id: 'slot-1', target: 'memory', limit: 200 },
    })
    const poolFile = path.join(home, 'personas', 'default', 'memory', 'memory.md')
    await mkdir(path.dirname(poolFile), { recursive: true })
    await writeFile(poolFile, `<!-- dsh-persona v1 target=memory -->\n${'长'.repeat(260)}\n`, 'utf8')
    const targetFile = path.join(home, 'personas', 'slot-1', 'memory', 'memory.md')
    await mkdir(path.dirname(targetFile), { recursive: true })
    await writeFile(targetFile, '<!-- dsh-persona v1 target=memory -->\n', 'utf8')

    const refused = await callApi(call, {
      method: 'POST',
      url: '/dsh-persona/api/adopt',
      headers,
      body: { id: 'slot-1' },
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
    const headers = { 'x-dsh-persona': '1' }
    await callApi(call, { method: 'POST', url: '/dsh-persona/api/create', headers, body: { name: '甲' } })

    const poolDir = path.join(home, 'personas', 'default', 'memory')
    await mkdir(poolDir, { recursive: true })
    await writeFile(
      path.join(poolDir, 'memory.md'),
      '<!-- dsh-persona v1 target=memory -->\n沙箱里的 venv 是 Low 完整性\n§\n旧 venv 在工作区外\n',
      'utf8',
    )
    await writeFile(
      path.join(poolDir, 'user.md'),
      '<!-- dsh-persona v1 target=user -->\n用户用中文交流\n',
      'utf8',
    )

    const ownDir = path.join(home, 'personas', 'slot-1', 'memory')
    await mkdir(ownDir, { recursive: true })
    await writeFile(
      path.join(ownDir, 'memory.md'),
      '<!-- dsh-persona v1 target=memory -->\n沙箱里的 venv 是 Low 完整性\n',
      'utf8',
    )

    const pool = await callApi(call, { url: '/dsh-persona/api/unclaimed', headers })
    assert.equal(pool.status, 200)
    assert.equal(pool.body.empty, false)
    assert.equal(pool.body.memory.entries.length, 2)
    assert.equal(pool.body.user.entries.length, 1)

    const adopted = await callApi(call, {
      method: 'POST',
      url: '/dsh-persona/api/adopt',
      headers,
      body: { id: 'slot-1' },
    })
    assert.equal(adopted.status, 200)
    assert.deepEqual(adopted.body.added, { user: 1, memory: 1 })

    assert.deepEqual(parseEntries(await readFile(path.join(ownDir, 'memory.md'), 'utf8')), [
      '沙箱里的 venv 是 Low 完整性',
      '旧 venv 在工作区外',
    ])
    assert.deepEqual(parseEntries(await readFile(path.join(ownDir, 'user.md'), 'utf8')), ['用户用中文交流'])

    const after = await callApi(call, { url: '/dsh-persona/api/unclaimed', headers })
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

test('memory can be read and written through the panel api', async () => {
  await withTempHome(async (home) => {
    const { ctx, call } = fakeHost()
    apply(ctx, {})
    const headers = { 'x-dsh-persona': '1' }

    await callApi(call, { method: 'POST', url: '/dsh-persona/api/create', headers, body: { name: '角色一' } })

    const written = await callApi(call, {
      method: 'POST',
      url: '/dsh-persona/api/memory',
      headers,
      body: { id: 'slot-1', target: 'memory', content: '第一条\n\n§\n\n第二条' },
    })
    assert.equal(written.status, 200)
    assert.equal(written.body.usage.used > 0, true)

    const read = await callApi(call, { url: '/dsh-persona/api/memory?id=slot-1&target=memory', headers })
    assert.deepEqual(read.body.entries, ['第一条', '第二条'])
    assert.equal(read.body.usage.limit, 2200)

    const file = path.join(home, 'personas', 'slot-1', 'memory', 'memory.md')
    const text = await readFile(file, 'utf8')
    assert.match(text, /^<!-- dsh-persona v1 target=memory -->/)
  })
})

test('panel api refuses an over-limit memory write', async () => {
  await withTempHome(async () => {
    const { ctx, call } = fakeHost()
    apply(ctx, {})
    const headers = { 'x-dsh-persona': '1' }
    await callApi(call, { method: 'POST', url: '/dsh-persona/api/create', headers, body: { name: '角色一' } })

    const result = await callApi(call, {
      method: 'POST',
      url: '/dsh-persona/api/memory',
      headers,
      body: { id: 'slot-1', target: 'user', content: 'x'.repeat(2000) },
    })
    assert.equal(result.status, 400)
    assert.match(result.body.error, /超出上限/)
  })
})

test('review log is returned newest-last', async () => {
  await withTempHome(async (home) => {
    const { ctx, call } = fakeHost()
    apply(ctx, {})
    const headers = { 'x-dsh-persona': '1' }
    await callApi(call, { method: 'POST', url: '/dsh-persona/api/create', headers, body: { name: '角色一' } })

    const dir = path.join(home, 'personas', 'slot-1', 'review')
    await mkdir(dir, { recursive: true })
    await writeFile(
      path.join(dir, 'log.jsonl'),
      `${JSON.stringify({ at: '2026-01-01T00:00:00Z', ok: true, note: 'no-ops' })}\n`,
      'utf8',
    )

    const listed = await callApi(call, { url: '/dsh-persona/api/review?id=slot-1&limit=10', headers })
    assert.equal(listed.body.records.length, 1)
    assert.equal(listed.body.records[0].note, 'no-ops')
  })
})

test('each persona can carry its own memory limit', async () => {
  await withTempHome(async () => {
    const { ctx, call } = fakeHost()
    apply(ctx, {})
    const headers = { 'x-dsh-persona': '1' }
    await callApi(call, { method: 'POST', url: '/dsh-persona/api/create', headers, body: { name: '角色一' } })

    const before = await callApi(call, { url: '/dsh-persona/api/memory?id=slot-1&target=user', headers })
    assert.equal(before.body.usage.limit, 1375)

    const changed = await callApi(call, {
      method: 'POST',
      url: '/dsh-persona/api/limits',
      headers,
      body: { id: 'slot-1', target: 'user', limit: 300 },
    })
    assert.equal(changed.status, 200)
    assert.equal(changed.body.limits.user, 300)

    const after = await callApi(call, { url: '/dsh-persona/api/memory?id=slot-1&target=user', headers })
    assert.equal(after.body.usage.limit, 300)

    const tooBig = await callApi(call, {
      method: 'POST',
      url: '/dsh-persona/api/memory',
      headers,
      body: { id: 'slot-1', target: 'user', content: 'x'.repeat(400) },
    })
    assert.equal(tooBig.status, 400)
    assert.match(tooBig.body.error, /超出上限：400\/300/)
  })
})

test('a limit outside the sane range is refused', async () => {
  await withTempHome(async () => {
    const { ctx, call } = fakeHost()
    apply(ctx, {})
    const headers = { 'x-dsh-persona': '1' }
    await callApi(call, { method: 'POST', url: '/dsh-persona/api/create', headers, body: { name: '角色一' } })
    const bad = await callApi(call, {
      method: 'POST',
      url: '/dsh-persona/api/limits',
      headers,
      body: { id: 'slot-1', target: 'user', limit: 50 },
    })
    assert.equal(bad.status, 400)
    assert.match(bad.body.error, /200–20000/)
  })
})
