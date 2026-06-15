<script setup>
import { ref, reactive, provide, watch, computed, nextTick, onMounted, onBeforeUnmount } from 'vue'
import SplitNode from './components/SplitNode.vue'
import TaskBoard from './components/TaskBoard.vue'
import { dropBuffer } from './ptyStore'
import { tasks as boardTasks, setTasks, updateTask } from './taskBoardStore'

const shells = ref([])
const agents = ref([])
const selectedShell = ref(null)
const tree = ref(null)
const broadcast = ref(false)
const activeId = ref(null)
const initError = ref('')
const gridMenuOpen = ref(false)
const shellMenuOpen = ref(false)
const agentMenuOpen = ref(false)

const gridOptions = [
  { value: '1x2', label: '1 x 2' },
  { value: '2x1', label: '2 x 1' },
  { value: '2x2', label: '2 x 2' },
  { value: '3x2', label: '3 x 2' },
  { value: '3x3', label: '3 x 3' }
]

let counter = 0
function newId(prefix) {
  counter += 1
  return `${prefix}-${counter}-${Math.floor(Math.random() * 1e6)}`
}

async function createLeaf(shellId, agent = null) {
  const id = newId('pane')
  const res = await window.shellApi.createPty({ id, shellId, cols: 80, rows: 24 })
  if (!res || !res.ok) {
    initError.value = (res && res.error) || 'Failed to create terminal.'
    return null
  }
  const leaf = reactive({
    type: 'leaf',
    id,
    shellId: res.shell.id,
    shellName: res.shell.name,
    title: agent ? agent.name : res.shell.name,
    kind: agent ? 'agent' : 'shell',
    agentId: agent ? agent.id : null,
    agentCommand: agent ? agent.command : null,
    accent: agent ? agent.accent : null,
    backend: res.backend || 'winpty',
    windowsBuild: res.windowsBuild,
    pid: res.pid,
    broadcast: true
  })
  // Launch the agent CLI once the shell has had a moment to print its prompt.
  if (agent && agent.command) {
    setTimeout(() => window.shellApi.writePty(id, `${agent.command}\r`), 600)
  }
  return leaf
}

function replaceNode(node, targetId, make) {
  if (node.type === 'leaf') return node.id === targetId ? make(node) : node
  return {
    ...node,
    children: node.children.map((c) => replaceNode(c, targetId, make))
  }
}

function removeLeaf(node, targetId) {
  if (node.type === 'leaf') return node.id === targetId ? null : node
  const kids = node.children.map((c) => removeLeaf(c, targetId)).filter(Boolean)
  if (kids.length === 0) return null
  if (kids.length === 1) return kids[0]
  return { ...node, children: kids }
}

function forEachLeaf(node, fn) {
  if (!node) return
  if (node.type === 'leaf') fn(node)
  else node.children.forEach((c) => forEachLeaf(c, fn))
}

function firstLeafId(node) {
  if (!node) return null
  if (node.type === 'leaf') return node.id
  for (const c of node.children) {
    const id = firstLeafId(c)
    if (id) return id
  }
  return null
}

// --- Workspace persistence -------------------------------------------------
// Serialize the live tree into a plain snapshot (no PTYs / pids / runtime ids).
function serializeNode(node) {
  if (!node) return null
  if (node.type === 'leaf') {
    return {
      type: 'leaf',
      shellId: node.shellId,
      title: node.title,
      broadcast: node.broadcast !== false,
      kind: node.kind || 'shell',
      agentId: node.agentId || null,
      agentCommand: node.agentCommand || null,
      accent: node.accent || null
    }
  }
  return {
    type: 'split',
    dir: node.dir,
    sizes: node.sizes.slice(),
    children: node.children.map(serializeNode)
  }
}

// Rebuild a live tree from a snapshot, spawning a fresh PTY per leaf.
async function deserializeNode(snap) {
  if (!snap) return null
  if (snap.type === 'leaf') {
    const agent =
      snap.kind === 'agent' && snap.agentCommand
        ? {
            id: snap.agentId,
            name: snap.title || snap.agentId,
            command: snap.agentCommand,
            accent: snap.accent
          }
        : null
    const leaf = await createLeaf(snap.shellId, agent)
    if (!leaf) return null
    if (snap.title) leaf.title = snap.title
    leaf.broadcast = snap.broadcast !== false
    return leaf
  }
  const children = []
  for (const child of snap.children || []) {
    const built = await deserializeNode(child)
    if (built) children.push(built)
  }
  if (!children.length) return null
  if (children.length === 1) return children[0]
  const sizes =
    Array.isArray(snap.sizes) && snap.sizes.length === children.length
      ? snap.sizes.slice()
      : children.map(() => 100 / children.length)
  return reactive({ type: 'split', id: newId('split'), dir: snap.dir, sizes, children })
}

