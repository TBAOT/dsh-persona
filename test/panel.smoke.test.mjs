import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * Render smoke test for the client panel.
 *
 * The panel is plain `h()` calls, so it can be rendered with a stubbed React and no
 * DOM. This exists because a moved `const` (used by the tab row but declared lower in
 * the component) shipped a **blank panel**: `node --check` passed, tests passed, and
 * the first person to refresh saw nothing. Rendering once turns that class of mistake
 * into a failing test.
 */
function stubReact() {
  const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children })
  return {
    Fragment: 'Fragment',
    createElement,
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (init) => ({ current: init }),
  }
}

function loadPanel() {
  let factory = null
  globalThis.window = {
    __ModuleLoader__: {
      load(module) {
        factory = module.factory
      },
    },
  }
  const require = (name) => {
    if (name === 'react') return stubReact()
    throw new Error(`unexpected require: ${name}`)
  }
  return import('../lib/client/panel.js').then(() => (factory ? factory(require) : null))
}

test('the panel renders once without throwing', async () => {
  const plugin = await loadPanel()
  assert.ok(plugin && typeof plugin.apply === 'function', '面板模块必须导出 apply')

  const registered = []
  const ctx = {
    slots: {
      inject: (name, register) => register(),
      register: (slot, component) => {
        registered.push({ slot, component })
        return () => {}
      },
    },
  }
  plugin.apply(ctx)

  const main = registered.find((entry) => entry.slot?.name === 'main')
  assert.ok(main, '主面板必须注册到 main slot')

  // Render with empty props: this is where a hoisting/TDZ mistake surfaces.
  const tree = main.component({})
  assert.ok(tree, '渲染结果不能为空')
})
