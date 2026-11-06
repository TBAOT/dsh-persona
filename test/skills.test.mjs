import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { apply, parseFrontmatter, readPersonaSkills, renderSkillIndex } from '../lib/skills.js'

test('frontmatter is parsed and the body kept', () => {
  const text = ['---', 'name: sql-review', 'description: 审 SQL', 'whenToUse: 改数据库前', '---', '', '# 正文'].join('\n')
  const { meta, body } = parseFrontmatter(text)
  assert.equal(meta.name, 'sql-review')
  assert.equal(meta.description, '审 SQL')
  assert.match(body, /# 正文/)
})

test('text without frontmatter is left alone', () => {
  const { meta, body } = parseFrontmatter('# 只有正文')
  assert.deepEqual(meta, {})
  assert.equal(body, '# 只有正文')
})

async function withTempHome(fn) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-persona-skills-'))
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

test('private skills are read from the persona directory only', async () => {
  await withTempHome(async (home) => {
    const dir = path.join(home, 'personas', 'slot-1', 'skills')
    await mkdir(path.join(dir, 'sql-review'), { recursive: true })
    await writeFile(
      path.join(dir, 'sql-review', 'SKILL.md'),
      ['---', 'name: sql-review', 'description: 审 SQL', '---', '', '正文'].join('\n'),
      'utf8',
    )
    await writeFile(path.join(dir, 'flat.md'), ['---', 'name: flat-skill', 'description: 平铺', '---'].join('\n'), 'utf8')
    await mkdir(path.join(home, 'personas', 'slot-2', 'skills'), { recursive: true })

    const one = await readPersonaSkills('slot-1', process.env)
    assert.deepEqual(
      one.map((skill) => skill.name),
      ['flat-skill', 'sql-review'],
    )
    const two = await readPersonaSkills('slot-2', process.env)
    assert.deepEqual(two, [])
  })
})

test('the rendered index lists name, description and path', () => {
  const block = renderSkillIndex([
    { name: 'sql-review', description: '审 SQL', whenToUse: '改库前', path: 'C:\\x\\SKILL.md' },
  ])
  assert.match(block, /本角色私有技能/)
  assert.match(block, /sql-review/)
  assert.match(block, /改库前/)
  assert.match(block, /C:\\x\\SKILL\.md/)
})

test('empty list renders nothing', () => {
  assert.equal(renderSkillIndex([]), '')
})

test('the prompt section is per agent', async () => {
  await withTempHome(async (home) => {
    const dir = path.join(home, 'personas', 'default', 'skills')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'only-for-default.md'), ['---', 'name: only-for-default', '---'].join('\n'), 'utf8')

    const sections = new Map()
    const listeners = new Map()
    const ctx = {
      logger: { warn() {}, info() {} },
      on(event, handler) {
        if (!listeners.has(event)) listeners.set(event, [])
        listeners.get(event).push(handler)
      },
      effect(fn) {
        fn()
        return () => {}
      },
      systemPrompt: {
        section(section) {
          sections.set(section.name, section)
          return () => {}
        },
      },
    }
    apply(ctx, {})
    const agent = { id: 's1', session: { header: { cwd: '' } } }
    listeners.get('agent/created').forEach((handler) => handler({ agent }))
    await new Promise((resolve) => setTimeout(resolve, 30))

    const section = sections.get('persona:skills')
    assert.match(section.text({ agent }), /only-for-default/)
    assert.equal(section.text({ agent: { id: 'other' } }), '')

    listeners.get('agent/disposed').forEach((handler) => handler({ agent }))
    assert.equal(section.text({ agent }), '')
  })
})
