<script setup>
// Left sidebar: what needs you, then the workspaces, each with its agents.
// A workspace is a project: its folder, its panes and the agents working in
// it together. The sidebar only renders and emits intents: App owns the state.
import { ref, nextTick } from 'vue'
import BrandIcon from './BrandIcon.vue'

const props = defineProps({
  // [{ id, name, paneCount, agents: [agentId...], members: [{ id, num, title,
  //   agentId, accent, state, reset, held, active }], busy, needsYou, folder, cwd }]
  items: { type: Array, required: true },
  currentId: { type: String, default: null },
  collapsed: { type: Boolean, default: false },
  width: { type: Number, default: 216 },
  // "Needs you": [{ paneId, title, agentId, accent, kind: 'approval' | 'done'
  //   | 'limited', text }]
  inbox: { type: Array, default: () => [] },
  // Every pane of the current workspace, for "Sessions": [{ id, num, title,
  //   kind, agentId, shellId, accent, state, reset, held, active }]
  sessions: { type: Array, default: () => [] }
})

const emit = defineEmits([
  'focus-pane',
  'message-ws',
  'notes-ws',
  'folder',
  'select',
  'create',
  'rename',
  'remove',
  'toggle',
  'resize',
  'resize-end'
])

// --- Drag the right edge to resize -------------------------------------------
const MIN_WIDTH = 160
const MAX_WIDTH = 480
const DEFAULT_WIDTH = 216
const COLLAPSE_BELOW = 110 // dragging this far left collapses the sidebar
const navEl = ref(null)
const resizing = ref(false)

// Double-click detection lives here: preventDefault on pointerdown (needed so a
// drag doesn't select text) suppresses the browser's own dblclick event.
let lastDown = 0

function startResize(e) {
  if (e.button !== 0) return
  e.preventDefault()
  const now = Date.now()
  if (now - lastDown < 400) {
    lastDown = 0
    resetWidth()
    return
  }
  lastDown = now
  const left = navEl.value ? navEl.value.getBoundingClientRect().left : 0
  resizing.value = true
  document.body.classList.add('ws-resizing')
  let wantsCollapse = false
  const startWidth = props.width

  const move = (ev) => {
    const raw = ev.clientX - left
    if (props.collapsed) {
      // Dragging out of the collapsed rail re-expands it.
      if (raw > COLLAPSE_BELOW) emit('toggle')
      return
    }
    wantsCollapse = raw < COLLAPSE_BELOW
    const w = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, raw)))
    emit('resize', w)
  }
  const up = () => {
    resizing.value = false
    document.body.classList.remove('ws-resizing')
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    if (wantsCollapse && !props.collapsed) {
      // Collapse, but remember the width it had before this drag.
      emit('resize', startWidth)
      emit('toggle')
    }
    emit('resize-end')
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

function resetWidth() {
  if (props.collapsed) emit('toggle')
  emit('resize', DEFAULT_WIDTH)
  emit('resize-end')
}

const editingId = ref(null)
const draft = ref('')
const inputEls = {}

function startRename(item) {
  editingId.value = item.id
  draft.value = item.name
  nextTick(() => {
    const el = inputEls[item.id]
    if (el) el.select()
  })
}

function commitRename() {
  if (!editingId.value) return
  const name = draft.value.trim()
  if (name) emit('rename', editingId.value, name)
  editingId.value = null
}

function cancelRename() {
  editingId.value = null
}

function initials(name) {
  const words = (name || '?').trim().split(/\s+/)
  const s = words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)
  return s.toUpperCase()
}

// Distinct agent kinds in a workspace, for the little logo row.
function uniqueAgents(list) {
  return [...new Set(list)].slice(0, 4)
}

const STATE_TEXT = {
  approval: 'Asks your approval',
  limited: 'Usage limit',
  working: 'Working',
  waiting: 'Done, waiting for you',
  ready: 'Ready'
}

function stateText(m) {
  if (m.kind && m.kind !== 'agent') return 'Terminal'
  if (m.held) return 'Message waits for your approval'
  if (m.state === 'limited' && m.reset) return `Usage limit · ${m.reset}`
  return STATE_TEXT[m.state]
}

const INBOX_ACTION = { approval: 'Show', done: 'Show', limited: 'Show' }

