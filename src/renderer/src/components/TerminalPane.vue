<script setup>
import { ref, reactive, inject, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { getBuffer } from '../ptyStore'

const props = defineProps({
  node: { type: Object, required: true }
})

const ctx = inject('panelCtx')
const hostEl = ref(null)
const exited = ref(false)
const MIN_COLS = 40
const MIN_ROWS = 10

const isActive = computed(() => ctx.activeId.value === props.node.id)
const isMember = computed(() => ctx.broadcast.value && props.node.broadcast)
const isMaximized = computed(() => ctx.maximizedId.value === props.node.id)
const isAgent = computed(() => props.node.kind === 'agent')

// Busy/idle indicator for agent panes: an agent that is actively emitting output
// is "working"; once output has been quiet for a moment it is "idle" — i.e.
// waiting for your input. This is a backend-agnostic heuristic (no TUI parsing).
const agentStatus = ref('idle') // 'busy' | 'idle'
let statusTimer = 0
const IDLE_AFTER_MS = 1400
function markActivity() {
  if (!isAgent.value) return
  agentStatus.value = 'busy'
  if (statusTimer) clearTimeout(statusTimer)
  statusTimer = setTimeout(() => {
    agentStatus.value = 'idle'
  }, IDLE_AFTER_MS)
}

let term = null
let fit = null
let ro = null
let unsubData = null
let unsubExit = null
let lastCols = 0
let lastRows = 0
let fitFrame = 0

// Fit the VIEW synchronously (no requestAnimationFrame — Chromium throttles rAF
// when the window is occluded/unfocused, which would stop panes refitting while
// an overlay sits on top). fit.fit() only changes the terminal when the column
// or row count actually changes, and the host is layout-pinned (inset: 0), so
// this never loops. We do NOT notify the PTY here: that is debounced and
// de-duplicated in notifyPtySize(), so a divider drag can't spray the shell
// with a storm of identical SIGWINCH signals (which garbles bash/readline).
function doFit() {
  if (!term || !fit) return
  try {
    fit.fit()
    notifyPtySize()
  } catch {
    /* element not measurable yet */
  }
}

// Tell the PTY its new size — but only when it really changed, and coalesced so
// a fast drag sends a couple of updates, not hundreds.
function notifyPtySize() {
  if (!term || term.cols < 1 || term.rows < 1) return
  if (term.cols === lastCols && term.rows === lastRows) return
  lastCols = term.cols
  lastRows = term.rows
  window.shellApi.resizePty(props.node.id, term.cols, term.rows)
}

function scheduleFit() {
  doFit()
  if (fitFrame) cancelAnimationFrame(fitFrame)
  fitFrame = requestAnimationFrame(() => {
    fitFrame = 0
    doFit()
  })
}

function publishMinSize() {
  if (!term || !hostEl.value || term.cols < 1 || term.rows < 1) return
  const screen = hostEl.value.querySelector('.xterm-screen')
  if (!screen) return
  const rect = screen.getBoundingClientRect()
  const minWidth = Math.ceil((rect.width / term.cols) * MIN_COLS) + 10
  const minHeight = Math.ceil((rect.height / term.rows) * MIN_ROWS) + 6
  hostEl.value.style.setProperty('--terminal-min-width', `${minWidth}px`)
  hostEl.value.style.setProperty('--terminal-min-height', `${minHeight}px`)
}

function onLayoutChange() {
  scheduleFit()
}

function windowsPtyOptions() {
  if (props.node.backend === 'conpty') {
    return { backend: 'conpty', buildNumber: props.node.windowsBuild }
  }
  return { backend: 'winpty' }
}

function focusTerm() {
  ctx.setActive(props.node.id)
  if (term) term.focus()
}

function copySelection() {
  if (!term) return false
  const sel = term.getSelection()
  if (sel && sel.length) {
    window.shellApi.writeClipboard(sel)
    return true
  }
  return false
}

async function pasteClipboard() {
  const text = await window.shellApi.readClipboard()
  if (text) ctx.routeInput(props.node.id, text)
  if (term) term.focus()
}

// Editable pane title — stored on the node so it survives layout changes and
// is captured by workspace persistence.
const paneTitle = ref(props.node.title || props.node.shellName)
const editingTitle = ref(false)
const titleInputEl = ref(null)

function startEditTitle(e) {
  e.stopPropagation()
  editingTitle.value = true
  nextTick(() => titleInputEl.value && titleInputEl.value.select())
}

function saveTitle() {
  if (!paneTitle.value.trim()) paneTitle.value = props.node.shellName
  props.node.title = paneTitle.value
  editingTitle.value = false
  if (term) term.focus()
}

function cancelEditTitle() {
  editingTitle.value = false
  if (term) term.focus()
}

const ctxMenu = reactive({ visible: false, x: 0, y: 0, hasSelection: false })
const ctxMenuEl = ref(null)

async function onContextMenu(e) {
  e.preventDefault()
  const sel = term ? term.getSelection() : ''
  ctxMenu.hasSelection = sel.length > 0
  ctxMenu.x = e.clientX
  ctxMenu.y = e.clientY
  ctxMenu.visible = true
  await nextTick()
  if (ctxMenuEl.value) {
    const r = ctxMenuEl.value.getBoundingClientRect()
    if (ctxMenu.x + r.width > window.innerWidth) ctxMenu.x = window.innerWidth - r.width - 4
    if (ctxMenu.y + r.height > window.innerHeight) ctxMenu.y = window.innerHeight - r.height - 4
  }
}

function closeCtxMenu() { ctxMenu.visible = false }

async function openMenuAtBtn(e) {
  e.stopPropagation()
  const sel = term ? term.getSelection() : ''
  ctxMenu.hasSelection = sel.length > 0
  const rect = e.currentTarget.getBoundingClientRect()
  ctxMenu.x = rect.left
  ctxMenu.y = rect.bottom + 2
  ctxMenu.visible = true
  await nextTick()
  if (ctxMenuEl.value) {
    const r = ctxMenuEl.value.getBoundingClientRect()
    if (ctxMenu.x + r.width > window.innerWidth) ctxMenu.x = window.innerWidth - r.width - 4
    if (ctxMenu.y + r.height > window.innerHeight) ctxMenu.y = window.innerHeight - r.height - 4
  }
}

function menuCopy() { copySelection(); term && term.clearSelection(); closeCtxMenu() }
function menuPaste() { pasteClipboard(); closeCtxMenu() }

function menuCopyOutput() {
  if (!term) return closeCtxMenu()
  const buf = term.buffer.active
  const lines = []
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '')
  window.shellApi.writeClipboard(lines.join('\n').trimEnd())
  closeCtxMenu()
}