let persistReady = false
let saveTimer = null
function scheduleSave() {
  if (!persistReady) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    if (!tree.value) return
    window.shellApi.saveLayout({
      version: 1,
      selectedShell: selectedShell.value,
      broadcast: broadcast.value,
      tree: serializeNode(tree.value)
    })
  }, 500)
}

async function splitLeaf(leafId, dir, agent = null) {
  const leaf = await createLeaf(selectedShell.value, agent)
  if (!leaf) return
  tree.value = replaceNode(tree.value, leafId, (orig) =>
    reactive({
      type: 'split',
      id: newId('split'),
      dir,
      sizes: [50, 50],
      children: [orig, leaf]
    })
  )
  activeId.value = leaf.id
}

function closeLeaf(leafId) {
  window.shellApi.killPty(leafId)
  dropBuffer(leafId)
  const next = removeLeaf(tree.value, leafId)
  if (next) {
    tree.value = next
    if (activeId.value === leafId) activeId.value = firstLeafId(next)
  } else {
    createLeaf(selectedShell.value).then((leaf) => {
      if (leaf) {
        tree.value = leaf
        activeId.value = leaf.id
      }
    })
  }
}

async function buildGrid(cols, rows) {
  const oldIds = []
  forEachLeaf(tree.value, (leaf) => oldIds.push(leaf.id))

  const rowNodes = []
  for (let r = 0; r < rows; r++) {
    const leaves = []
    for (let c = 0; c < cols; c++) {
      const leaf = await createLeaf(selectedShell.value)
      if (leaf) leaves.push(leaf)
    }
    if (!leaves.length) continue
    rowNodes.push(
      reactive({
        type: 'split',
        id: newId('split'),
        dir: 'row',
        sizes: leaves.map(() => 100 / leaves.length),
        children: leaves
      })
    )
  }
  if (!rowNodes.length) return

  const root =
    rowNodes.length === 1
      ? rowNodes[0]
      : reactive({
          type: 'split',
          id: newId('split'),
          dir: 'col',
          sizes: rowNodes.map(() => 100 / rowNodes.length),
          children: rowNodes
        })

  tree.value = root
  activeId.value = firstLeafId(root)

  oldIds.forEach((id) => {
    window.shellApi.killPty(id)
    dropBuffer(id)
  })
}

function routeInput(sourceId, data) {
  if (broadcast.value) {
    forEachLeaf(tree.value, (leaf) => {
      if (leaf.broadcast) window.shellApi.writePty(leaf.id, data)
    })
  } else {
    window.shellApi.writePty(sourceId, data)
  }
}

function setActive(id) {
  activeId.value = id
}

const maximizedId = ref(null)

function toggleMaximize(id) {
  maximizedId.value = maximizedId.value === id ? null : id
}

// --- Agent Task Board (kanban side panel) ----------------------------------
const taskPanelOpen = ref(false)

// Live list of agent panes, handed to the board so a task can be assigned to
// one. Walks the same tree the terminals render from, so it recomputes only when
// the tree structure or a pane title/accent changes.
const agentPanes = computed(() => {
  const out = []
  forEachLeaf(tree.value, (leaf) => {
    if (leaf.kind === 'agent') {
      out.push({ id: leaf.id, title: leaf.title, agentId: leaf.agentId, accent: leaf.accent })
    }
  })
  return out
})

function toggleTaskPanel() {
  taskPanelOpen.value = !taskPanelOpen.value
  // Opening/closing the panel changes the terminal area's width — nudge panes to
  // refit with the same event SplitNode dispatches on a divider drag.
  nextTick(() => window.dispatchEvent(new Event('terminal-layout-change')))
}

// Pane ids are re-minted on every launch (serializeNode drops the id;
// deserializeNode spawns fresh PTYs with new ids), so a persisted task.paneId
// from a previous session points at a pane that no longer exists. After
// hydrating, null any assignment whose pane isn't in the live tree so the board
// never shows a task pinned to a dead pane.
function reconcileTaskPanes() {
  const liveIds = new Set()
  forEachLeaf(tree.value, (leaf) => liveIds.add(leaf.id))
  for (const task of boardTasks) {
    if (task.paneId && !liveIds.has(task.paneId)) updateTask(task.id, { paneId: null })
  }
}

// Debounced task persistence — mirrors scheduleSave() for the workspace layout,
// but targets B2's separate taskboard store. Snapshot to plain objects so the
// Vue reactive proxy is stripped before the IPC structured clone.
let taskSaveTimer = null
function scheduleTaskSave() {
  if (taskSaveTimer) clearTimeout(taskSaveTimer)
  taskSaveTimer = setTimeout(() => {
    taskSaveTimer = null
    window.shellApi.taskBoard.save(boardTasks.map((t) => ({ ...t })))
  }, 500)
}