// --- One message to every agent of a workspace -------------------------------
const messagingId = ref(null)
const messageDraft = ref('')
const messageEls = {}

function startMessage(wsId) {
  messagingId.value = messagingId.value === wsId ? null : wsId
  messageDraft.value = ''
  nextTick(() => {
    const el = messageEls[wsId]
    if (el) el.focus()
  })
}

function sendMessage() {
  const text = messageDraft.value.trim()
  if (text) emit('message-ws', messagingId.value, text)
  messagingId.value = null
  messageDraft.value = ''
}

defineExpose({
  startRename: (id) => {
    const item = props.items.find((i) => i.id === id)
    if (item) startRename(item)
  },
  startMessage: (wsId) => {
    if (messagingId.value !== wsId) startMessage(wsId)
  }
})
</script>

<template>
  <nav
    ref="navEl"
    class="ws-sidebar"
    :class="{ collapsed, resizing }"
    :style="collapsed ? null : { flexBasis: width + 'px' }"
    aria-label="Workspaces"
  >
    <div class="ws-head">
      <span v-if="!collapsed" class="ws-head-title">Workspaces</span>
      <button
        v-if="!collapsed"
        class="ws-icon-btn ws-head-new"
        title="New workspace (Ctrl+Shift+N)"
        aria-label="New workspace"
        @click="emit('create')"
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </svg>
      </button>
      <button
        class="ws-icon-btn"
        :title="collapsed ? 'Expand sidebar' : 'Collapse sidebar'"
        @click="emit('toggle')"
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect
            x="1.5"
            y="2.5"
            width="13"
            height="11"
            rx="2"
            stroke="currentColor"
            stroke-width="1.3"
          />
          <path d="M6 2.5v11" stroke="currentColor" stroke-width="1.3" />
          <path
            :d="collapsed ? 'M9 6.5l1.6 1.5L9 9.5' : 'M10.6 6.5L9 8l1.6 1.5'"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
    </div>

    <section v-if="!collapsed && inbox.length" class="ws-inbox" aria-label="Needs you">
      <div class="ws-inbox-head">
        <span class="ws-inbox-title">Needs you</span>
        <span class="ws-inbox-count">{{ inbox.length }}</span>
      </div>
      <div
        v-for="n in inbox"
        :key="n.paneId + n.kind"
        class="ws-inbox-item"
        :class="n.kind"
      >
        <BrandIcon :kind="n.agentId" :accent="n.accent" :label="n.title" :size="14" />
        <span class="ws-inbox-body">
          <span class="ws-inbox-name">{{ n.title }}</span>
          <span class="ws-inbox-text">{{ n.text }}</span>
        </span>
        <button class="ws-inbox-btn" @click="emit('focus-pane', n.paneId)">
          {{ INBOX_ACTION[n.kind] }}
        </button>
      </div>
    </section>

    <div class="ws-list">
      <template v-for="item in items" :key="item.id">
        <div
          class="ws-item"
          :class="{ current: item.id === currentId }"
          :data-ws-id="item.id"
          :title="collapsed ? item.name : 'Double-click to rename'"
          role="button"
          tabindex="0"
          @click="emit('select', item.id)"
          @keydown.enter="emit('select', item.id)"
          @dblclick="!collapsed && startRename(item)"
        >
          <span class="ws-badge">
            {{ initials(item.name) }}
            <span
              v-if="item.needsYou"
              class="ws-busy attention"
              title="An agent is waiting for you"
            ></span>
            <span v-else-if="item.busy" class="ws-busy" title="An agent is working"></span>
          </span>

          <template v-if="!collapsed">
            <div class="ws-body">
              <input
                v-if="editingId === item.id"
                :ref="(el) => (inputEls[item.id] = el)"
                v-model="draft"
                class="ws-input"
                @click.stop
                @dblclick.stop
                @blur="commitRename"
                @keydown.enter.prevent.stop="commitRename"
                @keydown.escape.prevent.stop="cancelRename"
              />
              <span v-else class="ws-name">{{ item.name }}</span>
              <span class="ws-meta">
                <BrandIcon v-for="a in uniqueAgents(item.agents)" :key="a" :kind="a" :size="11" />
                <span>{{ item.paneCount }} {{ item.paneCount === 1 ? 'pane' : 'panes' }}</span>
              </span>
              <span v-if="item.folder" class="ws-folder" :title="item.cwd">
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3l1.5 1.6H13c.7 0 1.2.5 1.2 1.2v6.3c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2V4.2z"
                    stroke="currentColor"
                    stroke-width="1.3"
                    stroke-linejoin="round"
                  />
                </svg>
                {{ item.folder }}
              </span>
            </div>

            <div class="ws-actions">
              <button class="ws-icon-btn small" title="Rename" @click.stop="startRename(item)">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M10.5 2.5l3 3L6 13H3v-3l7.5-7.5z"
                    stroke="currentColor"
                    stroke-width="1.4"
                    stroke-linejoin="round"
                  />
                </svg>
              </button>
              <button
                class="ws-icon-btn small"
                :title="
                  item.cwd
                    ? `Project folder: ${item.cwd} (click to change)`
                    : 'Set a project folder: new panes start there'
                "
                @click.stop="emit('folder', item.id)"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3l1.5 1.6H13c.7 0 1.2.5 1.2 1.2v6.3c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2V4.2z"
                    stroke="currentColor"
                    stroke-width="1.4"
                    stroke-linejoin="round"
                  />
                </svg>
              </button>
              <button
                class="ws-icon-btn small danger"
                title="Delete workspace"
                @click.stop="emit('remove', item.id)"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M4 4l8 8M12 4l-8 8"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                  />
                </svg>
              </button>
            </div>
          </template>
        </div>

      </template>
    </div>

    <button
      v-if="collapsed"
      class="ws-new"
      title="New workspace (Ctrl+Shift+N)"
      aria-label="New workspace"
      @click="emit('create')"
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      </svg>
    </button>

    <!-- The current workspace's panes: agents and shells, with their state. -->
    <section v-if="!collapsed && sessions.length" class="ws-sessions" aria-label="Sessions">
      <div class="ws-head">
        <span class="ws-head-title">Sessions</span>
        <span class="ws-sessions-count">{{ sessions.length }}</span>
      </div>
      <button
        v-for="s in sessions"
        :key="s.id"
        class="ws-session"
        :class="[s.state, { active: s.active }]"
        :title="`Go to pane ${s.num || ''}`"
        @click="emit('focus-pane', s.id)"
      >
        <BrandIcon
          :kind="s.kind === 'agent' ? s.agentId : s.shellId"
          :accent="s.kind === 'agent' ? s.accent : null"
          :label="s.kind === 'agent' ? s.title : null"
          :size="14"
        />
        <span class="ws-session-body">
          <span class="ws-session-name">{{ s.title }}</span>
          <span class="ws-session-state">{{ stateText(s) }}</span>
        </span>
        <span class="ws-session-num">{{ s.num }}</span>
      </button>
      <div v-if="sessions.some((s) => s.kind === 'agent')" class="ws-agents-actions">
        <button
          class="ws-agents-btn"
          :class="{ on: messagingId === currentId }"
          title="One message, sent to each agent of this workspace (never to plain shells)"
          @click="startMessage(currentId)"
        >
          Message all
        </button>
        <button
          class="ws-agents-btn"
          title="A shared notes file for the agents of this workspace"
          @click="emit('notes-ws', currentId)"
        >
          Project notes
        </button>
      </div>
      <div v-if="messagingId === currentId" class="ws-message">
        <textarea
          :ref="(el) => (messageEls[currentId] = el)"
          v-model="messageDraft"
          rows="3"
          placeholder="Message every agent of this workspace… (Enter to send, Shift+Enter for a new line)"
          @keydown.enter.exact.prevent="sendMessage"
          @keydown.escape.prevent.stop="messagingId = null"
        ></textarea>
        <div class="ws-message-actions">
          <button class="ws-message-cancel" @click="messagingId = null">Cancel</button>
          <button class="ws-message-send" :disabled="!messageDraft.trim()" @click="sendMessage">
            Send
          </button>
        </div>
      </div>
    </section>

    <div
      class="ws-resize"
      title="Drag to resize. Double-click to reset."
      @pointerdown="startResize"
    ></div>
  </nav>
</template>