function menuClear() { if (term) term.clear(); closeCtxMenu() }
function menuSplit(dir) { ctx.splitLeaf(props.node.id, dir); closeCtxMenu() }
function menuClose() { ctx.closeLeaf(props.node.id); closeCtxMenu() }

function onDocPointerDownMenu(e) {
  if (ctxMenu.visible && ctxMenuEl.value && !ctxMenuEl.value.contains(e.target)) closeCtxMenu()
}
function onEscapeMenu(e) { if (e.key === 'Escape' && ctxMenu.visible) closeCtxMenu() }

onMounted(() => {
  term = new Terminal({
    fontFamily: 'Cascadia Mono, Consolas, "Courier New", monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
    windowsPty: windowsPtyOptions(),
    theme: {
      background: '#1e1e1e',
      foreground: '#d4d4d4',
      cursor: '#ffffff',
      selectionBackground: '#264f78'
    }
  })
  fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon())
  term.open(hostEl.value)

  // Replay any buffered history (e.g. after this pane was re-parented by a split).
  const history = getBuffer(props.node.id)
  if (history) term.write(history)

  doFit()

  // User input → routed through App (handles broadcast / multi-write).
  term.onData((data) => ctx.routeInput(props.node.id, data))
  // onResize fires only when cols/rows actually change → debounce-notify the PTY.
  term.onResize(() => {
    publishMinSize()
    notifyPtySize()
  })
  notifyPtySize() // sync the PTY to the initial fitted size
  publishMinSize()

  // Selecting text copies it; Ctrl+Shift+C / Ctrl+Shift+V copy & paste.
  term.onSelectionChange(() => copySelection())
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && e.ctrlKey && e.shiftKey) {
      const k = e.key.toLowerCase()
      if (k === 'c') {
        copySelection()
        return false
      }
      if (k === 'v') {
        pasteClipboard()
        return false
      }
    }
    return true
  })

  // Live output for this pane only.
  unsubData = window.shellApi.onData(({ id, data }) => {
    if (id === props.node.id && term) {
      term.write(data)
      markActivity()
    }
  })
  unsubExit = window.shellApi.onExit(({ id, exitCode }) => {
    if (id === props.node.id && term) {
      exited.value = true
      term.write(`\r\n\x1b[33m[process exited — code ${exitCode}. Close this pane.]\x1b[0m\r\n`)
    }
  })

  // Refit whenever the pane is resized (divider drag, window resize, splits).
  ro = new ResizeObserver(() => scheduleFit())
  ro.observe(hostEl.value)
  ro.observe(hostEl.value.parentElement)
  window.addEventListener('resize', onLayoutChange)
  window.addEventListener('terminal-layout-change', onLayoutChange)
  window.addEventListener('pointerdown', onDocPointerDownMenu, true)
  window.addEventListener('keydown', onEscapeMenu)

  if (isActive.value) term.focus()
})