provide('panelCtx', {
  broadcast,
  activeId,
  maximizedId,
  shells,
  selectedShell,
  routeInput,
  splitLeaf,
  closeLeaf,
  setActive,
  toggleMaximize
})

function splitActive(dir) {
  if (activeId.value) splitLeaf(activeId.value, dir)
}

function closeActive() {
  if (activeId.value) closeLeaf(activeId.value)
}

function toggleBroadcast() {
  broadcast.value = !broadcast.value
}

function applyGrid(v) {
  if (!v) return
  const [cols, rows] = v.split('x').map(Number)
  closeMenus()
  buildGrid(cols, rows)
}

function selectShell(id) {
  selectedShell.value = id
  closeMenus()
}

function toggleGridMenu() {
  shellMenuOpen.value = false
  agentMenuOpen.value = false
  gridMenuOpen.value = !gridMenuOpen.value
}

function toggleShellMenu() {
  gridMenuOpen.value = false
  agentMenuOpen.value = false
  shellMenuOpen.value = !shellMenuOpen.value
}

function toggleAgentMenu() {
  gridMenuOpen.value = false
  shellMenuOpen.value = false
  agentMenuOpen.value = !agentMenuOpen.value
}

function launchAgent(agent) {
  if (!agent || agent.available === false) return
  closeMenus()
  if (activeId.value) {
    splitLeaf(activeId.value, 'row', agent)
  } else {
    createLeaf(selectedShell.value, agent).then((leaf) => {
      if (leaf) {
        tree.value = leaf
        activeId.value = leaf.id
      }
    })
  }
}

function closeMenus() {
  gridMenuOpen.value = false
  shellMenuOpen.value = false
  agentMenuOpen.value = false
}

function onDocPointerDown(e) {
  if (e.target.closest('.toolbar-group') || e.target.closest('.toolbar-menu')) return
  closeMenus()
}

function selectedShellName() {
  return shells.value.find((shell) => shell.id === selectedShell.value)?.name || 'Shell'
}

function onKey(e) {
  if (e.ctrlKey && e.shiftKey) {
    const k = e.key.toLowerCase()
    if (k === 'e') {
      e.preventDefault()
      splitActive('row')
    } else if (k === 'o') {
      e.preventDefault()
      splitActive('col')
    } else if (k === 'w') {
      e.preventDefault()
      closeActive()
    } else if (k === 'b') {
      e.preventDefault()
      toggleBroadcast()
    } else if (k === 'k') {
      e.preventDefault()
      toggleTaskPanel()
    }
  }
  if (e.key === 'Escape') {
    // Escape always restores a maximized pane — a safety net so a maximized
    // pane can never become a dead-end if its Restore button is obscured.
    if (maximizedId.value) maximizedId.value = null
    closeMenus()
  }
}

async function restoreOrSeedLayout() {
  const def = shells.value.find((s) => s.id === 'powershell') || shells.value[0]
  selectedShell.value = def ? def.id : null

  let saved = null
  try {
    saved = await window.shellApi.loadLayout()
  } catch {
    saved = null
  }

  if (saved && saved.tree) {
    if (saved.selectedShell && shells.value.some((s) => s.id === saved.selectedShell)) {
      selectedShell.value = saved.selectedShell
    }
    try {
      const root = await deserializeNode(saved.tree)
      if (root) {
        tree.value = root
        activeId.value = firstLeafId(root)
        broadcast.value = !!saved.broadcast
        return
      }
    } catch {
      /* fall through to a fresh grid if the saved layout can't be rebuilt */
    }
  }
  await buildGrid(3, 2)
}

onMounted(async () => {
  shells.value = await window.shellApi.listShells()
  agents.value = await window.shellApi.listAgents()
  await restoreOrSeedLayout()

  // Persist on any structural / size / title / broadcast change (debounced).
  persistReady = true
  watch([tree, selectedShell, broadcast], scheduleSave, { deep: true })
  // Also capture the initial (seeded or restored) state so an untouched
  // workspace still persists across launches.
  scheduleSave()

  // Hydrate the task board from its own persisted store, then debounce-save on
  // any change. The watch is registered AFTER hydration so loading the saved
  // tasks doesn't immediately trigger a redundant save.
  try {
    const savedTasks = await window.shellApi.taskBoard.load()
    if (Array.isArray(savedTasks)) setTasks(savedTasks)
  } catch {
    /* start with an empty board if persisted tasks can't be read */
  }
  // Drop assignments to panes that didn't survive into this session, then start
  // saving. Reconciling before the watch is registered keeps it from writing the
  // file back on every launch (the cleanup is idempotent and persists on the
  // next real change).
  reconcileTaskPanes()
  watch(boardTasks, scheduleTaskSave, { deep: true })

  window.addEventListener('keydown', onKey)
  window.addEventListener('pointerdown', onDocPointerDown, true)
})