watch(isActive, (a) => {
  if (a && term) term.focus()
})

watch(isMaximized, () => {
  nextTick(() => scheduleFit())
})

onBeforeUnmount(() => {
  if (ro) ro.disconnect()
  if (fitFrame) cancelAnimationFrame(fitFrame)
  if (statusTimer) clearTimeout(statusTimer)
  window.removeEventListener('resize', onLayoutChange)
  window.removeEventListener('terminal-layout-change', onLayoutChange)
  window.removeEventListener('pointerdown', onDocPointerDownMenu, true)
  window.removeEventListener('keydown', onEscapeMenu)
  if (unsubData) unsubData()
  if (unsubExit) unsubExit()
  if (term) term.dispose()
  term = null
  // NOTE: the PTY is intentionally NOT killed here — the pane may merely be
  // re-mounting after a layout change. App.closeLeaf() owns PTY termination.
})
</script>

<template>
  <div
    class="pane"
    :class="{ active: isActive, 'broadcast-member': isMember, maximized: isMaximized }"
    @mousedown="focusTerm"
    @contextmenu="onContextMenu"
  >
    <div
      class="pane-nav"
      :class="{ agent: isAgent }"
      :style="isAgent ? { boxShadow: `inset 0 2px 0 ${node.accent}` } : null"
      @mousedown.stop="focusTerm"
    >
      <div class="pane-nav-left">
        <div
          class="pane-tab"
          :class="{ agent: isAgent }"
          :style="isAgent ? { borderColor: node.accent } : null"
          title="Double-click to rename"
          @dblclick="startEditTitle"
        >
          <span class="pane-tab-prompt" :style="isAgent ? { color: node.accent } : null">{{
            isAgent ? '◆' : '>_'
          }}</span>
          <input
            v-if="editingTitle"
            ref="titleInputEl"
            v-model="paneTitle"
            class="pane-tab-input"
            @blur="saveTitle"
            @keydown.enter.prevent="saveTitle"
            @keydown.escape.prevent="cancelEditTitle"
            @mousedown.stop
            @click.stop
          />
          <span v-else class="pane-tab-name">{{ paneTitle }}</span>
        </div>
        <span
          v-if="isAgent"
          class="agent-status"
          :class="agentStatus"
          :style="{ '--accent': node.accent }"
          :title="agentStatus === 'busy' ? 'Agent is working' : 'Agent is idle — waiting for input'"
        >
          <span class="agent-status-dot"></span>
          {{ agentStatus === 'busy' ? 'Working' : 'Idle' }}
        </span>
      </div>
      <div class="pane-nav-actions" @mousedown.stop>
        <label
          v-if="ctx.broadcast.value"
          class="bc-toggle"
          :class="{ member: node.broadcast }"
          title="Include this pane in multi-write"
        >
          <input v-model="node.broadcast" type="checkbox" />
          write
        </label>
        <!-- ellipsis / more options -->
        <button class="pane-nav-btn" title="More options" @click="openMenuAtBtn">
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="3" cy="8" r="1.4" fill="currentColor"/>
            <circle cx="8" cy="8" r="1.4" fill="currentColor"/>
            <circle cx="13" cy="8" r="1.4" fill="currentColor"/>
          </svg>
        </button>
        <!-- split right -->
        <button class="pane-nav-btn" title="Split right (Ctrl+Shift+E)" @click="ctx.splitLeaf(node.id, 'row')">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="1" y="2" width="6" height="12" rx="0.8" stroke="currentColor" stroke-width="1.4"/>
            <rect x="9" y="2" width="6" height="12" rx="0.8" stroke="currentColor" stroke-width="1.4"/>
          </svg>
        </button>
        <!-- split down -->
        <button class="pane-nav-btn" title="Split down (Ctrl+Shift+O)" @click="ctx.splitLeaf(node.id, 'col')">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="2" y="1" width="12" height="6" rx="0.8" stroke="currentColor" stroke-width="1.4"/>
            <rect x="2" y="9" width="12" height="6" rx="0.8" stroke="currentColor" stroke-width="1.4"/>
          </svg>
        </button>
        <!-- maximize / restore -->
        <button class="pane-nav-btn" :title="isMaximized ? 'Restore pane' : 'Maximize pane'" @click="ctx.toggleMaximize(node.id)">
          <svg v-if="isMaximized" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M6 2v4H2M14 6h-4V2M10 14v-4h4M2 10h4v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <svg v-else width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <!-- close -->
        <button class="pane-nav-btn close" title="Close pane (Ctrl+Shift+W)" @click="ctx.closeLeaf(node.id)">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <line x1="3.5" y1="3.5" x2="12.5" y2="12.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
            <line x1="12.5" y1="3.5" x2="3.5" y2="12.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
    </div>

    <div ref="hostEl" class="term-host"></div>
  </div>

  <Teleport to="body">
    <div
      v-if="ctxMenu.visible"
      ref="ctxMenuEl"
      class="ctx-menu"
      :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
      @mousedown.stop
    >
      <div class="ctx-menu-header">
        <span class="ctx-menu-title">{{ paneTitle }}</span>
        <span class="ctx-menu-subtitle">{{ node.shellName }}</span>
      </div>
      <div class="ctx-menu-sep"></div>
      <button class="ctx-menu-item" :disabled="!ctxMenu.hasSelection" @click="menuCopy">Copy</button>
      <button class="ctx-menu-item" @click="menuPaste">Paste</button>
      <div class="ctx-menu-sep"></div>
      <button class="ctx-menu-item" @click="menuCopyOutput">Copy output</button>
      <button class="ctx-menu-item" @click="menuClear">Clear</button>
      <div class="ctx-menu-sep"></div>
      <button class="ctx-menu-item" @click="menuSplit('row')">
        Split right<span class="ctx-menu-shortcut">▥</span>
      </button>
      <button class="ctx-menu-item" @click="menuSplit('col')">
        Split down<span class="ctx-menu-shortcut">▤</span>
      </button>
      <div class="ctx-menu-sep"></div>
      <button class="ctx-menu-item danger" @click="menuClose">Close pane</button>
    </div>
  </Teleport>
</template>