onBeforeUnmount(() => {
  if (taskSaveTimer) clearTimeout(taskSaveTimer)
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('pointerdown', onDocPointerDown, true)
})
</script>

<template>
  <div class="app">
    <div class="toolbar">
      <div class="brand">
        <span class="brand-mark"></span>
        <span class="brand-name">Shell Panels</span>
      </div>

      <div class="toolbar-group menu-group shell-menu-group" @pointerdown.stop>
        <button
          class="menu-trigger shell-trigger"
          :class="{ open: shellMenuOpen }"
          title="Shell for new panes"
          @click="toggleShellMenu"
        >
          <span class="trigger-label">{{ selectedShellName() }}</span>
          <span class="chevron"></span>
        </button>
        <div v-if="shellMenuOpen" class="toolbar-menu shell-menu">
          <button
            v-for="shell in shells"
            :key="shell.id"
            class="toolbar-menu-item"
            :class="{ selected: shell.id === selectedShell }"
            @pointerdown="selectShell(shell.id)"
          >
            {{ shell.name }}
          </button>
        </div>
      </div>

      <div class="toolbar-group">
        <button class="tool-btn" title="Split right (Ctrl+Shift+E)" @click="splitActive('row')">
          <span class="tool-icon">R</span>
          <span>Split</span>
        </button>
        <button class="tool-btn" title="Split down (Ctrl+Shift+O)" @click="splitActive('col')">
          <span class="tool-icon">D</span>
          <span>Split</span>
        </button>
        <button
          class="tool-btn danger"
          title="Close active pane (Ctrl+Shift+W)"
          @click="closeActive"
        >
          <span class="tool-icon">x</span>
          <span>Close</span>
        </button>
      </div>

      <div class="toolbar-group menu-group agent-menu-group" @pointerdown.stop>
        <button
          class="menu-trigger agent-trigger"
          :class="{ open: agentMenuOpen }"
          title="Launch an AI coding agent in a new pane"
          @click="toggleAgentMenu"
        >
          <span>Agent</span>
          <span class="chevron"></span>
        </button>
        <div v-if="agentMenuOpen" class="toolbar-menu agent-menu">
          <button
            v-for="agent in agents"
            :key="agent.id"
            class="toolbar-menu-item agent-item"
            :class="{ unavailable: !agent.available }"
            :disabled="!agent.available"
            :title="
              agent.available
                ? `Launch ${agent.name} (${agent.command}) in a new pane`
                : `${agent.command} was not found on PATH`
            "
            @pointerdown="launchAgent(agent)"
          >
            <span class="agent-swatch" :style="{ background: agent.accent }"></span>
            <span class="agent-item-name">{{ agent.name }}</span>
            <span v-if="!agent.available" class="agent-item-tag">not found</span>
          </button>
        </div>
      </div>

      <div class="toolbar-group menu-group" @pointerdown.stop>
        <button
          class="menu-trigger"
          :class="{ open: gridMenuOpen }"
          title="Arrange into an even grid"
          @click="toggleGridMenu"
        >
          <span>Grid</span>
          <span class="chevron"></span>
        </button>
        <div v-if="gridMenuOpen" class="toolbar-menu grid-menu">
          <button
            v-for="option in gridOptions"
            :key="option.value"
            class="toolbar-menu-item"
            @pointerdown="applyGrid(option.value)"
          >
            {{ option.label }}
          </button>
        </div>
      </div>

      <div class="spacer"></div>

      <button
        class="tool-btn task-btn"
        :class="{ on: taskPanelOpen }"
        title="Toggle the agent task board (Ctrl+Shift+K)"
        @click="toggleTaskPanel"
      >
        <span class="task-btn-icon">▤</span>
        <span>Tasks</span>
      </button>

      <button
        class="tool-btn broadcast-btn"
        :class="{ on: broadcast }"
        title="Multi-write: type once, send to all checked panes (Ctrl+Shift+B)"
        @click="toggleBroadcast"
      >
        <span class="status-dot"></span>
        <span>Broadcast</span>
      </button>
    </div>

    <div v-if="broadcast" class="broadcast-banner">
      MULTI-WRITE ON - keystrokes are sent to every pane with broadcast checked
    </div>

    <div class="workspace">
      <div class="workspace-main">
        <SplitNode v-if="tree" :node="tree" />
        <div v-else class="startup-message">
          {{ initError || 'Starting...' }}
        </div>
      </div>
      <aside v-if="taskPanelOpen" class="task-panel">
        <TaskBoard :agent-panes="agentPanes" />
      </aside>
    </div>
  </div>
</template>
